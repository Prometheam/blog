---
title: "设计模式详解：单例模式（Singleton）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 单例模式

一、核心思想

  确保一个类只有一个实例，并提供一个全局访问点来获取该实例。

  传统方式：随意 new 出多个对象，资源浪费且状态不一致
  单例模式：全局唯一实例，集中管理共享资源

---
  二、模式结构

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                       Singleton                                  │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ - static instance: Singleton*   // 唯一实例              │   │
  │  │ - Singleton()                   // 私有构造函数          │   │
  │  │ - Singleton(const Singleton&) = delete                   │   │
  │  │ - operator=(const Singleton&) = delete                   │   │
  │  │                                                          │   │
  │  │ + static getInstance(): Singleton&  // 全局访问点        │   │
  │  │ + businessMethod()                  // 业务方法          │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘

  关键约束：
  1. 构造函数私有 → 外部不能 new
  2. 拷贝/赋值删除 → 不能复制
  3. 静态方法返回唯一实例 → 全局访问点
```

---
  三、实现方式对比

```
  ┌──────────────────┬────────────┬────────────┬──────────────────┐
  │     实现方式      │  线程安全  │    性能    │      特点        │
  ├──────────────────┼────────────┼────────────┼──────────────────┤
  │ 饿汉式           │     ✅     │    最快    │ 程序启动即创建   │
  ├──────────────────┼────────────┼────────────┼──────────────────┤
  │ 懒汉式(无锁)     │     ❌     │    快     │ 多线程下有竞争   │
  ├──────────────────┼────────────┼────────────┼──────────────────┤
  │ 懒汉式(加锁)     │     ✅     │    慢     │ 每次访问都加锁   │
  ├──────────────────┼────────────┼────────────┼──────────────────┤
  │ 双重检查锁(DCLP) │    ✅*    │    较快    │ C++11前有问题    │
  ├──────────────────┼────────────┼────────────┼──────────────────┤
  │ Meyers' Singleton│     ✅     │    最快    │ C++11推荐 ⭐     │
  └──────────────────┴────────────┴────────────┴──────────────────┘
```

---
  四、各实现方式详解

  1. 饿汉式（Eager Initialization）

```cpp
// 程序启动时就创建实例（静态初始化阶段）
class Singleton {
public:
    static Singleton& getInstance() {
        return instance_;  // 直接返回，无竞争
    }

    void doWork() { /* 业务逻辑 */ }

    // 禁止拷贝和赋值
    Singleton(const Singleton&) = delete;
    Singleton& operator=(const Singleton&) = delete;

private:
    Singleton() { /* 初始化 */ }
    static Singleton instance_;  // 声明
};

// 在编译单元中定义（程序启动时构造）
Singleton Singleton::instance_;
```

  优点：实现简单、天然线程安全
  缺点：
  - 无论是否使用都会创建（浪费资源）
  - 静态初始化顺序不确定（跨编译单元依赖时有隐患）

---

  2. 懒汉式 + 互斥锁

```cpp
#include <mutex>

class Singleton {
public:
    static Singleton& getInstance() {
        std::lock_guard<std::mutex> lock(mutex_);  // 每次都加锁
        if (!instance_) {
            instance_ = new Singleton();
        }
        return *instance_;
    }

    Singleton(const Singleton&) = delete;
    Singleton& operator=(const Singleton&) = delete;

private:
    Singleton() {}
    static Singleton* instance_;
    static std::mutex mutex_;
};

Singleton* Singleton::instance_ = nullptr;
std::mutex Singleton::mutex_;
```

  问题：每次调用 getInstance() 都加锁，性能差。
  实例创建后，后续访问不需要锁保护，但仍然在加锁。

---

  3. 双重检查锁（DCLP）

```cpp
#include <mutex>
#include <atomic>

class Singleton {
public:
    static Singleton& getInstance() {
        // 第一次检查（无锁，快速路径）
        Singleton* tmp = instance_.load(std::memory_order_acquire);
        if (!tmp) {
            std::lock_guard<std::mutex> lock(mutex_);
            // 第二次检查（持锁，安全路径）
            tmp = instance_.load(std::memory_order_relaxed);
            if (!tmp) {
                tmp = new Singleton();
                instance_.store(tmp, std::memory_order_release);
            }
        }
        return *tmp;
    }

    Singleton(const Singleton&) = delete;
    Singleton& operator=(const Singleton&) = delete;

private:
    Singleton() {}
    static std::atomic<Singleton*> instance_;
    static std::mutex mutex_;
};

std::atomic<Singleton*> Singleton::instance_{nullptr};
std::mutex Singleton::mutex_;
```

  为什么需要 memory_order？
  - 没有 acquire/release 语义，编译器/CPU 可能重排序
  - new Singleton() 分为: 分配内存 → 构造对象 → 赋值指针
  - 若重排序为: 分配内存 → 赋值指针 → 构造对象
  - 另一个线程可能读到未构造完成的对象！

---

  4. Meyers' Singleton（C++11 推荐方式）⭐

```cpp
class Singleton {
public:
    static Singleton& getInstance() {
        static Singleton instance;  // C++11保证线程安全的局部静态初始化
        return instance;
    }

    void doWork() { /* 业务逻辑 */ }

    Singleton(const Singleton&) = delete;
    Singleton& operator=(const Singleton&) = delete;

private:
    Singleton() { /* 初始化 */ }
    ~Singleton() { /* 清理 */ }
};
```

  为什么这是最佳方案？
  - C++11标准保证：局部静态变量的初始化是线程安全的
  - 编译器自动插入类似双重检查锁的机制
  - 懒加载：首次调用时才构造
  - 自动析构：程序结束时自动调用析构函数
  - 代码简洁：无需手动管理锁和原子变量

---

  5. 模板单例（通用化）

```cpp
template<typename T>
class Singleton {
public:
    static T& getInstance() {
        static T instance;
        return instance;
    }

    Singleton(const Singleton&) = delete;
    Singleton& operator=(const Singleton&) = delete;

protected:
    Singleton() = default;
    ~Singleton() = default;
};

// 使用：继承模板即可获得单例能力
class Logger : public Singleton<Logger> {
    friend class Singleton<Logger>;  // 允许基类访问私有构造
private:
    Logger() { /* 初始化日志系统 */ }
public:
    void log(const std::string& msg) { /* ... */ }
};

// 调用
Logger::getInstance().log("Hello");
```

---
  五、实际应用场景

  1. 配置管理器

```cpp
class ConfigManager : public Singleton<ConfigManager> {
    friend class Singleton<ConfigManager>;
private:
    std::unordered_map<std::string, std::string> configs_;
    mutable std::shared_mutex mutex_;  // 读写锁

    ConfigManager() {
        loadFromFile("config.yaml");
    }

    void loadFromFile(const std::string& path) { /* ... */ }

public:
    std::string get(const std::string& key) const {
        std::shared_lock lock(mutex_);  // 读锁
        auto it = configs_.find(key);
        return it != configs_.end() ? it->second : "";
    }

    void set(const std::string& key, const std::string& value) {
        std::unique_lock lock(mutex_);  // 写锁
        configs_[key] = value;
    }

    void reload() {
        std::unique_lock lock(mutex_);
        configs_.clear();
        loadFromFile("config.yaml");
    }
};
```

  2. 线程池单例

```cpp
class ThreadPool : public Singleton<ThreadPool> {
    friend class Singleton<ThreadPool>;
private:
    std::vector<std::thread> workers_;
    std::queue<std::function<void()>> tasks_;
    std::mutex mutex_;
    std::condition_variable cv_;
    bool stop_ = false;

    ThreadPool(size_t threads = std::thread::hardware_concurrency()) {
        for (size_t i = 0; i < threads; i++) {
            workers_.emplace_back([this] {
                while (true) {
                    std::function<void()> task;
                    {
                        std::unique_lock lock(mutex_);
                        cv_.wait(lock, [this] { return stop_ || !tasks_.empty(); });
                        if (stop_ && tasks_.empty()) return;
                        task = std::move(tasks_.front());
                        tasks_.pop();
                    }
                    task();
                }
            });
        }
    }

public:
    ~ThreadPool() {
        { std::unique_lock lock(mutex_); stop_ = true; }
        cv_.notify_all();
        for (auto& w : workers_) w.join();
    }

    template<typename F>
    void submit(F&& task) {
        { std::unique_lock lock(mutex_); tasks_.push(std::forward<F>(task)); }
        cv_.notify_one();
    }
};
```

---
  六、单例的"反模式"讨论

```
  为什么单例常被称为"反模式"？

  ┌───────────────────────────────────────────────────────────────┐
  │  问题1: 隐藏依赖                                              │
  │  void processOrder(Order& order) {                            │
  │      // 调用者不知道内部依赖了哪些单例                          │
  │      Logger::getInstance().log("processing");                 │
  │      Database::getInstance().save(order);                     │
  │      Cache::getInstance().invalidate(order.id);               │
  │  }                                                            │
  ├───────────────────────────────────────────────────────────────┤
  │  问题2: 难以测试                                              │
  │  // 单元测试时无法mock单例                                     │
  │  // 无法并行运行依赖同一单例的测试                              │
  ├───────────────────────────────────────────────────────────────┤
  │  问题3: 全局状态                                              │
  │  // 任何地方都能修改单例状态，难以追踪状态变更                   │
  │  // 增加了代码间的隐式耦合                                     │
  └───────────────────────────────────────────────────────────────┘

  替代方案：依赖注入

  // ❌ 单例方式
  class OrderService {
      void process() {
          Database::getInstance().save(...);  // 隐式依赖
      }
  };

  // ✅ 依赖注入方式
  class OrderService {
      IDatabase& db_;  // 显式依赖
  public:
      OrderService(IDatabase& db) : db_(db) {}
      void process() {
          db_.save(...);  // 可以注入mock对象测试
      }
  };
```

  何时适合使用单例：
  - ✅ 真正全局唯一的资源（日志系统、全局配置）
  - ✅ 创建成本高且无状态变更的对象
  - ✅ 硬件资源抽象（打印机、显卡）
  - ❌ 不适合有复杂状态的业务对象
  - ❌ 不适合需要多态/可替换的场景

---
  七、vs 其他模式

```
  ┌────────────────┬──────────────────────────────────────────────┐
  │    对比模式    │              关系                             │
  ├────────────────┼──────────────────────────────────────────────┤
  │ 工厂方法      │ 工厂本身通常是单例                            │
  ├────────────────┼──────────────────────────────────────────────┤
  │ 抽象工厂      │ 抽象工厂通常以单例形式存在                    │
  ├────────────────┼──────────────────────────────────────────────┤
  │ 建造者        │ Builder可以是单例（复用构建逻辑）             │
  ├────────────────┼──────────────────────────────────────────────┤
  │ 享元          │ 享元工厂通常是单例                            │
  ├────────────────┼──────────────────────────────────────────────┤
  │ 外观          │ Facade对象通常是单例                          │
  └────────────────┴──────────────────────────────────────────────┘
```

---
  八、设计要点

  1. 优先使用 Meyers' Singleton（C++11局部静态变量）
  2. 禁止拷贝和赋值（= delete）
  3. 考虑析构顺序问题（多个单例间的依赖）
  4. 多线程环境下注意单例内部状态的线程安全（实例唯一≠操作线程安全）
  5. 评估是否真的需要单例，优先考虑依赖注入
