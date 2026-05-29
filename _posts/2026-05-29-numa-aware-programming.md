---
title: "NUMA感知编程：跨节点延迟优化与百万QPS扩展"
categories: [Linux系统]
location: 西安
render_with_liquid: false
---

### 引言

当你的服务扩展到多核时，可能遇到一个怪现象：从8核扩展到16核，性能只提升了30%而非100%。罪魁祸首往往是NUMA（Non-Uniform Memory Access）——CPU访问"远端"内存比"本地"内存慢3-5倍。

我们的KV缓存服务在48核机器上跑到24核时性能开始下降。profiling发现大量remote memory access。通过NUMA感知的内存分配和线程绑定，同样的硬件上QPS从150万提升到320万。

本文讲解NUMA架构原理、检测工具、以及C++中NUMA感知编程的实战技巧。

---

### 1. NUMA 架构原理

```
  UMA (统一内存访问) — 老式架构：

  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │  CPU 0   │  │  CPU 1   │  │  CPU 2   │  │  CPU 3   │
  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
       │              │              │              │
  ═════╪══════════════╪══════════════╪══════════════╪═════  共享总线
       │              │              │              │
  ┌────┴──────────────┴──────────────┴──────────────┴────┐
  │                     内存                              │
  │               (所有CPU等距访问)                       │
  └──────────────────────────────────────────────────────┘

  NUMA (非统一内存访问) — 现代多路服务器：

  ┌─────────────────────────────┐     ┌─────────────────────────────┐
  │         Node 0              │     │         Node 1              │
  │  ┌──────┐  ┌──────┐        │     │  ┌──────┐  ┌──────┐        │
  │  │CPU 0 │  │CPU 1 │        │     │  │CPU 2 │  │CPU 3 │        │
  │  └──┬───┘  └──┬───┘        │     │  └──┬───┘  └──┬───┘        │
  │     │         │             │     │     │         │             │
  │  ┌──┴─────────┴──┐         │     │  ┌──┴─────────┴──┐         │
  │  │  Local Memory  │ ~80ns  │     │  │  Local Memory  │ ~80ns  │
  │  │    (32GB)      │         │     │  │    (32GB)      │         │
  │  └────────────────┘         │     │  └────────────────┘         │
  └──────────────┬──────────────┘     └──────────────┬──────────────┘
                 │                                    │
                 └────── QPI/UPI互连 ─────────────────┘
                         (~150-300ns 跨节点访问)

  关键延迟差异：
  本地内存访问:  ~80ns
  远端内存访问:  ~150-300ns (慢2-4倍！)
```

---

### 2. 检测 NUMA 拓扑

```bash
# 查看NUMA拓扑
numactl --hardware

# 输出示例：
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11
# node 0 size: 32768 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23
# node 1 size: 32768 MB
# node distances:
# node   0   1
#   0:  10  21    ← 跨节点访问延迟是本地的2.1倍
#   1:  21  10

# 查看进程的NUMA内存分布
numastat -p <PID>

# 查看NUMA命中率
numastat
# numa_hit:  访问本地内存次数
# numa_miss: 访问远端内存次数（越高越需要优化）

# 实时监控
perf stat -e node-load-misses,node-store-misses -p <PID> sleep 5
```

---

### 3. NUMA 感知内存分配

```cpp
#include <numa.h>
#include <numaif.h>
#include <sched.h>
#include <thread>
#include <vector>

// 在指定NUMA节点分配内存
void* numa_alloc_on_node(size_t size, int node) {
    void* ptr = numa_alloc_onnode(size, node);
    if (!ptr) throw std::bad_alloc();
    return ptr;
}

// NUMA感知的内存池
class NumaMemoryPool {
public:
    NumaMemoryPool(size_t pool_size_per_node) {
        int num_nodes = numa_num_configured_nodes();
        for (int node = 0; node < num_nodes; node++) {
            void* mem = numa_alloc_onnode(pool_size_per_node, node);
            if (mem) {
                pools_.push_back({mem, pool_size_per_node, node, 0});
            }
        }
    }

    ~NumaMemoryPool() {
        for (auto& pool : pools_) {
            numa_free(pool.base, pool.size);
        }
    }

    // 从当前CPU所在的NUMA节点分配
    void* allocate(size_t size) {
        int node = numa_node_of_cpu(sched_getcpu());
        return allocateFromNode(size, node);
    }

    // 从指定节点分配
    void* allocateFromNode(size_t size, int node) {
        if (node >= (int)pools_.size()) return nullptr;
        auto& pool = pools_[node];
        if (pool.offset + size > pool.size) return nullptr;

        void* ptr = static_cast<char*>(pool.base) + pool.offset;
        pool.offset += size;
        return ptr;
    }

private:
    struct Pool {
        void* base;
        size_t size;
        int node;
        size_t offset;
    };
    std::vector<Pool> pools_;
};
```

---

### 4. 线程绑定与 CPU 亲和

```cpp
#include <pthread.h>
#include <sched.h>

// 将线程绑定到指定CPU核心
void bindThreadToCore(std::thread& t, int core_id) {
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(core_id, &cpuset);
    pthread_setaffinity_np(t.native_handle(), sizeof(cpuset), &cpuset);
}

// 将线程绑定到指定NUMA节点的所有核心
void bindThreadToNode(std::thread& t, int node) {
    struct bitmask* mask = numa_allocate_cpumask();
    numa_node_to_cpus(node, mask);
    pthread_setaffinity_np(t.native_handle(), numa_bitmask_nbytes(mask),
                           reinterpret_cast<cpu_set_t*>(mask->maskp));
    numa_free_cpumask(mask);
}

// NUMA感知的工作线程模型
class NumaWorkerPool {
public:
    NumaWorkerPool(int workers_per_node) {
        int num_nodes = numa_num_configured_nodes();
        for (int node = 0; node < num_nodes; node++) {
            for (int i = 0; i < workers_per_node; i++) {
                workers_.emplace_back([this, node] {
                    // 设置内存分配策略：优先本地节点
                    numa_set_preferred(node);
                    workerLoop(node);
                });
                bindThreadToNode(workers_.back(), node);
            }
        }
    }

private:
    void workerLoop(int node) {
        // 此线程的所有内存分配都在本地NUMA节点
        auto* local_buffer = numa_alloc_onnode(64 * 1024, node);
        while (running_) {
            processRequests(node, local_buffer);
        }
        numa_free(local_buffer, 64 * 1024);
    }

    std::vector<std::thread> workers_;
    std::atomic<bool> running_{true};
};
```

---

### 5. 数据分区：按NUMA节点划分

```cpp
// 关键思想：让每个NUMA节点只访问自己的数据

// ❌ NUMA不感知的HashMap（所有线程共享一份数据）
std::unordered_map<Key, Value> global_map;  // 跨节点竞争+远端访问

// ✅ NUMA分区的HashMap（每个节点一份副本/分片）
template<typename K, typename V>
class NumaPartitionedMap {
    struct NodePartition {
        std::unordered_map<K, V> data;
        mutable std::shared_mutex mutex;
        // 内存分配在对应NUMA节点上
    };

    std::vector<std::unique_ptr<NodePartition>> partitions_;

public:
    NumaPartitionedMap() {
        int num_nodes = numa_num_configured_nodes();
        for (int node = 0; node < num_nodes; node++) {
            // 在目标NUMA节点上分配partition对象
            void* mem = numa_alloc_onnode(sizeof(NodePartition), node);
            partitions_.push_back(
                std::unique_ptr<NodePartition>(new (mem) NodePartition()));
        }
    }

    void put(const K& key, const V& value) {
        int node = keyToNode(key);
        auto& partition = *partitions_[node];
        std::unique_lock lock(partition.mutex);
        partition.data[key] = value;
    }

    std::optional<V> get(const K& key) const {
        int node = keyToNode(key);
        auto& partition = *partitions_[node];
        std::shared_lock lock(partition.mutex);
        auto it = partition.data.find(key);
        if (it != partition.data.end()) return it->second;
        return std::nullopt;
    }

private:
    int keyToNode(const K& key) const {
        return std::hash<K>{}(key) % partitions_.size();
    }
};
```

---

### 6. 性能影响量化

```
  NUMA感知 vs 不感知的性能对比（48核双路服务器，KV缓存）：

  ┌─────────────────────────────┬──────────────┬──────────────┐
  │         配置                │  QPS(万)     │  P99延迟     │
  ├─────────────────────────────┼──────────────┼──────────────┤
  │ 不绑核 + 默认malloc        │ 150万        │ 850μs       │
  ├─────────────────────────────┼──────────────┼──────────────┤
  │ 绑核(同节点) + 默认malloc  │ 220万        │ 420μs       │
  ├─────────────────────────────┼──────────────┼──────────────┤
  │ 绑核 + numa_alloc本地分配  │ 280万        │ 180μs       │
  ├─────────────────────────────┼──────────────┼──────────────┤
  │ 绑核 + 数据分区 + 本地分配 │ 320万        │ 95μs        │
  └─────────────────────────────┴──────────────┴──────────────┘

  从不感知到全面NUMA优化：QPS提升2.1倍，P99降低89%
```

---

### 7. 最佳实践

| 实践 | 具体做法 |
|------|---------|
| 线程绑核 | 每个工作线程绑定到固定NUMA节点 |
| 本地分配 | 线程的工作内存从所在节点分配 |
| 数据分区 | 将共享数据按NUMA节点分片 |
| 避免跨节点锁 | 每个分区独立的锁，无跨节点竞争 |
| 大页内存 | 结合NUMA使用2MB大页减少TLB miss |
| interleave模式 | 如果无法确定访问模式，用交错分配 |
| 监控numa_miss | 持续观察numastat，numa_miss高则需优化 |

---

### 总结

NUMA感知编程的核心：

1. **知道拓扑**：`numactl --hardware`了解节点数、CPU分布、距离矩阵
2. **线程绑核**：工作线程绑定到NUMA节点，避免OS跨节点调度
3. **本地分配**：内存从线程所在节点分配（`numa_alloc_onnode`）
4. **数据分区**：共享数据按节点分片，消除跨节点访问
5. **监控验证**：`numastat`和`perf`确认远端访问比例下降
6. **收益巨大**：正确优化后性能提升2-3倍很常见

NUMA优化是"多核扩展性"的最后一公里。如果你的服务在16核以上还有性能天花板，先查NUMA拓扑——很可能就是答案。
