---
title: "分布式事务实战：2PC、TCC与Saga的工程选型"
categories: [架构设计]
location: 西安
render_with_liquid: false
---

### 引言

微服务拆分后，一个业务操作可能跨越多个服务和数据库。"下单"需要同时扣库存、创建订单、扣余额——三个服务，三个数据库，任何一步失败都需要全部回滚。这就是分布式事务问题。

我们的电商系统曾因为没有分布式事务保障，出现过"钱扣了但订单没创建"、"库存扣了但支付失败没回滚"的事故。本文对比三种主流方案（2PC、TCC、Saga），讲解各自的适用场景和C++实现要点。

---

### 1. 分布式事务的核心挑战

```
  单机事务（简单）：
  BEGIN;
    UPDATE accounts SET balance = balance - 100 WHERE user_id = 1;
    INSERT INTO orders (user_id, amount) VALUES (1, 100);
  COMMIT;  -- 要么全成功，要么全回滚

  分布式事务（复杂）：
  Service A (订单):  创建订单
  Service B (库存):  扣减库存          ← 三个独立的数据库
  Service C (支付):  扣减余额          ← 无法用单机COMMIT

  问题：
  - 如果订单创建成功、库存扣减成功、但支付失败？
  - 如何保证三者"要么全成功，要么全回滚"？
  - 网络分区时，部分服务不可达怎么办？
```

---

### 2. 方案对比

```
  ┌────────────────┬────────────┬────────────┬──────────────────┐
  │     维度       │    2PC     │    TCC     │      Saga        │
  ├────────────────┼────────────┼────────────┼──────────────────┤
  │ 一致性         │ 强一致     │ 强一致     │ 最终一致         │
  ├────────────────┼────────────┼────────────┼──────────────────┤
  │ 性能           │ 差(阻塞)  │ 中         │ 好(异步)         │
  ├────────────────┼────────────┼────────────┼──────────────────┤
  │ 业务侵入       │ 无         │ 高(三接口) │ 中(补偿接口)     │
  ├────────────────┼────────────┼────────────┼──────────────────┤
  │ 资源锁定时间   │ 长(整个事务)│ 短(Try阶段)│ 无锁定          │
  ├────────────────┼────────────┼────────────┼──────────────────┤
  │ 实现复杂度     │ 中         │ 高         │ 中               │
  ├────────────────┼────────────┼────────────┼──────────────────┤
  │ 适用场景       │ DB层(XA)   │ 资金/库存  │ 长流程/跨多服务  │
  └────────────────┴────────────┴────────────┴──────────────────┘
```

---

### 3. 2PC（两阶段提交）

```
  2PC 流程：

  Coordinator                    Participant A         Participant B
      │                              │                     │
      │  ─── Phase 1: Prepare ────>  │                     │
      │  ─── Phase 1: Prepare ──────────────────────────>  │
      │                              │                     │
      │  <── Vote: YES ────────────  │                     │
      │  <── Vote: YES ─────────────────────────────────── │
      │                              │                     │
      │  (所有人都Vote YES)           │                     │
      │                              │                     │
      │  ─── Phase 2: Commit ─────>  │                     │
      │  ─── Phase 2: Commit ──────────────────────────>   │
      │                              │                     │
      │  <── ACK ──────────────────  │                     │
      │  <── ACK ──────────────────────────────────────── │

  如果任何参与者Vote NO:
      │  ─── Phase 2: Rollback ───>  │
      │  ─── Phase 2: Rollback ────────────────────────>  │
```

**2PC 的问题**：
- 同步阻塞：Prepare到Commit期间，资源锁定
- 单点故障：Coordinator挂了，参与者不知道该提交还是回滚
- 数据不一致风险：Phase 2部分参与者收到Commit、部分没收到

---

### 4. TCC（Try-Confirm-Cancel）

```
  TCC 三阶段：

  ┌────────────────────────────────────────────────────────────────┐
  │ Try（尝试）：预留资源，不真正执行                               │
  │   - 冻结库存（available-1, frozen+1）                          │
  │   - 冻结余额（balance-100, frozen_amount+100）                 │
  │   - 创建待确认订单（status='pending'）                         │
  ├────────────────────────────────────────────────────────────────┤
  │ Confirm（确认）：所有Try成功后，真正执行                        │
  │   - 扣减冻结库存（frozen-1）                                   │
  │   - 扣减冻结余额（frozen_amount-100）                          │
  │   - 订单状态变为confirmed                                      │
  ├────────────────────────────────────────────────────────────────┤
  │ Cancel（取消）：任一Try失败，回滚已预留的资源                   │
  │   - 释放冻结库存（frozen-1, available+1）                      │
  │   - 释放冻结余额（frozen_amount-100, balance+100）             │
  │   - 订单状态变为cancelled                                      │
  └────────────────────────────────────────────────────────────────┘

  关键特性：
  - Try阶段只"预留"，不真正修改，锁定时间短
  - Confirm/Cancel必须幂等（可能因网络重试被多次调用）
  - 资金场景首选（银行/支付/库存扣减）
```

```cpp
// TCC 接口定义
class TccParticipant {
public:
    virtual ~TccParticipant() = default;

    // Try: 预留资源，返回预留凭证
    virtual Result<std::string> tryAction(const TxContext& ctx) = 0;

    // Confirm: 确认执行（必须幂等）
    virtual Result<void> confirm(const std::string& reservation_id) = 0;

    // Cancel: 取消预留（必须幂等）
    virtual Result<void> cancel(const std::string& reservation_id) = 0;
};

// 库存服务TCC实现
class InventoryTcc : public TccParticipant {
public:
    Result<std::string> tryAction(const TxContext& ctx) override {
        // 冻结库存（不扣减available，而是增加frozen）
        auto reservation_id = generateId();
        db_.execute(
            "UPDATE inventory SET frozen = frozen + ? "
            "WHERE product_id = ? AND available >= ?",
            ctx.quantity, ctx.product_id, ctx.quantity);

        if (db_.affectedRows() == 0) {
            return Result<std::string>::err(Error{ErrorCode::INSUFFICIENT_STOCK, "库存不足"});
        }

        // 记录预留信息（用于Confirm/Cancel）
        db_.execute(
            "INSERT INTO reservations (id, product_id, quantity, status) VALUES (?,?,?,'pending')",
            reservation_id, ctx.product_id, ctx.quantity);

        return Result<std::string>::ok(reservation_id);
    }

    Result<void> confirm(const std::string& reservation_id) override {
        // 幂等检查
        auto reservation = db_.query("SELECT * FROM reservations WHERE id = ?", reservation_id);
        if (reservation.status == "confirmed") return Result<void>::ok({});  // 已确认，幂等返回

        // 扣减frozen（库存正式扣减）
        db_.execute(
            "UPDATE inventory SET frozen = frozen - ?, available = available - ? "
            "WHERE product_id = ?",
            reservation.quantity, reservation.quantity, reservation.product_id);

        db_.execute("UPDATE reservations SET status = 'confirmed' WHERE id = ?", reservation_id);
        return Result<void>::ok({});
    }

    Result<void> cancel(const std::string& reservation_id) override {
        auto reservation = db_.query("SELECT * FROM reservations WHERE id = ?", reservation_id);
        if (reservation.status == "cancelled") return Result<void>::ok({});  // 幂等

        // 释放frozen
        db_.execute(
            "UPDATE inventory SET frozen = frozen - ? WHERE product_id = ?",
            reservation.quantity, reservation.product_id);

        db_.execute("UPDATE reservations SET status = 'cancelled' WHERE id = ?", reservation_id);
        return Result<void>::ok({});
    }
};
```

---

### 5. Saga 模式

```
  Saga：长事务拆分为多个本地事务 + 补偿事务

  正向流程（每步是独立本地事务）：
  T1(创建订单) → T2(扣库存) → T3(扣余额) → 成功

  任何一步失败时，逆序执行补偿：
  T3失败 → C2(恢复库存) → C1(取消订单)

  ┌──────┐    ┌──────┐    ┌──────┐
  │  T1  │───→│  T2  │───→│  T3  │───→ 成功 ✅
  │创建订单│    │扣库存 │    │扣余额 │
  └──────┘    └──────┘    └──────┘
      ↑            ↑            │
      │            │        失败 ↓
  ┌──────┐    ┌──────┐
  │  C1  │←───│  C2  │    ← 逆序补偿
  │取消订单│    │恢复库存│
  └──────┘    └──────┘

  两种编排方式：
  1. 编排式(Choreography): 事件驱动，各服务监听事件自行执行
  2. 协调式(Orchestration): 中央协调器指挥各步骤执行
```

#### Saga 协调器实现

```cpp
// Saga步骤定义
struct SagaStep {
    std::string name;
    std::function<Result<void>(const SagaContext&)> action;      // 正向操作
    std::function<Result<void>(const SagaContext&)> compensate;  // 补偿操作
};

class SagaOrchestrator {
public:
    void addStep(SagaStep step) {
        steps_.push_back(std::move(step));
    }

    Result<void> execute(SagaContext& ctx) {
        std::vector<size_t> completed_steps;

        for (size_t i = 0; i < steps_.size(); i++) {
            auto& step = steps_[i];
            log("Executing step: {}", step.name);

            auto result = step.action(ctx);
            if (result.isErr()) {
                log("Step {} failed: {}", step.name, result.error().userMessage());
                // 逆序补偿已完成的步骤
                compensate(ctx, completed_steps);
                return result;
            }

            completed_steps.push_back(i);
        }

        return Result<void>::ok({});
    }

private:
    void compensate(SagaContext& ctx, const std::vector<size_t>& completed) {
        // 逆序执行补偿
        for (auto it = completed.rbegin(); it != completed.rend(); ++it) {
            auto& step = steps_[*it];
            log("Compensating step: {}", step.name);

            // 补偿必须成功（重试直到成功）
            for (int retry = 0; retry < 10; retry++) {
                auto result = step.compensate(ctx);
                if (result.isOk()) break;
                std::this_thread::sleep_for(std::chrono::seconds(1 << retry));
            }
        }
    }

    std::vector<SagaStep> steps_;
};

// 使用：下单Saga
void createOrderSaga(const OrderRequest& req) {
    SagaOrchestrator saga;
    SagaContext ctx{req};

    saga.addStep({
        "create_order",
        [](auto& ctx) { return orderService.create(ctx); },
        [](auto& ctx) { return orderService.cancel(ctx); }
    });

    saga.addStep({
        "deduct_inventory",
        [](auto& ctx) { return inventoryService.deduct(ctx); },
        [](auto& ctx) { return inventoryService.restore(ctx); }
    });

    saga.addStep({
        "charge_payment",
        [](auto& ctx) { return paymentService.charge(ctx); },
        [](auto& ctx) { return paymentService.refund(ctx); }
    });

    auto result = saga.execute(ctx);
    if (result.isErr()) {
        log("Order saga failed and compensated: {}", result.error().userMessage());
    }
}
```

---

### 6. 幂等性设计

```
  为什么需要幂等？

  网络不可靠 → 超时后不知道对方是否执行 → 重试
  重试 → 可能重复执行 → 必须幂等（执行多次结果与一次相同）

  幂等实现方案：

  ┌───────────────────┬────────────────────────────────────────────┐
  │ 方案              │ 实现                                       │
  ├───────────────────┼────────────────────────────────────────────┤
  │ 唯一业务ID        │ INSERT ... ON DUPLICATE KEY UPDATE         │
  │                   │ 用order_id作为去重键                       │
  ├───────────────────┼────────────────────────────────────────────┤
  │ 幂等表            │ 记录已处理的请求ID                         │
  │                   │ 重复请求查到记录后直接返回上次结果          │
  ├───────────────────┼────────────────────────────────────────────┤
  │ 状态机            │ 只允许合法的状态转换                       │
  │                   │ pending→paid（重复paid请求被忽略）         │
  ├───────────────────┼────────────────────────────────────────────┤
  │ 乐观锁           │ UPDATE ... WHERE version = expected_version │
  │                   │ 版本不匹配说明已被处理                     │
  └───────────────────┴────────────────────────────────────────────┘
```

```cpp
// 幂等表实现
class IdempotencyGuard {
public:
    // 检查请求是否已处理
    std::optional<std::string> checkProcessed(const std::string& idempotency_key) {
        auto result = db_.query(
            "SELECT response FROM idempotency_records WHERE key = ? AND expires_at > NOW()",
            idempotency_key);
        if (result.has_value()) return result->response;
        return std::nullopt;
    }

    // 标记请求已处理
    void markProcessed(const std::string& idempotency_key,
                       const std::string& response,
                       std::chrono::hours ttl = std::chrono::hours(24)) {
        db_.execute(
            "INSERT INTO idempotency_records (key, response, expires_at) "
            "VALUES (?, ?, NOW() + INTERVAL ? HOUR) "
            "ON DUPLICATE KEY UPDATE response = VALUES(response)",
            idempotency_key, response, ttl.count());
    }
};

// 使用
HttpResponse handlePayment(const HttpRequest& req) {
    auto key = req.getHeader("Idempotency-Key");
    if (key.empty()) return {400, "Missing Idempotency-Key"};

    // 检查是否已处理
    auto cached = guard.checkProcessed(key);
    if (cached) return {200, *cached};  // 直接返回上次结果

    // 首次处理
    auto result = processPayment(req);
    guard.markProcessed(key, result.serialize());
    return {200, result.serialize()};
}
```

---

### 7. 选型决策

```
  ┌────────────────────────────────────┬──────────────────────────┐
  │ 场景                               │ 推荐方案                  │
  ├────────────────────────────────────┼──────────────────────────┤
  │ 同一DB的多表操作                   │ 本地事务（不需要分布式）  │
  ├────────────────────────────────────┼──────────────────────────┤
  │ 强一致性 + 同步 + 短事务           │ 2PC/XA                   │
  ├────────────────────────────────────┼──────────────────────────┤
  │ 资金相关（必须精确）               │ TCC                      │
  ├────────────────────────────────────┼──────────────────────────┤
  │ 跨多服务 + 长流程 + 可接受最终一致 │ Saga                     │
  ├────────────────────────────────────┼──────────────────────────┤
  │ 高吞吐 + 弱一致性可接受           │ 本地消息表 + 异步补偿     │
  └────────────────────────────────────┴──────────────────────────┘
```

---

### 总结

分布式事务的核心：

1. **能不分布式就不分布式**：同库操作用本地事务，简单可靠
2. **2PC适合DB层**：XA协议由数据库驱动实现，应用无感知但性能差
3. **TCC适合资金**：精确控制"冻结→确认→取消"，空回滚和悬挂需特殊处理
4. **Saga适合长流程**：异步补偿，最终一致，适合跨多服务的业务编排
5. **幂等性是基础**：任何分布式事务方案都依赖操作的幂等性
6. **补偿不一定能完美回滚**：有些操作补偿后有"痕迹"（如已发的短信收不回来）

分布式事务没有银弹。核心是认清业务对一致性的真实需求——大多数场景"最终一致"就够了，不必追求代价极高的强一致。
