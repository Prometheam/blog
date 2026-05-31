---
title: "工作流引擎设计：状态机编排、补偿与Temporal实践"
categories: [架构设计]
location: 西安
render_with_liquid: false
---

### 引言

很多业务流程不是"一步完成"，而是"多步编排"：用户注册 → 发验证邮件 → 等待点击 → 激活账号 → 发欢迎优惠券。其中任何一步可能失败、超时、需要人工审批。这就是工作流问题。

硬编码这些流程到业务代码中，会导致状态管理混乱、异常处理遗漏、流程变更困难。工作流引擎将"流程编排"从业务逻辑中抽离出来，让开发者只关注每一步"做什么"，引擎负责"什么时候做、失败了怎么办"。

---

### 1. 为什么需要工作流引擎

```
  没有工作流引擎（硬编码流程）：

  void processOrder(Order order) {
      createOrder(order);                    // 步骤1
      if (!deductInventory(order)) {         // 步骤2
          cancelOrder(order);                // 手动补偿
          return;
      }
      if (!chargePayment(order)) {           // 步骤3
          restoreInventory(order);           // 手动补偿
          cancelOrder(order);                // 手动补偿
          return;
      }
      sendConfirmation(order);               // 步骤4
      // 如果这里失败了呢？已扣款怎么办？
      // 如果中间服务重启了呢？执行到哪一步了？
  }

  问题：
  - 流程状态丢失（服务重启后不知道执行到哪了）
  - 补偿逻辑散落各处（每加一步要加N个补偿分支）
  - 超时/重试/人工介入 → 复杂度爆炸
  - 流程可视化困难（没有全局视图）
```

```
  有工作流引擎：

  ┌──────────────────────────────────────────────────────────┐
  │  工作流定义（声明式）：                                    │
  │                                                          │
  │  OrderWorkflow:                                          │
  │    Step1: createOrder     → 补偿: cancelOrder            │
  │    Step2: deductInventory → 补偿: restoreInventory       │
  │    Step3: chargePayment   → 补偿: refundPayment          │
  │    Step4: sendConfirmation                               │
  │                                                          │
  │  引擎负责：                                               │
  │  ✅ 状态持久化（重启后恢复执行）                          │
  │  ✅ 自动重试（失败后按策略重试）                          │
  │  ✅ 超时处理（步骤超时触发补偿/告警）                     │
  │  ✅ 补偿编排（失败后自动逆序补偿）                        │
  │  ✅ 可视化（Dashboard看到每个流程的状态）                  │
  └──────────────────────────────────────────────────────────┘
```

---

### 2. 工作流引擎核心概念

```
  ┌──────────────┬──────────────────────────────────────────────┐
  │ 概念         │ 说明                                         │
  ├──────────────┼──────────────────────────────────────────────┤
  │ Workflow     │ 一个完整的业务流程定义                        │
  ├──────────────┼──────────────────────────────────────────────┤
  │ Activity     │ 工作流中的一个步骤（一个函数/RPC调用）       │
  ├──────────────┼──────────────────────────────────────────────┤
  │ Instance     │ 工作流的一次运行实例                          │
  ├──────────────┼──────────────────────────────────────────────┤
  │ State        │ 实例当前的执行状态（哪步完成了/哪步在等）    │
  ├──────────────┼──────────────────────────────────────────────┤
  │ Signal/Event │ 外部事件（如用户点击确认）                    │
  ├──────────────┼──────────────────────────────────────────────┤
  │ Timer        │ 定时触发（超时/定时任务）                     │
  ├──────────────┼──────────────────────────────────────────────┤
  │ Compensation │ 步骤失败时的回滚操作                          │
  └──────────────┴──────────────────────────────────────────────┘
```

---

### 3. 状态机实现

```cpp
#include <string>
#include <vector>
#include <functional>
#include <unordered_map>
#include <variant>
#include <optional>
#include <chrono>

// 活动定义
struct ActivityDef {
    std::string name;
    std::function<Result<std::string>(const std::string& input)> execute;
    std::function<Result<void>(const std::string& input)> compensate;  // 可选补偿
    int max_retries = 3;
    std::chrono::seconds timeout{30};
};

// 步骤执行结果
enum class StepStatus { PENDING, RUNNING, COMPLETED, FAILED, COMPENSATED };

struct StepState {
    std::string activity_name;
    StepStatus status = StepStatus::PENDING;
    std::string output;
    int retry_count = 0;
    std::chrono::system_clock::time_point started_at;
    std::string error;
};

// 工作流实例
struct WorkflowInstance {
    std::string id;
    std::string workflow_name;
    std::string input;
    std::vector<StepState> steps;
    enum class Status { RUNNING, COMPLETED, FAILED, COMPENSATING } status;
    std::chrono::system_clock::time_point created_at;
};

// 工作流引擎
class WorkflowEngine {
public:
    // 注册工作流定义
    void registerWorkflow(const std::string& name, std::vector<ActivityDef> activities) {
        workflows_[name] = std::move(activities);
    }

    // 启动工作流实例
    std::string startWorkflow(const std::string& workflow_name, const std::string& input) {
        auto& activities = workflows_.at(workflow_name);

        WorkflowInstance instance;
        instance.id = generateId();
        instance.workflow_name = workflow_name;
        instance.input = input;
        instance.status = WorkflowInstance::Status::RUNNING;
        instance.created_at = std::chrono::system_clock::now();

        for (auto& act : activities) {
            instance.steps.push_back({act.name, StepStatus::PENDING});
        }

        instances_[instance.id] = instance;
        persistState(instance);  // 持久化到DB

        // 开始执行
        executeNext(instance.id);
        return instance.id;
    }

    // 执行下一步
    void executeNext(const std::string& instance_id) {
        auto& instance = instances_[instance_id];
        auto& activities = workflows_[instance.workflow_name];

        for (size_t i = 0; i < instance.steps.size(); i++) {
            auto& step = instance.steps[i];
            if (step.status != StepStatus::PENDING) continue;

            step.status = StepStatus::RUNNING;
            step.started_at = std::chrono::system_clock::now();
            persistState(instance);

            // 获取上一步的输出作为输入
            std::string step_input = (i == 0) ? instance.input : instance.steps[i-1].output;

            auto result = activities[i].execute(step_input);

            if (result.isOk()) {
                step.status = StepStatus::COMPLETED;
                step.output = result.value();
                persistState(instance);
                // 继续下一步
            } else {
                step.retry_count++;
                if (step.retry_count < activities[i].max_retries) {
                    step.status = StepStatus::PENDING;  // 重试
                    persistState(instance);
                    scheduleRetry(instance_id, i);
                } else {
                    step.status = StepStatus::FAILED;
                    step.error = result.error().userMessage();
                    persistState(instance);
                    // 触发补偿
                    startCompensation(instance_id, i);
                }
                return;
            }
        }

        // 所有步骤完成
        instance.status = WorkflowInstance::Status::COMPLETED;
        persistState(instance);
    }

    // 补偿（逆序执行已完成步骤的补偿操作）
    void startCompensation(const std::string& instance_id, size_t failed_step) {
        auto& instance = instances_[instance_id];
        auto& activities = workflows_[instance.workflow_name];
        instance.status = WorkflowInstance::Status::COMPENSATING;

        for (int i = static_cast<int>(failed_step) - 1; i >= 0; i--) {
            if (instance.steps[i].status == StepStatus::COMPLETED &&
                activities[i].compensate) {
                auto result = activities[i].compensate(instance.steps[i].output);
                if (result.isOk()) {
                    instance.steps[i].status = StepStatus::COMPENSATED;
                } else {
                    // 补偿失败 → 告警 + 人工介入
                    alertHumanIntervention(instance_id, i);
                }
            }
        }

        instance.status = WorkflowInstance::Status::FAILED;
        persistState(instance);
    }

    // 查询实例状态
    std::optional<WorkflowInstance> getStatus(const std::string& id) {
        auto it = instances_.find(id);
        if (it != instances_.end()) return it->second;
        return std::nullopt;
    }

private:
    void persistState(const WorkflowInstance& instance) { /* 写DB */ }
    void scheduleRetry(const std::string& id, size_t step) { /* 延迟重试 */ }
    void alertHumanIntervention(const std::string& id, int step) { /* 告警 */ }
    std::string generateId() { return "wf-" + std::to_string(next_id_++); }

    std::unordered_map<std::string, std::vector<ActivityDef>> workflows_;
    std::unordered_map<std::string, WorkflowInstance> instances_;
    uint64_t next_id_ = 1;
};
```

---

### 4. 使用示例：订单处理工作流

```cpp
// 定义工作流
engine.registerWorkflow("order_process", {
    {
        "create_order",
        [](const std::string& input) -> Result<std::string> {
            auto order = OrderService::create(parseJson(input));
            return Result<std::string>::ok(order.toJson());
        },
        [](const std::string& output) -> Result<void> {
            OrderService::cancel(parseJson(output).id);
            return Result<void>::ok({});
        },
        .max_retries = 3,
        .timeout = std::chrono::seconds(10)
    },
    {
        "deduct_inventory",
        [](const std::string& input) -> Result<std::string> {
            auto order = parseJson(input);
            InventoryService::deduct(order.product_id, order.quantity);
            return Result<std::string>::ok(input);
        },
        [](const std::string& output) -> Result<void> {
            auto order = parseJson(output);
            InventoryService::restore(order.product_id, order.quantity);
            return Result<void>::ok({});
        }
    },
    {
        "charge_payment",
        [](const std::string& input) -> Result<std::string> {
            auto order = parseJson(input);
            auto payment = PaymentService::charge(order.user_id, order.amount);
            return Result<std::string>::ok(payment.toJson());
        },
        [](const std::string& output) -> Result<void> {
            auto payment = parseJson(output);
            PaymentService::refund(payment.id);
            return Result<void>::ok({});
        }
    },
    {
        "send_notification",
        [](const std::string& input) -> Result<std::string> {
            NotificationService::send(parseJson(input).user_id, "订单已确认");
            return Result<std::string>::ok(input);
        },
        nullptr,  // 通知不需要补偿
        .max_retries = 1
    }
});

// 启动
auto instance_id = engine.startWorkflow("order_process", orderRequest.toJson());

// 查询状态
auto status = engine.getStatus(instance_id);
// status->steps[0].status == COMPLETED
// status->steps[1].status == RUNNING
// ...
```

---

### 5. Temporal/Cadence：生产级工作流平台

```
  Temporal 架构：

  ┌─────────────────────────────────────────────────────────────────┐
  │                     Temporal Server                              │
  │  ┌──────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
  │  │ Frontend │  │ History Svc  │  │ Matching Svc             │ │
  │  │ (API)    │  │ (状态管理)   │  │ (任务调度/分发)          │ │
  │  └──────────┘  └──────────────┘  └──────────────────────────┘ │
  │                        │                                        │
  │                   ┌────▼────┐                                   │
  │                   │ DB      │ (Cassandra/MySQL/PostgreSQL)      │
  │                   └─────────┘                                   │
  └─────────────────────────────────────────────────────────────────┘
                              │
                    Task Queue │
                              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                     Worker (你的应用)                             │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │ Workflow Function:                                        │  │
  │  │   result1 = await activity("create_order", input)       │  │
  │  │   result2 = await activity("deduct_inventory", result1) │  │
  │  │   result3 = await activity("charge_payment", result2)   │  │
  │  └──────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────┘

  Temporal的核心能力：
  - 工作流状态自动持久化（重启后从断点恢复）
  - Activity自动重试（可配策略）
  - 定时器/等待外部事件（Signal）
  - 版本化（工作流代码升级不影响在途实例）
  - 可视化Dashboard（看到每个实例的执行历史）
```

---

### 6. 工作流引擎选型

```
  ┌──────────────────┬──────────────────┬──────────────────────────┐
  │ 方案             │ 适用场景         │ 特点                      │
  ├──────────────────┼──────────────────┼──────────────────────────┤
  │ Temporal         │ 通用微服务编排   │ 代码即工作流，最灵活      │
  ├──────────────────┼──────────────────┼──────────────────────────┤
  │ Apache Airflow   │ 数据ETL流水线   │ DAG定义，Python生态       │
  ├──────────────────┼──────────────────┼──────────────────────────┤
  │ Camunda          │ BPMN业务流程    │ 可视化建模，非技术人员   │
  ├──────────────────┼──────────────────┼──────────────────────────┤
  │ 自研(状态机)     │ 简单流程        │ 轻量可控，但功能有限      │
  ├──────────────────┼──────────────────┼──────────────────────────┤
  │ Saga(MQ驱动)    │ 异步最终一致    │ 简单但缺乏全局视图        │
  └──────────────────┴──────────────────┴──────────────────────────┘

  选型原则：
  - 流程<5步且固定 → 硬编码+Saga足够
  - 流程5-20步/需要等待外部事件 → Temporal/自研引擎
  - 数据ETL → Airflow
  - 需要非技术人员参与设计 → Camunda(BPMN)
```

---

### 总结

工作流引擎的核心价值：

1. **状态持久化**：流程执行到哪一步、每步的结果，全部持久化到DB
2. **自动重试与补偿**：步骤失败后按策略重试，超限后自动逆序补偿
3. **流程与业务分离**：业务开发者只写Activity，编排逻辑由引擎管理
4. **可见性**：Dashboard实时看到每个流程实例的状态（比grep日志好100倍）
5. **长流程支持**：等待人工审批、等待外部回调、定时触发——天然支持
6. **Temporal是当前最佳选择**：代码即工作流，强一致，自动恢复

工作流引擎的本质是把"分布式系统中多步操作的可靠执行"这个通用难题，从业务代码中抽象出来，用专门的基础设施解决。如果你发现自己在手写大量"状态管理+重试+补偿"代码，那就是该引入工作流引擎的信号。
