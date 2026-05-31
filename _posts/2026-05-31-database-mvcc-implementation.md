---
title: "数据库MVCC实现原理：快照隔离、版本链与垃圾回收"
categories: [数据库]
location: 西安
render_with_liquid: false
---

### 引言

MVCC（Multi-Version Concurrency Control）是现代数据库的核心并发控制机制。它让读操作不阻塞写操作、写操作不阻塞读操作——通过维护数据的多个版本实现。MySQL InnoDB、PostgreSQL、CockroachDB、TiDB都使用MVCC。

本文讲解MVCC的版本链结构、快照读原理、以及如何实现垃圾回收。

---

### 1. 为什么需要MVCC

```
  传统锁方案的问题：

  事务A (读): SELECT * FROM orders WHERE id = 1;
  事务B (写): UPDATE orders SET status = 'paid' WHERE id = 1;

  加锁方案：
  - A持有读锁 → B的写操作必须等A释放
  - B持有写锁 → A的读操作必须等B提交
  - 读写互斥 → 并发度低

  MVCC方案：
  - B写入新版本(paid)，但不删除旧版本(unpaid)
  - A读取时看到的是自己事务开始时的快照版本(unpaid)
  - 读写不互斥 → 并发度高

  代价：存储多个版本，需要垃圾回收旧版本
```

---

### 2. 版本链结构

```
  InnoDB MVCC 版本链（Undo Log实现）：

  当前行数据（最新版本）:
  ┌──────────────────────────────────────────────────────┐
  │ id=1, name="张三", status="paid"                     │
  │ trx_id=100  (创建此版本的事务ID)                     │
  │ roll_pointer → Undo Log                              │
  └────────────────────────────┬─────────────────────────┘
                               │ (指向上一个版本)
                               ▼
  Undo Log (旧版本1):
  ┌──────────────────────────────────────────────────────┐
  │ id=1, name="张三", status="unpaid"                   │
  │ trx_id=90                                            │
  │ roll_pointer → 更旧版本                               │
  └────────────────────────────┬─────────────────────────┘
                               │
                               ▼
  Undo Log (旧版本2):
  ┌──────────────────────────────────────────────────────┐
  │ id=1, name="张三", status="created"                  │
  │ trx_id=80                                            │
  │ roll_pointer → NULL (最初版本)                        │
  └──────────────────────────────────────────────────────┘

  事务读取时：沿版本链找到第一个对自己"可见"的版本
```

---

### 3. 可见性判断（Read View）

```
  Read View（快照）创建时记录：
  - m_ids: 当前活跃（未提交）的事务ID列表
  - min_trx_id: 活跃事务中最小的ID
  - max_trx_id: 下一个将分配的事务ID（即当前最大ID+1）
  - creator_trx_id: 创建此ReadView的事务ID

  可见性规则（判断某版本trx_id是否对当前事务可见）：

  1. trx_id == creator_trx_id → 可见（自己修改的）
  2. trx_id < min_trx_id → 可见（创建ReadView前已提交）
  3. trx_id >= max_trx_id → 不可见（创建ReadView后才开始的事务）
  4. min_trx_id <= trx_id < max_trx_id:
     - trx_id 在 m_ids 中 → 不可见（事务还活跃，未提交）
     - trx_id 不在 m_ids 中 → 可见（已经提交了）
```

```cpp
struct ReadView {
    std::vector<uint64_t> active_trx_ids;  // 创建时活跃的事务
    uint64_t min_trx_id;   // 活跃事务最小ID
    uint64_t max_trx_id;   // 下一个将分配的事务ID
    uint64_t creator_trx_id;

    bool isVisible(uint64_t trx_id) const {
        // 规则1: 自己的修改
        if (trx_id == creator_trx_id) return true;
        // 规则2: 已提交的旧事务
        if (trx_id < min_trx_id) return true;
        // 规则3: 将来的事务
        if (trx_id >= max_trx_id) return false;
        // 规则4: 检查是否在活跃列表中
        return std::find(active_trx_ids.begin(), active_trx_ids.end(), trx_id)
               == active_trx_ids.end();  // 不在列表中=已提交=可见
    }
};

// 快照读：沿版本链查找可见版本
Row snapshotRead(const Row& current, const ReadView& view) {
    // 检查当前版本
    if (view.isVisible(current.trx_id)) return current;

    // 沿Undo Log版本链回溯
    UndoRecord* undo = current.roll_pointer;
    while (undo != nullptr) {
        if (view.isVisible(undo->trx_id)) {
            return undo->reconstructRow();
        }
        undo = undo->prev;
    }

    // 没有可见版本（行在此事务开始前不存在）
    return Row::NOT_FOUND;
}
```

---

### 4. 隔离级别与ReadView创建时机

```
  ┌────────────────────┬──────────────────────────────────────────────┐
  │ 隔离级别           │ ReadView 创建时机                             │
  ├────────────────────┼──────────────────────────────────────────────┤
  │ READ COMMITTED     │ 每次SELECT都创建新的ReadView                 │
  │                    │ → 能看到其他事务已提交的修改                  │
  ├────────────────────┼──────────────────────────────────────────────┤
  │ REPEATABLE READ    │ 事务第一次SELECT时创建，后续复用              │
  │ (InnoDB默认)       │ → 整个事务看到一致的快照                     │
  ├────────────────────┼──────────────────────────────────────────────┤
  │ SERIALIZABLE       │ 通过加锁实现，不依赖MVCC                     │
  │                    │ → 读也加共享锁                               │
  └────────────────────┴──────────────────────────────────────────────┘
```

---

### 5. 垃圾回收（Purge）

```
  何时可以删除旧版本？

  条件：没有任何活跃事务需要读取该旧版本
  即：旧版本的trx_id < 所有活跃ReadView的min_trx_id

  InnoDB Purge 线程：
  1. 找到当前最老的活跃ReadView → 其min_trx_id
  2. 所有trx_id < 该min_trx_id的Undo Log版本可安全删除
  3. 后台异步删除（不阻塞前台事务）

  问题：长事务的危害
  ─────────────────
  如果一个事务开启后长时间不提交（如忘记COMMIT的交互式会话）
  → 它的ReadView的min_trx_id很小
  → 所有比它新的Undo版本都不能回收
  → Undo Log持续增长 → 磁盘爆炸！

  监控：
  SELECT trx_id, trx_started, NOW() - trx_started AS duration
  FROM information_schema.innodb_trx
  ORDER BY trx_started;
  -- 找出长时间未提交的事务
```

---

### 6. MVCC 与写写冲突

```
  MVCC解决了读写冲突，但写写冲突仍需要锁：

  事务A: UPDATE orders SET status='paid' WHERE id=1;
  事务B: UPDATE orders SET status='cancelled' WHERE id=1;

  两者都要修改同一行 → 必须串行化：
  - 先执行的获得行锁（X锁）
  - 后执行的等待行锁释放
  - 不能让两个事务都成功修改同一行（会丢失更新）

  InnoDB当前读（Current Read）= 加锁读：
  - SELECT ... FOR UPDATE → X锁
  - SELECT ... LOCK IN SHARE MODE → S锁
  - UPDATE/DELETE → 自动加X锁

  快照读（Snapshot Read）= MVCC读：
  - 普通SELECT → 不加锁，读快照版本
```

---

### 7. 实现简化的MVCC引擎

```cpp
#include <map>
#include <vector>
#include <mutex>
#include <atomic>
#include <optional>

// 简化的MVCC存储引擎
class MvccStore {
    struct Version {
        uint64_t trx_id;
        std::string value;
        bool deleted = false;
    };

    // 每个key维护一个版本链（最新在前）
    std::map<std::string, std::vector<Version>> store_;
    std::mutex store_mutex_;

    std::atomic<uint64_t> next_trx_id_{1};
    std::vector<uint64_t> active_transactions_;
    std::mutex trx_mutex_;

public:
    // 开始事务
    uint64_t beginTransaction() {
        uint64_t trx_id = next_trx_id_++;
        std::lock_guard lock(trx_mutex_);
        active_transactions_.push_back(trx_id);
        return trx_id;
    }

    // 创建ReadView
    ReadView createReadView(uint64_t creator_trx_id) {
        std::lock_guard lock(trx_mutex_);
        ReadView view;
        view.creator_trx_id = creator_trx_id;
        view.active_trx_ids = active_transactions_;
        view.min_trx_id = active_transactions_.empty() ? next_trx_id_.load()
                          : *std::min_element(active_transactions_.begin(), active_transactions_.end());
        view.max_trx_id = next_trx_id_.load();
        return view;
    }

    // 快照读
    std::optional<std::string> get(const std::string& key, const ReadView& view) {
        std::lock_guard lock(store_mutex_);
        auto it = store_.find(key);
        if (it == store_.end()) return std::nullopt;

        // 沿版本链找到第一个可见版本
        for (auto& ver : it->second) {
            if (view.isVisible(ver.trx_id)) {
                if (ver.deleted) return std::nullopt;
                return ver.value;
            }
        }
        return std::nullopt;
    }

    // 写入（创建新版本）
    void put(const std::string& key, const std::string& value, uint64_t trx_id) {
        std::lock_guard lock(store_mutex_);
        store_[key].insert(store_[key].begin(), Version{trx_id, value, false});
    }

    // 提交事务
    void commit(uint64_t trx_id) {
        std::lock_guard lock(trx_mutex_);
        active_transactions_.erase(
            std::remove(active_transactions_.begin(), active_transactions_.end(), trx_id),
            active_transactions_.end());
    }

    // 垃圾回收
    void purge() {
        std::lock_guard trx_lock(trx_mutex_);
        uint64_t oldest = active_transactions_.empty() ? next_trx_id_.load()
                         : *std::min_element(active_transactions_.begin(), active_transactions_.end());

        std::lock_guard store_lock(store_mutex_);
        for (auto& [key, versions] : store_) {
            // 保留最新的可见版本 + 所有比oldest新的版本
            // 删除所有比oldest旧且不是最新可见版本的
            while (versions.size() > 1 && versions.back().trx_id < oldest) {
                versions.pop_back();
            }
        }
    }
};
```

---

### 总结

MVCC的核心：

1. **多版本共存**：写操作创建新版本，旧版本通过Undo Log/版本链保留
2. **ReadView决定可见性**：根据事务ID和活跃事务列表判断哪个版本可见
3. **读不阻塞写**：读走MVCC快照，写加行锁，互不干扰
4. **隔离级别=ReadView时机**：RC每次SELECT新建，RR只第一次创建
5. **Purge回收旧版本**：没有活跃事务需要的旧版本可以安全删除
6. **长事务是MVCC杀手**：阻止Undo Log回收，导致空间膨胀

理解MVCC后，很多数据库行为变得清晰："为什么RR级别下看不到别人的提交？""为什么长事务导致Undo膨胀？""为什么UPDATE要加锁但SELECT不用？"——答案都在MVCC机制中。
