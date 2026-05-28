---
title: "企业级错误处理框架：从错误码规范到全链路错误传播"
categories: [架构设计]
location: 西安
render_with_liquid: false
---

### 引言

"Error: something went wrong"——当用户看到这条错误信息时，他不知道发生了什么；当开发者看到这条日志时，他也不知道从哪里开始排查。这就是错误处理缺乏系统设计的后果。

我们的系统从10个服务增长到50个时，错误处理成了最头痛的问题：每个服务的错误码格式不同、错误信息不统一、跨服务调用时错误上下文丢失、告警噪音巨大但无法定位根因。最终我们花了3个月设计并实施了统一的错误处理框架，这篇文章分享其中的核心设计。

---

### 1. 错误码分层设计

#### 1.1 编码规范

```
错误码结构（32位整数）：

  ┌──────┬──────┬──────┬──────────┐
  │ 级别  │ 服务  │ 模块  │ 具体错误  │
  │ 1位   │ 3位   │ 2位   │ 4位      │
  └──────┴──────┴──────┴──────────┘

  示例: 4-003-02-0001
        │  │    │   │
        │  │    │   └── 具体错误：连接超时
        │  │    └────── 模块：数据库访问层
        │  └─────────── 服务：订单服务(003)
        └────────────── 级别：4=客户端错误

  级别定义：
  1xxx = 信息性（不需要处理）
  2xxx = 成功
  3xxx = 重定向
  4xxx = 客户端错误（调用方应修复）
  5xxx = 服务端错误（被调用方应修复）
```

#### 1.2 服务注册表

| 服务ID | 服务名 | 负责团队 |
|--------|--------|---------|
| 001 | user-svc | 用户团队 |
| 002 | auth-svc | 安全团队 |
| 003 | order-svc | 交易团队 |
| 004 | payment-svc | 支付团队 |
| 005 | inventory-svc | 库存团队 |

#### 1.3 错误码示例

| 错误码 | 含义 | HTTP映射 | 用户提示 |
|--------|------|---------|---------|
| 4-001-01-0001 | 用户不存在 | 404 | "用户不存在" |
| 4-001-01-0002 | 用户已禁用 | 403 | "账号已被禁用，请联系客服" |
| 4-003-01-0001 | 订单金额无效 | 422 | "订单金额必须大于0" |
| 5-003-02-0001 | DB连接超时 | 500 | "服务暂时不可用，请稍后重试" |
| 5-004-01-0001 | 支付渠道异常 | 502 | "支付系统繁忙，请稍后重试" |

---

### 2. C++ 错误处理框架实现

```cpp
#include <string>
#include <optional>
#include <variant>
#include <vector>
#include <memory>
#include <source_location>
#include <format>
#include <chrono>

// 错误码类型
struct ErrorCode {
    uint8_t level;      // 1-5
    uint16_t service;   // 001-999
    uint8_t module;     // 01-99
    uint16_t detail;    // 0001-9999
    
    // 构造完整错误码整数
    uint32_t value() const {
        return level * 10000000 + service * 10000 + module * 100 + detail;
    }
    
    std::string toString() const {
        return std::format("{}-{:03d}-{:02d}-{:04d}", level, service, module, detail);
    }
    
    bool isClientError() const { return level == 4; }
    bool isServerError() const { return level == 5; }
    bool isRetryable() const {
        // 5xx且非逻辑错误通常可重试
        return level == 5 && module != 1;  // module 1 = 业务逻辑
    }
};

// 错误上下文帧（错误链的一环）
struct ErrorFrame {
    std::string message;
    std::string file;
    int line;
    std::string function;
    std::chrono::system_clock::time_point timestamp;
    
    ErrorFrame(std::string msg, std::source_location loc = std::source_location::current())
        : message(std::move(msg)),
          file(loc.file_name()),
          line(loc.line()),
          function(loc.function_name()),
          timestamp(std::chrono::system_clock::now()) {}
};

// 核心错误类型：支持错误链、上下文传播
class Error {
public:
    Error(ErrorCode code, std::string message,
          std::source_location loc = std::source_location::current())
        : code_(code), user_message_(std::move(message)) {
        frames_.emplace_back(user_message_, loc);
    }
    
    // 包装下层错误（构建错误链）
    Error wrap(std::string context,
              std::source_location loc = std::source_location::current()) const {
        Error wrapped = *this;
        wrapped.frames_.emplace_back(std::move(context), loc);
        return wrapped;
    }
    
    // 添加结构化元数据
    Error& with(const std::string& key, const std::string& value) {
        metadata_[key] = value;
        return *this;
    }
    
    // Getters
    ErrorCode code() const { return code_; }
    const std::string& userMessage() const { return user_message_; }
    const std::vector<ErrorFrame>& frames() const { return frames_; }
    
    // 完整错误链（用于日志）
    std::string fullTrace() const {
        std::string trace;
        for (int i = frames_.size() - 1; i >= 0; i--) {
            auto& f = frames_[i];
            trace += std::format("  at {}:{} ({}): {}\n",
                                 f.file, f.line, f.function, f.message);
        }
        return trace;
    }
    
    // 序列化为JSON（用于API响应和日志）
    std::string toJson() const {
        std::string json = std::format(R"({{
  "code": "{}",
  "message": "{}",
  "retryable": {},
  "trace": [)",
            code_.toString(), user_message_, code_.isRetryable() ? "true" : "false");
        
        for (size_t i = 0; i < frames_.size(); i++) {
            auto& f = frames_[i];
            json += std::format(R"(
    {{"msg": "{}", "file": "{}", "line": {}, "func": "{}"}})",
                f.message, f.file, f.line, f.function);
            if (i < frames_.size() - 1) json += ",";
        }
        json += "\n  ]";
        
        if (!metadata_.empty()) {
            json += ",\n  \"metadata\": {";
            bool first = true;
            for (auto& [k, v] : metadata_) {
                if (!first) json += ", ";
                json += std::format(R"("{}": "{}")", k, v);
                first = false;
            }
            json += "}";
        }
        
        json += "\n}";
        return json;
    }

private:
    ErrorCode code_;
    std::string user_message_;
    std::vector<ErrorFrame> frames_;
    std::unordered_map<std::string, std::string> metadata_;
};

// Result类型（类似Rust的Result<T, E>）
template<typename T>
class Result {
public:
    // 成功
    static Result ok(T value) {
        Result r;
        r.data_ = std::move(value);
        return r;
    }
    
    // 失败
    static Result err(Error error) {
        Result r;
        r.data_ = std::move(error);
        return r;
    }
    
    bool isOk() const { return std::holds_alternative<T>(data_); }
    bool isErr() const { return std::holds_alternative<Error>(data_); }
    
    T& value() { return std::get<T>(data_); }
    const T& value() const { return std::get<T>(data_); }
    Error& error() { return std::get<Error>(data_); }
    const Error& error() const { return std::get<Error>(data_); }
    
    // Monadic操作（链式处理）
    template<typename F>
    auto andThen(F&& func) -> Result<decltype(func(std::declval<T>()).value())> {
        if (isOk()) return func(value());
        return Result<decltype(func(std::declval<T>()).value())>::err(error());
    }
    
    template<typename F>
    Result<T> orElse(F&& func) {
        if (isOk()) return *this;
        return func(error());
    }

private:
    std::variant<T, Error> data_;
};
```

---

### 3. 错误传播模式

#### 3.1 层内传播（Wrap模式）

```cpp
// 定义服务级错误码
namespace OrderErrors {
    constexpr ErrorCode DB_TIMEOUT{5, 3, 2, 1};
    constexpr ErrorCode INVALID_AMOUNT{4, 3, 1, 1};
    constexpr ErrorCode INVENTORY_INSUFFICIENT{4, 3, 1, 2};
}

// 数据层
Result<Order> OrderRepository::findById(int64_t id) {
    try {
        auto row = db_.query("SELECT * FROM orders WHERE id = ?", id);
        if (!row) {
            return Result<Order>::err(
                Error(OrderErrors::DB_TIMEOUT, "订单查询失败")
                    .with("order_id", std::to_string(id))
            );
        }
        return Result<Order>::ok(parseOrder(row));
    } catch (const DbException& e) {
        return Result<Order>::err(
            Error(OrderErrors::DB_TIMEOUT, "数据库连接超时")
                .with("order_id", std::to_string(id))
                .with("db_error", e.what())
        );
    }
}

// 服务层：wrap添加上下文
Result<OrderDetail> OrderService::getOrderDetail(int64_t order_id) {
    auto result = repo_.findById(order_id);
    if (result.isErr()) {
        // wrap：保留原始错误，添加服务层上下文
        return Result<OrderDetail>::err(
            result.error().wrap("获取订单详情失败")
        );
    }
    
    auto order = result.value();
    // ... 组装详情
    return Result<OrderDetail>::ok(detail);
}

// 控制器层：转换为HTTP响应
void OrderController::getOrder(const Request& req, Response& res) {
    auto order_id = req.pathParam<int64_t>("id");
    auto result = service_.getOrderDetail(order_id);
    
    if (result.isErr()) {
        auto& err = result.error();
        
        // 日志：输出完整错误链
        SPDLOG_ERROR("Request failed: code={}, trace:\n{}",
                     err.code().toString(), err.fullTrace());
        
        // 响应：只返回用户友好信息
        int http_status = err.code().isClientError() ? 400 : 500;
        res.status(http_status).json({
            {"code", err.code().toString()},
            {"message", err.userMessage()},
            {"retryable", err.code().isRetryable()}
        });
        return;
    }
    
    res.status(200).json(result.value().toJson());
}
```

#### 3.2 跨服务传播

```
跨服务错误传播：

  Order Service                    Payment Service
  ─────────────                    ───────────────
       │                                │
       │  gRPC: chargeOrder()          │
       │  ─────────────────────────>   │
       │                                │
       │                                │  内部错误: 5-004-01-0001
       │                                │  "支付渠道连接超时"
       │                                │
       │  <─── gRPC Status ──────────  │
       │   code: UNAVAILABLE            │
       │   message: "支付系统繁忙"       │
       │   details: {                   │
       │     error_code: "5-004-01-0001"│
       │     retryable: true            │
       │   }                            │
       │                                │
       │  映射为订单服务的错误:          │
       │  5-003-03-0001                 │
       │  "支付处理失败"                 │
       │  cause: "5-004-01-0001"        │
```

gRPC错误传播实现：

```cpp
// 跨服务错误映射
Error mapUpstreamError(const grpc::Status& status,
                       const std::string& upstream_service) {
    // 从gRPC metadata中提取上游错误码
    std::string upstream_code = extractErrorCode(status);
    
    // 映射为本服务的错误码
    ErrorCode local_code;
    if (status.error_code() == grpc::UNAVAILABLE) {
        local_code = {5, 3, 3, 1};  // 上游不可用
    } else if (status.error_code() == grpc::DEADLINE_EXCEEDED) {
        local_code = {5, 3, 3, 2};  // 上游超时
    } else if (status.error_code() == grpc::INVALID_ARGUMENT) {
        local_code = {4, 3, 3, 3};  // 参数错误（客户端问题）
    } else {
        local_code = {5, 3, 3, 9};  // 未知上游错误
    }
    
    return Error(local_code, mapUserMessage(status))
        .with("upstream_service", upstream_service)
        .with("upstream_code", upstream_code)
        .with("grpc_status", std::to_string(status.error_code()));
}
```

---

### 4. 错误与告警关联

不是所有错误都需要告警。建立错误严重度与告警策略的映射：

| 错误级别 | 告警策略 | 通知方式 |
|---------|---------|---------|
| 4xx (客户端错误) | 不告警（除非批量出现） | 仅dashboard |
| 5xx + retryable | 错误率 > 1% 时告警 | IM群通知 |
| 5xx + non-retryable | 立即告警 | 短信+电话 |
| 5xx + 连续3次 | 紧急告警（可能雪崩） | 电话轮呼 |

```cpp
// 错误告警决策器
class ErrorAlertDecider {
public:
    enum class AlertLevel { NONE, LOW, MEDIUM, HIGH, CRITICAL };
    
    AlertLevel decide(const Error& err, const ErrorStats& stats) {
        // 客户端错误通常不告警
        if (err.code().isClientError()) {
            // 但如果突然批量出现，可能是上游问题
            if (stats.recentRate(err.code(), std::chrono::minutes(1)) > 100) {
                return AlertLevel::LOW;
            }
            return AlertLevel::NONE;
        }
        
        // 服务端错误
        if (!err.code().isRetryable()) {
            return AlertLevel::HIGH;  // 不可重试=需要人工介入
        }
        
        // 可重试的服务端错误：看频率
        double error_rate = stats.errorRatePercent(std::chrono::minutes(5));
        if (error_rate > 5.0) return AlertLevel::CRITICAL;
        if (error_rate > 1.0) return AlertLevel::MEDIUM;
        if (error_rate > 0.1) return AlertLevel::LOW;
        
        return AlertLevel::NONE;
    }
};
```

---

### 5. 用户友好的错误信息

内部错误信息 vs 用户看到的信息必须分离：

```cpp
// 错误消息注册表（支持i18n）
class ErrorMessageRegistry {
public:
    void registerMessage(ErrorCode code,
                         const std::string& locale,
                         const std::string& user_message,
                         const std::string& developer_hint = "") {
        messages_[{code.value(), locale}] = {user_message, developer_hint};
    }
    
    std::string getUserMessage(ErrorCode code, const std::string& locale = "zh-CN") {
        auto it = messages_.find({code.value(), locale});
        if (it != messages_.end()) return it->second.user_message;
        
        // fallback到英文
        it = messages_.find({code.value(), "en"});
        if (it != messages_.end()) return it->second.user_message;
        
        return "服务暂时不可用，请稍后重试";  // 最终兜底
    }

private:
    struct Message {
        std::string user_message;
        std::string developer_hint;
    };
    std::map<std::pair<uint32_t, std::string>, Message> messages_;
};

// 注册错误消息
void initErrorMessages(ErrorMessageRegistry& registry) {
    using EC = OrderErrors;
    
    registry.registerMessage(EC::INVALID_AMOUNT, "zh-CN",
        "订单金额必须大于0", "检查前端传入的amount字段");
    registry.registerMessage(EC::INVALID_AMOUNT, "en",
        "Order amount must be greater than 0");
    
    registry.registerMessage(EC::DB_TIMEOUT, "zh-CN",
        "服务暂时不可用，请稍后重试", "检查DB连接池和慢查询");
    registry.registerMessage(EC::DB_TIMEOUT, "en",
        "Service temporarily unavailable, please retry later");
    
    registry.registerMessage(EC::INVENTORY_INSUFFICIENT, "zh-CN",
        "库存不足，请减少购买数量");
}
```

---

### 6. API 错误响应标准格式

统一所有服务的错误响应格式（参考RFC 7807 + 自定义扩展）：

```json
{
  "error": {
    "code": "4-003-01-0002",
    "message": "库存不足，请减少购买数量",
    "type": "https://docs.example.com/errors/4-003-01-0002",
    "retryable": false,
    "details": {
      "requested_qty": 10,
      "available_qty": 3,
      "product_id": "SKU-12345"
    },
    "help_url": "https://docs.example.com/faq/inventory",
    "trace_id": "abc-123-def-456",
    "timestamp": "2026-05-29T10:23:15.234Z"
  }
}
```

| 字段 | 是否必须 | 作用 |
|------|---------|------|
| code | ✅ | 机器可读的错误码 |
| message | ✅ | 用户友好的描述 |
| type | 🟡 | 错误文档URL |
| retryable | ✅ | 客户端是否应重试 |
| details | 🟡 | 结构化错误详情 |
| trace_id | ✅ | 关联日志和追踪 |
| timestamp | ✅ | 错误发生时间 |

---

### 7. 错误处理检查清单

| 检查项 | 具体要求 |
|--------|---------|
| 错误码统一 | 所有服务使用相同的编码规范 |
| 内外分离 | 内部错误信息 ≠ 用户看到的信息 |
| 上下文传播 | 跨服务调用时传递cause chain |
| 可重试标记 | 每个错误明确标记是否可重试 |
| trace_id关联 | 错误响应中包含trace_id，便于排查 |
| 告警分级 | 不同错误触发不同级别告警 |
| 文档化 | 每个错误码有文档说明和解决方案 |
| 不吞异常 | 绝不silently ignore错误 |

---

### 总结

企业级错误处理框架的核心设计：

1. **错误码分层编码**：级别-服务-模块-细节，一看错误码就知道是哪个服务哪层出了什么问题
2. **错误链传播**：每层wrap添加上下文，到最顶层时有完整的"错误路径"
3. **内外消息分离**：内部详细（用于排查），外部友好（用于用户）
4. **retryable必须标记**：客户端据此决定是否重试，减少无谓重试放大故障
5. **与告警联动**：不是所有5xx都要告警，基于频率和可恢复性决策
6. **trace_id串联**：从API响应到日志到追踪，一个ID贯穿全部

好的错误处理不是"catch住不崩就行"，而是让故障发生时，所有角色（用户、开发者、运维）都能快速获得他们需要的信息来做出正确决策。
