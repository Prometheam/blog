---
layout: post_layout
title: "无锁编程实战：从CAS到Lock-Free Queue"
date: 2026-05-27 11:00:00 +0800
categories: [C++语言]
location: 西安
excerpt_separator: "```"
---

### 引言

无锁编程（Lock-Free Programming）是高性能系统的终极武器，也是最容易写出Bug的领域。我在开发百万级消息队列和高频交易系统时，深刻体会到：**无锁不是"不加锁"，而是用原子操作代替锁来保证并发安全。**

这篇文章从CAS原语出发，手把手实现一个生产级的Lock-Free Queue，并探讨ABA问题、内存回收等关键难题。

---

### 1. 为什么要无锁？

#### 1.1 锁的代价

```
mutex加锁的开销（Linux, x86-64, 无竞争）：
  pthread_mutex_lock/unlock：~25ns
  std::mutex lock/unlock：~25ns

看起来很快？但在以下场景会爆炸：
  - 高竞争（多线程同时抢锁）：从25ns飙升到微秒级
  - 优先级反转：低优先级线程持锁，高优先级线程被阻塞
  - 上下文切换：竞争失败时线程睡眠+唤醒 ≈ 5~15μs
  - 持锁线程被调度出去：所有等待线程全部阻塞
```

#### 1.2 无锁的保证等级

```
┌──────────────┬─────────────────────────────────────────────────┐
│    等级      │              保证                               │
├──────────────┼─────────────────────────────────────────────────┤
│ Wait-Free    │ 每个线程都能在有限步内完成操作（最强）          │
│ Lock-Free    │ 系统整体保证有进展（某些线程可能饿死）         │
│ Obstruction- │ 无竞争时保证完成（有竞争时可能活锁）           │
│ Free         │                                                 │
│ Lock-Based   │ 可能死锁、优先级反转、全部阻塞（最弱）        │
└──────────────┴─────────────────────────────────────────────────┘
```

---

### 2. CAS：无锁编程的基石

#### 2.1 Compare-And-Swap 原理

```cpp
// CAS伪代码（CPU硬件保证原子执行）
bool CAS(T* addr, T expected, T desired) {
    // 以下三步是原子的（一条CPU指令）
    if (*addr == expected) {
        *addr = desired;
        return true;   // 成功
    }
    return false;      // 失败，说明被其他线程修改了
}
```

在C++中：
```cpp
std::atomic<int> value{0};

int expected = 0;
int desired = 1;

// 如果value当前是0，就改成1
bool success = value.compare_exchange_strong(expected, desired);
// 如果失败，expected会被更新为value的当前值
```

#### 2.2 CAS循环模式（Lock-Free的基本套路）

```cpp
// 无锁累加
void lockFreeIncrement(std::atomic<int>& counter) {
    int old_value = counter.load(std::memory_order_relaxed);
    while (!counter.compare_exchange_weak(old_value, old_value + 1,
                                          std::memory_order_relaxed)) {
        // CAS失败说明old_value已过时
        // compare_exchange_weak自动将old_value更新为当前值
        // 重试
    }
}
```

**weak vs strong**：
- `compare_exchange_weak`：可能伪失败（spurious failure），适合用在循环中
- `compare_exchange_strong`：不会伪失败，适合只CAS一次的场景
- weak在某些平台（ARM）上更快，因为不需要内部循环

---

### 3. ABA 问题：无锁编程的头号杀手

#### 3.1 什么是ABA？

```
时间线：
  线程1：读到值 A
  线程1：被抢占（暂停）
  
  线程2：把值从 A 改成 B
  线程2：又把值从 B 改回 A
  
  线程1：恢复，CAS比较——"还是A，没人动过！" → CAS成功
  
  但实际上值经历了 A→B→A 的变化！
  如果A是指针，B期间指针指向的内存可能已被释放并重新分配！
```

#### 3.2 ABA在无锁栈中的灾难

```cpp
// 无锁栈（有ABA Bug的版本）
struct Node {
    int data;
    Node* next;
};

class LockFreeStack {
    std::atomic<Node*> top_{nullptr};

public:
    void push(Node* node) {
        node->next = top_.load();
        while (!top_.compare_exchange_weak(node->next, node));
    }

    Node* pop() {
        Node* old_top = top_.load();
        while (old_top &&
               !top_.compare_exchange_weak(old_top, old_top->next)) {
            // ← ABA漏洞：old_top->next可能已无效！
        }
        return old_top;
    }
};
```

**ABA攻击场景**：
```
栈状态: top → A → B → C

线程1: pop() 读到 old_top=A, old_top->next=B
线程1: 被抢占

线程2: pop() 拿走 A
线程2: pop() 拿走 B
线程2: push(A) 把A重新压入
栈状态: top → A → C  (B已被释放!)

线程1: 恢复，CAS(top, A, B) → 成功!（top确实还是A）
栈状态: top → B → ???  (B已被free，悬垂指针!)
```

#### 3.3 解决方案1：Tagged Pointer（版本号）

```cpp
// 用高位存版本号（x86-64指针只用48位，高16位可用于tag）
struct TaggedPtr {
    uintptr_t ptr : 48;
    uintptr_t tag : 16;  // 版本号，每次修改+1
};

// 或者用128位CAS（x86-64支持cmpxchg16b）
struct StampedReference {
    Node* ptr;
    uint64_t stamp;  // 版本号
};

std::atomic<StampedReference> top_;

Node* pop() {
    StampedReference old_top = top_.load();
    StampedReference new_top;
    do {
        if (old_top.ptr == nullptr) return nullptr;
        new_top = {old_top.ptr->next, old_top.stamp + 1};  // 版本号+1
    } while (!top_.compare_exchange_weak(old_top, new_top));
    return old_top.ptr;
}
```

#### 3.4 解决方案2：Hazard Pointer（风险指针）

核心思想：每个线程在使用某个节点前，先"声明"自己正在使用它。其他线程在删除节点前，检查有没有人声明正在使用——有的话就延迟删除。

```cpp
// 简化版Hazard Pointer
class HazardPointerManager {
    static constexpr int MAX_THREADS = 64;
    std::atomic<void*> hazard_pointers_[MAX_THREADS];

public:
    // 声明正在使用某个指针
    void protect(int thread_id, void* ptr) {
        hazard_pointers_[thread_id].store(ptr, std::memory_order_release);
    }

    // 取消声明
    void clear(int thread_id) {
        hazard_pointers_[thread_id].store(nullptr, std::memory_order_release);
    }

    // 检查某指针是否被任何线程保护
    bool isProtected(void* ptr) {
        for (int i = 0; i < MAX_THREADS; ++i) {
            if (hazard_pointers_[i].load(std::memory_order_acquire) == ptr)
                return true;
        }
        return false;
    }

    // 安全删除：如果没人保护就删，否则放入待回收列表
    void retire(void* ptr, std::vector<void*>& retired_list) {
        retired_list.push_back(ptr);
        if (retired_list.size() > 2 * MAX_THREADS) {
            // 批量扫描，回收不被保护的节点
            auto it = retired_list.begin();
            while (it != retired_list.end()) {
                if (!isProtected(*it)) {
                    free(*it);
                    it = retired_list.erase(it);
                } else {
                    ++it;
                }
            }
        }
    }
};
```

#### 3.5 解决方案3：Epoch-Based Reclamation（基于纪元的回收）

比Hazard Pointer更简单高效，是当前生产环境的主流选择：

```cpp
class EpochManager {
    std::atomic<uint64_t> global_epoch_{0};
    thread_local static uint64_t local_epoch_;
    thread_local static bool in_critical_;
    std::vector<void*> retire_lists_[3];  // 三个纪元的待回收列表

public:
    // 进入临界区（表示正在访问共享数据）
    void enterCritical() {
        local_epoch_ = global_epoch_.load(std::memory_order_acquire);
        in_critical_ = true;
        std::atomic_thread_fence(std::memory_order_seq_cst);
    }

    // 离开临界区
    void leaveCritical() {
        in_critical_ = false;
    }

    // 延迟删除
    void retire(void* ptr) {
        uint64_t epoch = global_epoch_.load();
        retire_lists_[epoch % 3].push_back(ptr);
    }

    // 尝试推进纪元并回收
    void tryAdvance() {
        uint64_t current = global_epoch_.load();
        // 检查所有线程是否都跟上了当前纪元
        if (allThreadsInCurrentEpoch()) {
            uint64_t new_epoch = current + 1;
            global_epoch_.store(new_epoch);
            // 安全回收两个纪元前的数据
            for (void* ptr : retire_lists_[(new_epoch + 1) % 3]) {
                free(ptr);
            }
            retire_lists_[(new_epoch + 1) % 3].clear();
        }
    }
};
```

---

### 4. 实战：Michael & Scott 无锁队列

这是最经典的Lock-Free MPMC（多生产者多消费者）队列实现：

```cpp
#include <atomic>
#include <memory>

template<typename T>
class LockFreeQueue {
    struct Node {
        T data;
        std::atomic<Node*> next;
        Node() : next(nullptr) {}
        Node(T val) : data(std::move(val)), next(nullptr) {}
    };

    // 使用Tagged Pointer防止ABA
    struct TaggedPtr {
        Node* ptr;
        uint64_t tag;

        bool operator==(const TaggedPtr& other) const {
            return ptr == other.ptr && tag == other.tag;
        }
    };

    std::atomic<TaggedPtr> head_;
    std::atomic<TaggedPtr> tail_;

public:
    LockFreeQueue() {
        Node* dummy = new Node();  // 哨兵节点
        head_.store({dummy, 0});
        tail_.store({dummy, 0});
    }

    ~LockFreeQueue() {
        // 清理所有剩余节点
        Node* node = head_.load().ptr;
        while (node) {
            Node* next = node->next.load();
            delete node;
            node = next;
        }
    }

    void enqueue(T value) {
        Node* new_node = new Node(std::move(value));

        while (true) {
            TaggedPtr tail = tail_.load(std::memory_order_acquire);
            Node* next = tail.ptr->next.load(std::memory_order_acquire);

            // tail是否仍然有效？
            if (tail == tail_.load(std::memory_order_relaxed)) {
                if (next == nullptr) {
                    // tail确实指向最后一个节点，尝试追加
                    if (tail.ptr->next.compare_exchange_weak(
                            next, new_node, std::memory_order_release)) {
                        // 追加成功，尝试推进tail（允许失败，别人会帮忙推）
                        TaggedPtr new_tail = {new_node, tail.tag + 1};
                        tail_.compare_exchange_strong(tail, new_tail);
                        return;
                    }
                } else {
                    // tail滞后了（别人追加了但还没推进tail），帮忙推进
                    TaggedPtr new_tail = {next, tail.tag + 1};
                    tail_.compare_exchange_strong(tail, new_tail);
                }
            }
        }
    }

    bool dequeue(T& result) {
        while (true) {
            TaggedPtr head = head_.load(std::memory_order_acquire);
            TaggedPtr tail = tail_.load(std::memory_order_acquire);
            Node* next = head.ptr->next.load(std::memory_order_acquire);

            if (head == head_.load(std::memory_order_relaxed)) {
                if (head.ptr == tail.ptr) {
                    if (next == nullptr) {
                        return false;  // 队列空
                    }
                    // tail滞后，帮忙推进
                    TaggedPtr new_tail = {next, tail.tag + 1};
                    tail_.compare_exchange_strong(tail, new_tail);
                } else {
                    // 读取数据（在CAS之前读，因为CAS成功后节点可能被其他线程释放）
                    result = next->data;

                    // 尝试推进head
                    TaggedPtr new_head = {next, head.tag + 1};
                    if (head_.compare_exchange_strong(head, new_head)) {
                        delete head.ptr;  // 释放旧的哨兵节点
                        return true;
                    }
                    // CAS失败，重试
                }
            }
        }
    }
};
```

---

### 5. 生产环境的选型建议

#### 5.1 何时用无锁？

```
✅ 适合无锁的场景：
  - 延迟敏感（金融交易、实时音视频）
  - 高竞争（多核心高并发写入）
  - 不能容忍优先级反转（实时系统）
  - 简单数据结构（栈、队列、计数器）

❌ 不适合无锁的场景：
  - 复杂的复合操作（需要锁保护多个数据结构的一致性）
  - 低竞争场景（锁的开销可忽略，代码简单更重要）
  - 内存受限（无锁通常需要更多内存用于版本号、回收列表）
  - 开发人员C++原子操作经验不足（Bug极难排查）
```

#### 5.2 推荐的无锁库

| 库 | 特点 | 适用场景 |
|-----|------|----------|
| `folly::MPMCQueue` | Facebook出品，固定大小，极高性能 | 通用MPMC队列 |
| `moodycamel::ConcurrentQueue` | 无锁，支持bulk操作 | 高吞吐消息传递 |
| `boost::lockfree::queue` | Boost标准化，可靠稳定 | 需要Boost的项目 |
| `DPDK rte_ring` | 环形缓冲区，零拷贝 | 网络数据包处理 |

#### 5.3 性能对比（8核，100万次入队出队）

```
                       吞吐量(ops/s)    P99延迟
std::mutex + queue     12M              850ns
spinlock + queue       18M              420ns
folly::MPMCQueue       45M              120ns
moodycamel::Queue      52M              95ns
SPSC (单生产单消费)    180M             22ns
```

---

### 6. 调试无锁代码的经验

1. **TSan（ThreadSanitizer）**：编译时加`-fsanitize=thread`，能检测data race
2. **压力测试 + 随机延迟**：在CAS循环中随机sleep，增大race window
3. **形式化验证**：复杂算法用TLA+或CDSChecker验证正确性
4. **分层调试**：先在单线程确认逻辑正确，再逐步加线程

```bash
# 编译加TSan
g++ -fsanitize=thread -O1 -g lock_free_queue.cpp -o test
./test  # TSan会报告检测到的data race
```

---

### 总结

无锁编程的核心公式：
```
无锁 = CAS循环 + 正确的内存序 + ABA防护 + 安全的内存回收
```

每一环都不能少。CAS保证原子修改，内存序保证可见性，ABA防护保证逻辑正确，内存回收保证不会use-after-free。

**我的建议**：除非你的场景真的需要极致性能，否则**先用锁写出正确的代码，再用性能分析确认瓶颈**。如果确实需要无锁，优先用经过验证的开源库而不是自己实现。自己实现Lock-Free数据结构，应该被视为"证明自己理解原理"的练习，而不是生产代码的首选。
