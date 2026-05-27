---
layout: post_layout
title: "shared_ptr源码剖析：引用计数与控制块设计"
date: 2026-05-27 06:00:00 +0800
categories: [C++语言]
location: 西安
excerpt_separator: "```"
---

工作九年，`shared_ptr` 大概是我用得最多也踩坑最深的智能指针。今天从源码层面剖析它的核心设计——控制块（Control Block）。

## 控制块的内存布局

每个 `shared_ptr` 背后都有一个控制块，其逻辑结构如下：

```
+------------------+
|   strong_count   |  // std::atomic<long> 强引用计数
+------------------+
|   weak_count     |  // std::atomic<long> 弱引用计数（+1偏移）
+------------------+
|   deleter        |  // 类型擦除的删除器
+------------------+
|   allocator      |  // 分配器（可选）
+------------------+
|   managed_ptr    |  // 指向被管理对象（或对象内嵌）
+------------------+
```

`strong_count` 降为 0 时销毁对象，`weak_count` 降为 0 时释放控制块本身。这里有个设计细节：`weak_count` 实际上是"弱引用数 + 1"，那个额外的 1 代表所有强引用的"集体持有"。这样当最后一个 `shared_ptr` 析构时，只需对 `weak_count` 做一次原子减。

## make_shared 的单次分配优化

这是面试高频题，也是实际性能优化的关键点：

```cpp
// 方式一：两次内存分配
auto p = std::shared_ptr<Widget>(new Widget(args));
// 1) new Widget  -> 堆分配对象
// 2) shared_ptr构造 -> 堆分配控制块

// 方式二：一次内存分配
auto p = std::make_shared<Widget>(args);
// 单次分配，对象和控制块在连续内存中
```

`make_shared` 的内存布局：

```
+------------------+------------------+
|   Control Block  |   Widget 对象     |
+------------------+------------------+
      单次 malloc，cache-friendly
```

但 `make_shared` 有个隐含代价：当所有 `shared_ptr` 已析构但仍有 `weak_ptr` 存活时，对象的内存无法提前释放（因为控制块和对象在同一块内存中）。对于大对象，这点需要权衡。

## weak_ptr 打破循环引用

经典场景——父子互相持有：

```cpp
struct Parent {
    std::shared_ptr<Child> child;
};
struct Child {
    std::weak_ptr<Parent> parent;  // 弱引用，不增加strong_count
};
```

`weak_ptr::lock()` 的实现本质是原子 CAS 循环：

```cpp
shared_ptr<T> lock() const noexcept {
    long count = ctrl_->strong_count.load(std::memory_order_relaxed);
    while (count != 0) {
        if (ctrl_->strong_count.compare_exchange_weak(
                count, count + 1, std::memory_order_acq_rel)) {
            return shared_ptr<T>(/* 从已有控制块构造 */);
        }
    }
    return shared_ptr<T>();  // 对象已销毁
}
```

## 引用计数的线程安全

控制块的引用计数使用 `std::atomic` 操作，但需要明确：**引用计数本身是线程安全的，但 `shared_ptr` 对象的读写不是**。

```cpp
// 线程安全：多个线程拷贝/析构各自的shared_ptr副本
std::shared_ptr<Widget> global_ptr = make_shared<Widget>();
// Thread A: auto local = global_ptr;   // OK
// Thread B: auto local = global_ptr;   // OK

// 非线程安全：多个线程读写同一个shared_ptr变量
// Thread A: global_ptr = other_ptr;    // 数据竞争！
// Thread B: auto local = global_ptr;   // 数据竞争！
```

增减计数使用的内存序：
- 增加 `strong_count`：`memory_order_relaxed`（不需要同步）
- 减少 `strong_count`：`memory_order_acq_rel`（确保析构前可见所有修改）

## 自定义删除器与 enable_shared_from_this

```cpp
// 自定义删除器不影响类型（类型擦除）
auto file_closer = [](FILE* f) { fclose(f); };
std::shared_ptr<FILE> fp(fopen("data.txt", "r"), file_closer);

// enable_shared_from_this 的实现原理
class Session : public std::enable_shared_from_this<Session> {
public:
    std::shared_ptr<Session> get_ptr() {
        return shared_from_this();  // 从内部weak_ptr构造
    }
};
```

`enable_shared_from_this` 内部持有一个 `weak_ptr<T>`，在 `shared_ptr` 构造时通过模板检测自动初始化。

## 常见陷阱

```cpp
// 陷阱1：从裸指针重复构造（double free）
Widget* raw = new Widget();
std::shared_ptr<Widget> p1(raw);
std::shared_ptr<Widget> p2(raw);  // 两个独立控制块！

// 陷阱2：this指针泄露
class Bad {
    void method() {
        // 错误！创建了独立控制块
        callback(std::shared_ptr<Bad>(this));
    }
};

// 陷阱3：循环引用导致内存泄漏
struct Node {
    std::shared_ptr<Node> next;  // 应该用 weak_ptr
};
```

## 性能开销分析

我用 benchmark 对比过三种指针在实际场景下的表现：

```
操作               | raw_ptr | unique_ptr | shared_ptr
-------------------+---------+------------+-----------
创建               |  ~1ns   |   ~1ns     |  ~40ns (含malloc)
拷贝/移动          |  ~1ns   |   N/A/~1ns |  ~5ns (atomic inc)
析构               |  ~1ns   |   ~1ns     |  ~5ns (atomic dec)
解引用             |  ~0ns   |   ~0ns     |  ~0ns
make_shared创建    |   -     |    -       |  ~25ns (单次malloc)
```

`shared_ptr` 的主要开销来自：1）控制块的堆分配；2）原子操作。在热路径上，如果不需要共享所有权，`unique_ptr` 几乎零开销。

## 实践建议

经过多年在后端服务中的使用经验，我的原则是：
1. 默认用 `unique_ptr`，只在确实需要共享所有权时用 `shared_ptr`
2. 始终用 `make_shared`，除非需要自定义删除器或担心 `weak_ptr` 延长内存生命周期
3. 跨线程传递时用值语义（拷贝 `shared_ptr`），不要传引用
4. 观察者模式中用 `weak_ptr`，回调注册时格外注意生命周期

理解控制块的设计，才能在性能和安全之间做出正确的权衡。
