---
title: "无锁数据结构实战：Lock-Free Queue、Stack与HashMap"
categories: [并发编程]
location: 西安
render_with_liquid: false
---

### 引言

互斥锁的问题：一个线程持有锁时被调度走，其他所有线程都阻塞等待。在高并发场景下，锁竞争可能导致90%的CPU时间浪费在等待上。无锁（Lock-Free）数据结构通过原子操作（CAS）实现并发访问，保证至少一个线程总能取得进展。

我们的消息队列在16线程下使用mutex保护的队列，吞吐只有单线程的3倍（锁竞争严重）。替换为无锁队列后，16线程吞吐达到单线程的12倍。

本文讲解无锁编程的核心原语（CAS），实现三种常用无锁数据结构，并讨论最棘手的ABA问题和内存回收。

---

### 1. CAS 原语：无锁的基石

```
  Compare-And-Swap (CAS) 语义：

  原子操作：
  bool CAS(addr, expected, desired) {
      if (*addr == expected) {
          *addr = desired;
          return true;   // 成功
      } else {
          expected = *addr;  // 更新expected为当前值
          return false;  // 失败（有人先改了）
      }
  }

  整个操作是原子的——硬件保证不会被中断。

  CAS循环模式（无锁操作的通用模板）：
  do {
      old_value = load(addr);
      new_value = compute(old_value);
  } while (!CAS(addr, old_value, new_value));
  // 如果失败（别人先改了），重新读取再试
```

```cpp
#include <atomic>

// C++ atomic CAS
std::atomic<int> counter{0};

void lockFreeIncrement() {
    int old_val = counter.load(std::memory_order_relaxed);
    while (!counter.compare_exchange_weak(
        old_val, old_val + 1,
        std::memory_order_release,
        std::memory_order_relaxed)) {
        // CAS失败，old_val已被更新为当前值，自动重试
    }
}
```

---

### 2. 无锁栈（Lock-Free Stack）

```cpp
#include <atomic>
#include <memory>

template<typename T>
class LockFreeStack {
    struct Node {
        T data;
        Node* next;
        Node(T val) : data(std::move(val)), next(nullptr) {}
    };

    std::atomic<Node*> head_{nullptr};

public:
    // Push: CAS头指针
    void push(T value) {
        Node* new_node = new Node(std::move(value));
        new_node->next = head_.load(std::memory_order_relaxed);
        // CAS循环：将head从old_head改为new_node
        while (!head_.compare_exchange_weak(
            new_node->next, new_node,
            std::memory_order_release,
            std::memory_order_relaxed)) {
            // 失败：new_node->next自动更新为当前head，重试
        }
    }

    // Pop: CAS头指针
    std::optional<T> pop() {
        Node* old_head = head_.load(std::memory_order_acquire);
        while (old_head) {
            // 尝试将head从old_head改为old_head->next
            if (head_.compare_exchange_weak(
                old_head, old_head->next,
                std::memory_order_acquire,
                std::memory_order_relaxed)) {
                T data = std::move(old_head->data);
                // ⚠️ 不能直接delete old_head！（ABA问题+其他线程可能还在读）
                // 需要安全内存回收（见第5节）
                retireNode(old_head);
                return data;
            }
            // 失败：old_head自动更新为当前head，重试
        }
        return std::nullopt;  // 栈空
    }
};
```

---

### 3. 无锁队列（MPMC Queue — 固定大小）

```cpp
#include <atomic>
#include <vector>
#include <optional>

// 高性能固定大小无锁队列（类似DPDK rte_ring）
template<typename T>
class LockFreeQueue {
    struct Cell {
        std::atomic<size_t> sequence;
        T data;
    };

    std::vector<Cell> buffer_;
    size_t mask_;
    alignas(64) std::atomic<size_t> enqueue_pos_{0};  // 独占cache line
    alignas(64) std::atomic<size_t> dequeue_pos_{0};  // 独占cache line

public:
    explicit LockFreeQueue(size_t capacity) 
        : buffer_(capacity), mask_(capacity - 1) {
        // capacity必须是2的幂
        assert((capacity & (capacity - 1)) == 0);
        for (size_t i = 0; i < capacity; i++) {
            buffer_[i].sequence.store(i, std::memory_order_relaxed);
        }
    }

    // 入队（多生产者安全）
    bool enqueue(T value) {
        Cell* cell;
        size_t pos = enqueue_pos_.load(std::memory_order_relaxed);

        while (true) {
            cell = &buffer_[pos & mask_];
            size_t seq = cell->sequence.load(std::memory_order_acquire);
            intptr_t diff = static_cast<intptr_t>(seq) - static_cast<intptr_t>(pos);

            if (diff == 0) {
                // 槽位空闲，尝试占用
                if (enqueue_pos_.compare_exchange_weak(
                    pos, pos + 1, std::memory_order_relaxed)) {
                    break;  // 成功占用
                }
            } else if (diff < 0) {
                return false;  // 队列满
            } else {
                pos = enqueue_pos_.load(std::memory_order_relaxed);  // 被其他人抢了，重试
            }
        }

        // 写入数据
        cell->data = std::move(value);
        cell->sequence.store(pos + 1, std::memory_order_release);  // 标记为已写入
        return true;
    }

    // 出队（多消费者安全）
    std::optional<T> dequeue() {
        Cell* cell;
        size_t pos = dequeue_pos_.load(std::memory_order_relaxed);

        while (true) {
            cell = &buffer_[pos & mask_];
            size_t seq = cell->sequence.load(std::memory_order_acquire);
            intptr_t diff = static_cast<intptr_t>(seq) - static_cast<intptr_t>(pos + 1);

            if (diff == 0) {
                // 有数据可读，尝试占用
                if (dequeue_pos_.compare_exchange_weak(
                    pos, pos + 1, std::memory_order_relaxed)) {
                    break;
                }
            } else if (diff < 0) {
                return std::nullopt;  // 队列空
            } else {
                pos = dequeue_pos_.load(std::memory_order_relaxed);
            }
        }

        T data = std::move(cell->data);
        cell->sequence.store(pos + mask_ + 1, std::memory_order_release);  // 标记为空闲
        return data;
    }
};
```

---

### 4. ABA 问题

```
  ABA 问题场景：

  线程1: 读取 head = A，准备pop
  线程1: [被调度走]

  线程2: pop A (head变为B)
  线程2: pop B (head变为C)
  线程2: push A回去 (head又变为A)  ← A被复用了！

  线程1: [恢复] CAS(head, A, A->next)
         CAS成功！因为head确实是A
         但A->next已经不是原来的B了（A被回收重新push后next变了）
         → 数据结构损坏！

  问题本质：CAS只比较值，不能区分"同一个A"和"新push的A"

  解决方案：
  1. 带版本号的CAS（ABA→A1BA2，版本号不同CAS失败）
  2. Hazard Pointer（安全内存回收，不复用刚释放的节点）
  3. RCU（读取不加锁，延迟释放）
```

```cpp
// 带版本号的原子指针（解决ABA）
template<typename T>
struct TaggedPointer {
    T* ptr;
    uintptr_t tag;  // 版本号，每次修改递增
};

// 使用128位CAS（x86_64支持 CMPXCHG16B）
template<typename T>
class AtomicTaggedPtr {
    // GCC: 使用 __int128 或 alignas(16) struct
    alignas(16) std::atomic<TaggedPointer<T>> data_;

public:
    TaggedPointer<T> load() {
        return data_.load(std::memory_order_acquire);
    }

    bool cas(TaggedPointer<T>& expected, TaggedPointer<T> desired) {
        return data_.compare_exchange_weak(expected, desired,
            std::memory_order_acq_rel, std::memory_order_acquire);
    }
};

// 使用tagged pointer的无锁栈pop
std::optional<T> pop() {
    TaggedPointer<Node> old_head = head_.load();
    while (old_head.ptr) {
        TaggedPointer<Node> new_head{old_head.ptr->next, old_head.tag + 1};
        if (head_.cas(old_head, new_head)) {
            // 即使ptr相同，tag不同也会CAS失败 → ABA安全
            T data = std::move(old_head.ptr->data);
            delete old_head.ptr;
            return data;
        }
    }
    return std::nullopt;
}
```

---

### 5. 安全内存回收：Hazard Pointer

```cpp
// Hazard Pointer: 保护正在被读取的节点不被释放

class HazardPointerManager {
    static constexpr int MAX_THREADS = 64;
    static constexpr int MAX_RETIRED = 128;

    struct ThreadRecord {
        std::atomic<void*> hazard{nullptr};  // 当前保护的指针
        std::vector<void*> retired;          // 待回收的节点
    };

    std::array<ThreadRecord, MAX_THREADS> records_;

public:
    // 标记"我正在读取这个指针"
    void protect(int thread_id, void* ptr) {
        records_[thread_id].hazard.store(ptr, std::memory_order_release);
    }

    // 取消保护
    void unprotect(int thread_id) {
        records_[thread_id].hazard.store(nullptr, std::memory_order_release);
    }

    // 延迟回收（不立即delete，等没人引用时再释放）
    void retire(int thread_id, void* ptr) {
        records_[thread_id].retired.push_back(ptr);

        if (records_[thread_id].retired.size() >= MAX_RETIRED) {
            scan(thread_id);  // 积累够了，尝试回收
        }
    }

private:
    void scan(int thread_id) {
        // 收集所有线程的hazard pointer
        std::set<void*> hazards;
        for (auto& record : records_) {
            void* hp = record.hazard.load(std::memory_order_acquire);
            if (hp) hazards.insert(hp);
        }

        // 回收不在hazard集合中的节点
        auto& retired = records_[thread_id].retired;
        auto it = std::remove_if(retired.begin(), retired.end(),
            [&](void* ptr) {
                if (hazards.find(ptr) == hazards.end()) {
                    delete static_cast<Node*>(ptr);  // 安全释放
                    return true;
                }
                return false;  // 还有人在引用，暂不释放
            });
        retired.erase(it, retired.end());
    }
};
```

---

### 6. 性能对比

```
  16线程 生产-消费 队列（100万次操作）：

  ┌──────────────────────────────┬──────────┬───────────────┐
  │ 实现                         │ 吞吐(M/s)│ 延迟(P99)     │
  ├──────────────────────────────┼──────────┼───────────────┤
  │ std::mutex + std::queue      │ 3.2M     │ 15μs         │
  ├──────────────────────────────┼──────────┼───────────────┤
  │ spinlock + queue             │ 5.1M     │ 8μs          │
  ├──────────────────────────────┼──────────┼───────────────┤
  │ Lock-Free MPMC (fixed size) │ 28M      │ 0.5μs        │
  ├──────────────────────────────┼──────────┼───────────────┤
  │ SPSC Queue (单生产单消费)    │ 45M      │ 0.1μs        │
  └──────────────────────────────┴──────────┴───────────────┘

  无锁MPMC比mutex快 8.7 倍，SPSC比mutex快 14 倍。
```

---

### 7. 何时使用无锁

```
  ┌──────────────────────────────┬──────────────────────────────┐
  │ ✅ 适合无锁                  │ ❌ 不适合无锁                 │
  ├──────────────────────────────┼──────────────────────────────┤
  │ 高竞争（多线程频繁访问）     │ 低竞争（偶尔并发）           │
  │ 简单数据结构（栈/队列）      │ 复杂数据结构（红黑树/跳表）  │
  │ 操作简单（push/pop）         │ 复合操作（遍历+修改）        │
  │ 延迟敏感（不能等待）         │ 吞吐优先（可以批量加锁）     │
  │ 实时系统（不能priority inversion）│ 普通服务              │
  └──────────────────────────────┴──────────────────────────────┘

  原则：
  - 能用锁解决的先用锁（简单正确）
  - 锁成为瓶颈时再考虑无锁
  - 无锁代码极难正确实现和调试
  - 优先使用经过验证的库（folly、Boost.Lockfree）
```

---

### 总结

无锁数据结构的核心：

1. **CAS是基础原语**：原子比较+交换，失败则重试
2. **固定大小MPMC队列最实用**：生产消费场景的首选无锁结构
3. **ABA是最大陷阱**：用tagged pointer（版本号）或hazard pointer解决
4. **内存回收是难点**：不能直接delete正在被其他线程读的节点
5. **False Sharing要避免**：生产者/消费者指针分别占独立cache line
6. **不要轻易自己实现**：用成熟库，无锁代码的bug极难调试

无锁编程是"最后的武器"——在锁确实成为瓶颈时才使用。正确性远比性能重要，一个有bug的无锁结构比慢一点的有锁结构危险一万倍。
