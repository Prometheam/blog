---
title: "事件驱动架构深度：Event Sourcing、CQRS与事件溯源"
categories: [架构设计]
location: 西安
render_with_liquid: false
---

### 引言

传统CRUD架构只保存"当前状态"——用户余额是500元，你不知道它怎么从0变成500的。而事件驱动架构（EDA）保存的是"发生了什么"——充值200、消费100、充值400——当前状态是事件的累积结果。

这种思维转变带来了巨大的工程价值：完整的审计追踪、状态可以随时重建、时间旅行式调试、天然的异步解耦。金融系统、电商交易、游戏服务器——越是状态变更频繁且需要可追溯的系统，越适合事件驱动。

---

### 1. 事件驱动 vs CRUD

```
  CRUD模式：
  ┌─────────────────────────────────────────────────────────────┐
  │  数据库存储"当前状态"                                        │
  │                                                             │
  │  账户表: | id | balance | updated_at |                      │
  │          | 1  | 500     | 2026-05-31 |                      │
  │                                                             │
  │  问题：                                                     │
  │  - 不知道余额怎么变成500的（丢失了历史）                    │
  │  - UPDATE覆盖了之前的值（不可追溯）                         │
  │  - 并发UPDATE需要加锁                                       │
  └─────────────────────────────────────────────────────────────┘

  Event Sourcing模式：
  ┌─────────────────────────────────────────────────────────────┐
  │  事件存储(Event Store)存储"发生了什么"                       │
  │                                                             │
  │  事件流: | seq | event_type    | data          | timestamp  │
  │          | 1   | AccountCreated | {id:1}       | 05-01     │
  │          | 2   | MoneyDeposited | {amount:200} | 05-10     │
  │          | 3   | MoneyWithdrawn | {amount:100} | 05-15     │
  │          | 4   | MoneyDeposited | {amount:400} | 05-31     │
  │                                                             │
  │  当前余额 = replay(事件1→4) = 0+200-100+400 = 500          │
  │                                                             │
  │  优势：                                                     │
  │  - 完整历史（审计/合规）                                    │
  │  - 任意时间点状态重建（时间旅行）                           │
  │  - 只追加不修改（高并发友好）                               │
  │  - 事件可以驱动其他系统（异步解耦）                         │
  └─────────────────────────────────────────────────────────────┘
```

---

### 2. Event Sourcing 核心实现

```cpp
#include <vector>
#include <string>
#include <variant>
#include <functional>
#include <chrono>

// 领域事件定义
struct AccountCreated { std::string account_id; std::string owner; };
struct MoneyDeposited { std::string account_id; double amount; std::string source; };
struct MoneyWithdrawn { std::string account_id; double amount; std::string reason; };
struct AccountFrozen { std::string account_id; std::string reason; };

using DomainEvent = std::variant<AccountCreated, MoneyDeposited, MoneyWithdrawn, AccountFrozen>;

// 事件信封（元数据）
struct EventEnvelope {
    uint64_t sequence;           // 全局序号
    std::string aggregate_id;    // 聚合根ID
    uint64_t version;            // 聚合版本号
    DomainEvent event;           // 领域事件
    std::chrono::system_clock::time_point timestamp;
    std::string correlation_id;  // 关联ID（追踪）
};

// 聚合根：Account
class Account {
    std::string id_;
    std::string owner_;
    double balance_ = 0;
    bool frozen_ = false;
    uint64_t version_ = 0;
    std::vector<DomainEvent> uncommitted_events_;  // 未持久化的新事件

public:
    // 命令：存款
    void deposit(double amount, const std::string& source) {
        if (frozen_) throw std::runtime_error("Account is frozen");
        if (amount <= 0) throw std::invalid_argument("Amount must be positive");

        // 不直接修改状态，而是产生事件
        apply(MoneyDeposited{id_, amount, source});
    }

    // 命令：取款
    void withdraw(double amount, const std::string& reason) {
        if (frozen_) throw std::runtime_error("Account is frozen");
        if (amount > balance_) throw std::runtime_error("Insufficient balance");

        apply(MoneyWithdrawn{id_, amount, reason});
    }

    // 从事件流重建状态
    static Account fromHistory(const std::vector<DomainEvent>& events) {
        Account account;
        for (auto& event : events) {
            account.applyEvent(event);
            account.version_++;
        }
        return account;
    }

    // 获取未提交的事件
    const std::vector<DomainEvent>& uncommittedEvents() const { return uncommitted_events_; }
    void markCommitted() { uncommitted_events_.clear(); }

    double balance() const { return balance_; }
    uint64_t version() const { return version_; }

private:
    void apply(DomainEvent event) {
        applyEvent(event);
        uncommitted_events_.push_back(std::move(event));
        version_++;
    }

    // 事件处理器：事件→状态变更（纯函数）
    void applyEvent(const DomainEvent& event) {
        std::visit([this](auto&& e) {
            using T = std::decay_t<decltype(e)>;
            if constexpr (std::is_same_v<T, AccountCreated>) {
                id_ = e.account_id;
                owner_ = e.owner;
            } else if constexpr (std::is_same_v<T, MoneyDeposited>) {
                balance_ += e.amount;
            } else if constexpr (std::is_same_v<T, MoneyWithdrawn>) {
                balance_ -= e.amount;
            } else if constexpr (std::is_same_v<T, AccountFrozen>) {
                frozen_ = true;
            }
        }, event);
    }
};

// 事件存储（追加写）
class EventStore {
public:
    void append(const std::string& aggregate_id, uint64_t expected_version,
                const std::vector<DomainEvent>& events) {
        // 乐观锁：检查版本号防止并发冲突
        uint64_t current_version = getVersion(aggregate_id);
        if (current_version != expected_version) {
            throw std::runtime_error("Concurrency conflict");
        }

        // 追加事件（原子操作）
        for (auto& event : events) {
            store_.push_back({next_seq_++, aggregate_id, ++current_version,
                             event, std::chrono::system_clock::now(), ""});
        }

        // 通知订阅者
        for (auto& subscriber : subscribers_) {
            for (auto& event : events) {
                subscriber(event);
            }
        }
    }

    std::vector<DomainEvent> getEvents(const std::string& aggregate_id) {
        std::vector<DomainEvent> events;
        for (auto& envelope : store_) {
            if (envelope.aggregate_id == aggregate_id) {
                events.push_back(envelope.event);
            }
        }
        return events;
    }

    void subscribe(std::function<void(const DomainEvent&)> handler) {
        subscribers_.push_back(std::move(handler));
    }

private:
    std::vector<EventEnvelope> store_;
    std::vector<std::function<void(const DomainEvent&)>> subscribers_;
    uint64_t next_seq_ = 1;
    uint64_t getVersion(const std::string& id) { /* ... */ return 0; }
};
```

---

### 3. CQRS（命令查询职责分离）

```
  CQRS 架构：

  ┌──────────────────────────────────────────────────────────────┐
  │                                                              │
  │  命令端 (Write Side)          查询端 (Read Side)            │
  │                                                              │
  │  ┌─────────────┐             ┌─────────────────────────┐   │
  │  │ Command     │             │ Query API               │   │
  │  │ (deposit    │             │ (getBalance,            │   │
  │  │  withdraw)  │             │  getTransactionHistory) │   │
  │  └──────┬──────┘             └────────────┬────────────┘   │
  │         │                                  │               │
  │         ▼                                  ▼               │
  │  ┌──────────────┐           ┌──────────────────────────┐   │
  │  │ Event Store  │──事件──→ │ Read Model (投影)         │   │
  │  │ (追加写)     │  异步    │ (物化视图/查询优化表)     │   │
  │  │              │  投影    │                            │   │
  │  │ [Event1]     │          │ accounts_view:            │   │
  │  │ [Event2]     │          │ | id | balance | tx_count │   │
  │  │ [Event3]     │          │ | 1  | 500    | 4        │   │
  │  └──────────────┘           └──────────────────────────┘   │
  └──────────────────────────────────────────────────────────────┘

  核心思想：
  - 写入走Event Store（优化写入：追加写，无锁）
  - 查询走Read Model（优化读取：物化视图，非规范化）
  - 两者通过事件异步同步
  - 写入模型和读取模型可以独立扩展
```

```cpp
// 读模型投影（事件处理器）
class AccountReadModel {
    struct AccountView {
        std::string id;
        std::string owner;
        double balance;
        int transaction_count;
        std::string last_activity;
    };

    std::unordered_map<std::string, AccountView> views_;

public:
    // 订阅事件流，维护读模型
    void handleEvent(const DomainEvent& event) {
        std::visit([this](auto&& e) {
            using T = std::decay_t<decltype(e)>;
            if constexpr (std::is_same_v<T, AccountCreated>) {
                views_[e.account_id] = {e.account_id, e.owner, 0, 0, ""};
            } else if constexpr (std::is_same_v<T, MoneyDeposited>) {
                auto& view = views_[e.account_id];
                view.balance += e.amount;
                view.transaction_count++;
            } else if constexpr (std::is_same_v<T, MoneyWithdrawn>) {
                auto& view = views_[e.account_id];
                view.balance -= e.amount;
                view.transaction_count++;
            }
        }, event);
    }

    // 查询接口（直接从物化视图返回，O(1)）
    std::optional<AccountView> getAccount(const std::string& id) {
        auto it = views_.find(id);
        if (it != views_.end()) return it->second;
        return std::nullopt;
    }
};
```

---

### 4. 快照优化

```
  问题：聚合有100万个事件 → 每次重建要replay100万个事件 → 太慢

  解决：定期保存快照，恢复时从快照+后续事件开始

  ┌────────────────────────────────────────────────────────┐
  │ 事件流: [E1][E2]...[E1000] [Snapshot@1000] [E1001]... │
  │                              ↑                         │
  │                        快照（保存v1000时的完整状态）    │
  │                                                        │
  │ 恢复: 加载Snapshot@1000 → replay E1001到最新           │
  │ 比从E1开始replay快1000倍                               │
  └────────────────────────────────────────────────────────┘

  快照策略：
  - 每N个事件保存一次快照（如每100个事件）
  - 或基于时间（每小时一次）
  - 快照不替代事件（事件是"真相"，快照是"缓存"）
```

---

### 5. 事件驱动的实际应用

| 场景 | 为什么适合事件驱动 |
|------|-------------------|
| 金融交易 | 合规要求完整审计轨迹 |
| 电商订单 | 状态流转复杂(创建→支付→发货→签收) |
| 游戏存档 | 操作回放、反作弊验证 |
| 协作编辑 | 操作日志 → 冲突解决 → 状态合并 |
| 微服务解耦 | 事件驱动跨服务通信 |
| 数据分析 | 事件流→实时聚合→Dashboard |

---

### 6. Event Sourcing 注意事项

| 挑战 | 解决方案 |
|------|---------|
| 事件Schema演进 | 版本化事件 + upcaster（旧事件自动转新格式）|
| 查询复杂度 | CQRS分离：写走事件存储，读走物化视图 |
| 最终一致性 | 接受异步延迟，UI层做乐观更新 |
| 事件风暴定位聚合 | Event Storming工作坊确定事件和聚合边界 |
| 性能（长事件流）| 快照 + 分区（按聚合ID分片）|
| 删除数据(GDPR) | Crypto Shredding（加密事件中的个人数据，删除密钥=删除数据）|

---

### 总结

事件驱动架构的核心：

1. **事件是"事实"**：已发生的事不能修改，只能追加新事件（不可变日志）
2. **状态是事件的投影**：当前状态 = fold(初始状态, 所有事件)
3. **CQRS分离读写**：写入优化（追加写）和读取优化（物化视图）独立进化
4. **异步解耦是天然的**：事件发布后，任意数量的消费者异步处理
5. **时间旅行能力**：回放事件到任意时间点，重建当时的状态
6. **快照解决性能**：定期保存状态快照，避免每次从头replay

Event Sourcing不是所有系统的最优解。简单的CRUD系统用它是过度设计。但对于需要审计追踪、状态可追溯、高并发写入的系统，事件驱动是优雅且强大的架构范式。
