---
title: "异常安全编程：RAII与三种保证级别的工程实践"
categories: [C++语言]
location: 西安
---

### 引言

"这代码能处理异常吗？"——面对这个Code Review中的灵魂问题，很多人的回答是"加个try-catch就行了吧？" 但异常安全远不止catch那么简单。

我曾审查过一个数据库连接池的实现，表面上所有异常都被catch了，但在异常路径中，连接计数器没有正确恢复，导致连接池慢慢"漏空"。这就是典型的异常安全问题——代码在异常抛出后，对象处于不一致状态。

本文系统讲解C++异常安全的三个保证级别，RAII如何成为异常安全的基石，以及工程实践中如何编写满足Strong保证的代码。

---

### 1. 异常安全三个级别

```
异常安全保证级别（从弱到强）：

  ┌─────────────────────────────────────────────────────────────┐
  │  Nothrow 保证（不抛出）                                      │
  │  "此操作永远不会抛出异常"                                     │
  │  例：析构函数、swap、移动操作                                  │
  │  标记：noexcept                                              │
  ├─────────────────────────────────────────────────────────────┤
  │  Strong 保证（强保证 / 事务性）                               │
  │  "如果操作失败（抛异常），程序状态回到操作前"                   │
  │  要么完全成功，要么完全不变——类似数据库事务                     │
  │  例：vector::push_back (当发生realloc时)                     │
  ├─────────────────────────────────────────────────────────────┤
  │  Basic 保证（基本保证）                                       │
  │  "如果操作失败，对象仍处于有效状态（不泄漏资源）"               │
  │  但对象的值可能已改变（不保证回到原值）                         │
  │  例：大多数STL操作的最低保证                                   │
  ├─────────────────────────────────────────────────────────────┤
  │  ❌ 无保证                                                    │
  │  "异常后对象状态未定义，可能资源泄漏"                           │
  │  这是BUG，不是合理的设计选择                                   │
  └─────────────────────────────────────────────────────────────┘
```

**实际工程中的选择**：

| 级别 | 适用场景 | 成本 |
|------|---------|------|
| Nothrow | 析构、swap、move、底层原语 | 限制实现方式 |
| Strong | 对外API、关键业务操作 | 可能需要复制+交换 |
| Basic | 内部实现、性能敏感路径 | 最低（仅保证不泄漏） |
| 无保证 | ❌ 不应该存在 | — |

---

### 2. RAII：异常安全的基石

RAII（Resource Acquisition Is Initialization）不只是"构造时获取、析构时释放"，它是C++实现异常安全的核心机制。

**为什么RAII能保证异常安全？**

```
栈展开（Stack Unwinding）机制：

  void foo() {
      ResourceGuard a;   // ① 构造
      ResourceGuard b;   // ② 构造
      riskyOperation();  // ③ 抛出异常！
      ResourceGuard c;   // ④ 不会执行
  }

  异常抛出后，编译器自动按逆序析构已构造的局部对象：
  ③ 异常抛出
  → ~b() 调用  (自动)
  → ~a() 调用  (自动)
  → 异常继续传播

  关键：❌ c永远不会构造，✅ a和b一定会析构
```

#### RAII 实战模式

```cpp
// 模式1：锁守卫
{
    std::lock_guard<std::mutex> lock(mtx_);  // 构造时加锁
    riskyOperation();
    // 无论正常返回还是异常，析构时自动解锁
}

// 模式2：文件句柄
{
    std::ofstream file("data.txt");  // 构造时打开
    file << computeData();           // 可能抛异常
    // 析构时自动关闭文件
}

// 模式3：数据库事务
class TransactionGuard {
    Database& db_;
    bool committed_ = false;
public:
    TransactionGuard(Database& db) : db_(db) {
        db_.beginTransaction();
    }
    void commit() {
        db_.commit();
        committed_ = true;
    }
    ~TransactionGuard() {
        if (!committed_) {
            db_.rollback();  // 异常时自动回滚
        }
    }
};

void transferMoney(Database& db, int from, int to, double amount) {
    TransactionGuard txn(db);
    
    db.execute("UPDATE accounts SET balance = balance - ? WHERE id = ?", amount, from);
    db.execute("UPDATE accounts SET balance = balance + ? WHERE id = ?", amount, to);
    
    txn.commit();  // 只有两条SQL都成功才提交
    // 如果任何一条抛异常 → TransactionGuard析构 → 自动rollback
}
```

---

### 3. Copy-and-Swap 惯用法：实现 Strong 保证

**问题**：赋值操作符如何提供Strong保证？

```cpp
// ❌ 非异常安全的赋值
class DynamicArray {
    int* data_;
    size_t size_;
public:
    DynamicArray& operator=(const DynamicArray& other) {
        delete[] data_;              // ① 先释放旧数据
        data_ = new int[other.size_]; // ② 分配新内存（可能抛bad_alloc！）
        // 💀 如果②抛异常：data_已被delete，对象处于无效状态！
        std::copy(other.data_, other.data_ + other.size_, data_);
        size_ = other.size_;
        return *this;
    }
};
```

**Copy-and-Swap解决方案**：

```cpp
class DynamicArray {
    int* data_;
    size_t size_;
public:
    // 构造函数（可以抛异常）
    DynamicArray(size_t size) : data_(new int[size]{}), size_(size) {}
    
    // 拷贝构造（可以抛异常，在新对象上操作，不影响已有对象）
    DynamicArray(const DynamicArray& other)
        : data_(new int[other.size_]), size_(other.size_) {
        std::copy(other.data_, other.data_ + other.size_, data_);
    }
    
    // 移动构造（noexcept）
    DynamicArray(DynamicArray&& other) noexcept
        : data_(other.data_), size_(other.size_) {
        other.data_ = nullptr;
        other.size_ = 0;
    }
    
    // Swap（noexcept —— 关键！）
    friend void swap(DynamicArray& a, DynamicArray& b) noexcept {
        using std::swap;
        swap(a.data_, b.data_);
        swap(a.size_, b.size_);
    }
    
    // 赋值操作符：Copy-and-Swap
    DynamicArray& operator=(DynamicArray other) {  // 注意：值传递（触发拷贝构造）
        swap(*this, other);  // noexcept交换
        return *this;
        // other析构，释放原来this的数据
    }
    
    ~DynamicArray() { delete[] data_; }
};
```

**为什么这是Strong保证？**

```
执行流程分析：

  DynamicArray a = ..., b = ...;
  a = b;  // 调用 operator=(DynamicArray other)

  ① other = 拷贝构造(b)   ← 可能抛异常（new失败）
     如果失败：a完全未被修改 ← Strong保证！

  ② swap(*this, other)    ← noexcept，不会失败
     a获得了b的副本，other获得了a的旧数据

  ③ other析构             ← 释放a的旧数据

  关键：所有可能失败的操作（内存分配）在修改this之前完成。
  一旦进入swap，就不会再失败。
```

---

### 4. STL 容器的异常安全承诺

#### vector::push_back 的秘密

```cpp
// vector::push_back 提供 Strong 保证，但代价是什么？
std::vector<Widget> v;
v.push_back(Widget(...));
```

当vector需要扩容时：

```
扩容流程（元素类型有 noexcept move 时）：

  旧内存: [W1][W2][W3]          新内存: [  ][  ][  ][  ]

  1. 分配新内存                  → 可能抛bad_alloc（Strong：旧数据不变）
  2. move旧元素到新内存           → noexcept（不会失败）
     [W1][W2][W3]  →move→       [W1][W2][W3][  ]
  3. 构造新元素                  → 可能抛异常
     如果失败：destroy已move的，释放新内存，旧数据...已经被move走了？

  等等！如果move不是noexcept，失败后无法恢复旧数据！
```

**这就是为什么`noexcept`对移动操作如此重要**：

```cpp
class Widget {
public:
    // ✅ 标记noexcept → vector扩容时使用move（快）
    Widget(Widget&& other) noexcept;
    
    // ❌ 不标记noexcept → vector扩容时被迫使用copy（慢，但安全）
    // Widget(Widget&& other);  // 编译器不知道是否会抛异常
};
```

| 移动构造是否noexcept | vector扩容策略 | 性能 | 异常安全 |
|---------------------|---------------|------|---------|
| ✅ noexcept | move元素 | 快 | Strong |
| ❌ 不是 | copy元素 | 慢 | Strong |
| ❌ 不是且无拷贝 | move元素 | 快 | ⚠️ Basic |

**规则：移动构造和移动赋值尽量标记`noexcept`。**

---

### 5. noexcept 的正确使用

#### 应该标记noexcept的场景

```cpp
// 1. 析构函数（默认就是noexcept，除非显式声明noexcept(false)）
~MyClass() noexcept;  // 实际上多余，析构默认noexcept

// 2. 移动操作
MyClass(MyClass&&) noexcept;
MyClass& operator=(MyClass&&) noexcept;

// 3. swap
friend void swap(MyClass& a, MyClass& b) noexcept;

// 4. 简单的getter、计算函数
int size() const noexcept { return size_; }
bool empty() const noexcept { return size_ == 0; }

// 5. 不分配内存、不调用可能抛异常的函数
void clear() noexcept {
    size_ = 0;
    // 不释放内存，只清零计数
}
```

#### 不应该标记noexcept的场景

```cpp
// 1. 分配内存的操作（new可能抛bad_alloc）
void push_back(const T& val);  // 可能需要扩容

// 2. 调用用户提供的回调
template<typename F>
void forEach(F&& func);  // func可能抛异常

// 3. 获取锁（可能死锁检测抛异常）
void lock();  // 不要标记noexcept
```

#### noexcept的性能影响

```cpp
// noexcept影响编译器优化
void foo() noexcept {
    // 编译器知道这里不会有异常传播
    // → 不需要生成栈展开信息
    // → 代码更紧凑，分支预测更好
}

void bar() {
    // 编译器必须生成异常处理表
    // → .eh_frame 段增大
    // → 可能影响指令缓存
}
```

性能差异实测：

| 场景 | noexcept | 不标记 | 差异 |
|------|---------|--------|------|
| 简单函数调用 | ~0% | ~0% | 几乎无差 |
| vector扩容(move) | 基准 | 慢2-3倍(fallback到copy) | **显著** |
| 高频循环内小函数 | 基准 | 慢5-10% | 指令缓存 |

---

### 6. 实战：异常安全的连接池

将前面的知识综合运用到一个真实场景：

```cpp
#include <queue>
#include <mutex>
#include <condition_variable>
#include <memory>
#include <functional>
#include <chrono>
#include <stdexcept>

// 连接接口
class Connection {
public:
    virtual ~Connection() = default;
    virtual bool isAlive() = 0;
    virtual void reset() = 0;
};

// RAII连接守卫：确保连接一定归还
class ConnectionPool;
class PooledConnection {
public:
    PooledConnection(std::unique_ptr<Connection> conn, ConnectionPool* pool)
        : conn_(std::move(conn)), pool_(pool) {}
    
    // 禁止拷贝
    PooledConnection(const PooledConnection&) = delete;
    PooledConnection& operator=(const PooledConnection&) = delete;
    
    // 允许移动
    PooledConnection(PooledConnection&& other) noexcept
        : conn_(std::move(other.conn_)), pool_(other.pool_) {
        other.pool_ = nullptr;
    }
    
    ~PooledConnection() {
        if (conn_ && pool_) {
            pool_->returnConnection(std::move(conn_));  // noexcept
        }
    }
    
    Connection* operator->() { return conn_.get(); }
    Connection& operator*() { return *conn_; }
    explicit operator bool() const { return conn_ != nullptr; }

private:
    std::unique_ptr<Connection> conn_;
    ConnectionPool* pool_;
};

// 异常安全的连接池
class ConnectionPool {
public:
    using Factory = std::function<std::unique_ptr<Connection>()>;
    
    ConnectionPool(Factory factory, size_t max_size)
        : factory_(std::move(factory)), max_size_(max_size) {}
    
    // 获取连接（Strong保证：要么成功获取，要么状态不变）
    PooledConnection acquire(std::chrono::milliseconds timeout = std::chrono::milliseconds(5000)) {
        std::unique_lock<std::mutex> lock(mtx_);
        
        // 等待可用连接
        bool available = cv_.wait_for(lock, timeout, [this] {
            return !idle_.empty() || active_count_ < max_size_;
        });
        
        if (!available) {
            throw std::runtime_error("Connection pool timeout");
        }
        
        std::unique_ptr<Connection> conn;
        
        if (!idle_.empty()) {
            // 从空闲池取
            conn = std::move(idle_.front());
            idle_.pop();
            
            // 验证连接有效性
            if (!conn->isAlive()) {
                // 连接失效，尝试新建（不计入active，因为旧的已废弃）
                conn.reset();  // 释放无效连接
                conn = createConnection(lock);  // 可能抛异常
            }
        } else {
            // 新建连接
            conn = createConnection(lock);  // 可能抛异常
        }
        
        // 到这里，conn一定有效
        // 增加活跃计数（这步不会抛异常）
        active_count_++;
        
        // 返回RAII守卫（移动语义，noexcept）
        return PooledConnection(std::move(conn), this);
    }
    
    // 归还连接（Nothrow保证：析构函数中调用，绝不能抛异常）
    void returnConnection(std::unique_ptr<Connection> conn) noexcept {
        std::lock_guard<std::mutex> lock(mtx_);
        active_count_--;
        
        try {
            conn->reset();  // 重置连接状态
            idle_.push(std::move(conn));
        } catch (...) {
            // reset失败：丢弃连接（不放回池）
            // conn在unique_ptr析构时自动释放
        }
        
        cv_.notify_one();
    }
    
    // 状态查询（Nothrow）
    size_t activeCount() const noexcept {
        std::lock_guard<std::mutex> lock(mtx_);
        return active_count_;
    }
    
    size_t idleCount() const noexcept {
        std::lock_guard<std::mutex> lock(mtx_);
        return idle_.size();
    }

private:
    // 创建新连接（可能抛异常，但不修改池状态）
    std::unique_ptr<Connection> createConnection(std::unique_lock<std::mutex>& lock) {
        lock.unlock();  // 释放锁，创建连接可能耗时
        
        std::unique_ptr<Connection> conn;
        try {
            conn = factory_();  // 可能抛异常（网络不通等）
        } catch (...) {
            lock.lock();  // 重新加锁
            throw;        // 重新抛出，Strong保证：池状态未变
        }
        
        lock.lock();
        return conn;
    }
    
    Factory factory_;
    size_t max_size_;
    size_t active_count_ = 0;
    std::queue<std::unique_ptr<Connection>> idle_;
    mutable std::mutex mtx_;
    std::condition_variable cv_;
};
```

**异常安全分析**：

| 操作 | 保证级别 | 分析 |
|------|---------|------|
| `acquire()` | Strong | 如果create失败，active_count_未增加，池状态不变 |
| `returnConnection()` | Nothrow | 在析构函数中调用，catch所有异常 |
| `PooledConnection析构` | Nothrow | 自动归还连接，不抛异常 |
| `PooledConnection移动` | Nothrow | 指针交换，不分配内存 |

---

### 7. 异常安全检查清单

在Code Review中检查以下要点：

```
异常安全审计要点：

  □ 析构函数是否noexcept？（默认是，但有没有意外调用throw的代码？）
  □ 移动构造/赋值是否noexcept？（影响vector性能）
  □ swap是否noexcept？（Copy-and-Swap的前提）
  □ 资源获取是否用RAII？（裸new/delete → 用unique_ptr）
  □ 锁操作是否用lock_guard？（手动lock/unlock → 异常时死锁）
  □ 多步操作是否"先做可能失败的，再做不会失败的"？
  □ catch(...)中是否处理了资源清理？
  □ 构造函数失败时，已构造的成员是否自动清理？（是的，RAII保证）
```

**"先做可能失败的"原则**：

```cpp
// ❌ 先修改状态，再做可能失败的操作
void addItem(Item item) {
    size_++;                    // 先修改了状态
    data_[size_-1] = item;     // 如果拷贝抛异常？size_已经++了！
}

// ✅ 先做可能失败的操作，最后修改状态
void addItem(Item item) {
    ensureCapacity(size_ + 1);  // 可能抛异常（扩容失败），但size_未变
    data_[size_] = item;        // 可能抛异常（拷贝失败），但size_未变
    size_++;                    // 不会抛异常，最后才修改状态
}
```

---

### 总结

异常安全编程的核心要点：

1. **RAII是基础**：所有资源（内存、锁、连接、文件）都用RAII管理，栈展开自动清理
2. **noexcept标记关键操作**：析构、移动、swap必须noexcept，影响容器性能和正确性
3. **Copy-and-Swap提供Strong保证**：先在副本上操作，成功后noexcept交换
4. **"先做可能失败的"**：把所有可能抛异常的操作放在修改状态之前
5. **Basic保证是最低要求**：任何代码路径（包括异常路径）都不能泄漏资源或留下不一致状态
6. **测试异常路径**：用mock让关键操作抛异常，验证对象状态是否一致

异常安全不是"锦上添花"，而是"正确性的组成部分"。一个不异常安全的类，等于在告诉使用者"在任何调用失败后，请不要再使用这个对象"——这在生产系统中是不可接受的。
