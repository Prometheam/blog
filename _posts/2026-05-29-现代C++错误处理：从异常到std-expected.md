---
layout: post_layout
title: "现代C++错误处理：从异常到std::expected"
date: 2026-05-29 09:00:00 +0800
categories: [C++语言]
location: 西安
excerpt_separator: "```"
---

### 引言

C++的错误处理一直是个争议话题。用异常？高性能场景嫌它慢、嫌它不可预测。用错误码？容易被忽略、调用链传播繁琐。我在做网关项目时明确禁用了异常（`-fno-exceptions`），但用错误码写出来的代码充斥着`if (ret != 0) return ret;`，可读性极差。

C++23的`std::expected`终于给出了一个优雅的答案——**值或错误的类型安全容器**，兼具异常的表达力和错误码的可预测性。这篇文章对比三种错误处理范式的优劣，深入`std::expected`的设计与实战用法。

---

### 1. 三种错误处理范式

```
┌──────────────────────────────────────────────────────────────────────┐
│                  C++错误处理三种范式                                    │
├──────────────┬─────────────────────────┬──────────────────────────────┤
│              │ 优点                    │ 缺点                         │
├──────────────┼─────────────────────────┼──────────────────────────────┤
│ 异常         │ 代码简洁（正常路径无噪音）│ 性能不可预测（抛出时很慢）   │
│ (throw/catch)│ 自动传播（不会被忽略）  │ 二进制膨胀（RTTI+unwind表）  │
│              │ 构造函数可报错          │ 不兼容noexcept/嵌入式        │
├──────────────┼─────────────────────────┼──────────────────────────────┤
│ 错误码       │ 零开销（一个int返回）    │ 容易被忽略                   │
│ (return int) │ 完全可预测              │ 调用链传播冗余               │
│              │ 嵌入式/内核友好         │ 无法携带丰富错误信息         │
├──────────────┼─────────────────────────┼──────────────────────────────┤
│ std::expected│ 类型安全（不可忽略）    │ 需要C++23                    │
│ (C++23)      │ 零开销（无异常表）      │ 不如异常简洁（需要处理）     │
│              │ 可组合（monadic操作）   │ 学习曲线                     │
└──────────────┴─────────────────────────┴──────────────────────────────┘
```

---

### 2. 异常的隐藏代价

#### 2.1 性能分析

```
异常的"零成本"是有条件的：
  - 不抛出时：几乎零开销（现代编译器Table-based方案）
  - 抛出时：极其昂贵！需要栈展开（stack unwinding）

抛出异常的开销（x86-64, GCC）：
┌────────────────────────────────────┬──────────────┐
│ 操作                               │ 耗时         │
├────────────────────────────────────┼──────────────┤
│ 正常函数调用+返回                  │ ~2ns         │
│ 抛出+捕获异常（同函数）            │ ~1000ns      │
│ 抛出+捕获异常（跨5层调用栈）       │ ~5000ns      │
│ 抛出+捕获异常（跨10层）            │ ~10000ns     │
└────────────────────────────────────┴──────────────┘

还有隐藏成本：
  - 二进制体积增大10-30%（异常表+RTTI）
  - 指令缓存污染（异常处理代码虽然不执行但占空间）
  - 编译器无法对throw路径做深度优化
```

#### 2.2 哪些场景不能用异常

```
❌ 禁用异常的典型场景：
  1. 嵌入式/实时系统（延迟不可预测）
  2. 游戏引擎（每帧16ms预算，不能有不确定延迟）
  3. 高频交易（纳秒级延迟要求）
  4. Linux内核/驱动（内核不支持异常）
  5. 大型代码库的hot path（Google C++ Style禁用异常）

✅ 适合用异常的场景：
  1. 应用层代码（非性能关键路径）
  2. 构造函数失败（构造函数没有返回值）
  3. 深层调用链中的罕见错误（自动传播方便）
  4. 与标准库/第三方库交互（它们用异常）
```

---

### 3. std::expected（C++23）

#### 3.1 基本用法

```cpp
#include <expected>
#include <string>

std::expected<int, std::string> divide(int a, int b) {
    if (b == 0)
        return std::unexpected("division by zero");
    return a / b;
}

auto result = divide(10, 2);
if (result) {
    std::cout << *result << "\n";  // 5
} else {
    std::cout << result.error() << "\n";
}
```

#### 3.2 Monadic操作（链式调用）

```cpp
using Error = std::string;

std::expected<Connection, Error> connectDB(const Config& cfg);
std::expected<UserInfo, Error> queryUser(Connection& conn, int id);

// 链式调用——错误自动传播
std::expected<Response, Error> processRequest(const Request& req) {
    return connectDB(db_config)
        .and_then([&](Connection& conn) {
            return queryUser(conn, req.user_id);
        })
        .and_then([&](UserInfo& user) -> std::expected<UserInfo, Error> {
            if (!checkPermission(user, req.resource))
                return std::unexpected("permission denied");
            return user;
        })
        .transform([&](UserInfo& user) {
            return buildResponse(user, req);
        });
}
```

#### 3.3 实战：自定义Result类型

```cpp
struct AppError {
    enum Code { NETWORK, TIMEOUT, NOT_FOUND, PERMISSION, INTERNAL };
    Code code;
    std::string message;

    static AppError network(std::string msg) { return {NETWORK, std::move(msg)}; }
    static AppError timeout(std::string msg) { return {TIMEOUT, std::move(msg)}; }
    static AppError notFound(std::string msg) { return {NOT_FOUND, std::move(msg)}; }
};

template<typename T>
using Result = std::expected<T, AppError>;

Result<UserInfo> getUserInfo(int user_id) {
    auto cached = cache_.get(user_id);
    if (cached) return *cached;

    auto db_result = db_.query(user_id);
    if (!db_result)
        return std::unexpected(AppError::notFound(
            "user " + std::to_string(user_id) + " not found"));

    return *db_result;
}
```

---

### 4. 性能对比

```
Benchmark: 解析100万个字符串（10%非法输入）

┌─────────────────────────┬──────────────┬─────────────────────┐
│ 方案                    │ 耗时         │ 说明                │
├─────────────────────────┼──────────────┼─────────────────────┤
│ 异常（10%抛出率）       │ 85ms         │ 抛出路径极慢        │
│ 异常（0.1%抛出率）      │ 12ms         │ 不抛时零开销        │
│ 错误码                  │ 10ms         │ 始终快              │
│ std::expected           │ 11ms         │ 接近错误码          │
└─────────────────────────┴──────────────┴─────────────────────┘

结论：expected ≈ 错误码性能，远优于高错误率场景的异常
```

---

### 5. 选型建议

```
┌──────────────────────────────────────────────────────────────────┐
│              选型决策树                                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  能用C++23？ → 是 → std::expected（首选）                       │
│              → 否 → 禁用异常？ → 是 → 错误码+[[nodiscard]]     │
│                                → 否 → 是hot path？              │
│                                        → 是 → 错误码/optional   │
│                                        → 否 → 异常              │
│                                                                  │
│  混合策略（推荐）：                                              │
│  - 底层库：expected（可组合，可预测）                            │
│  - 应用顶层：异常（catch-all兜底）                              │
│  - 边界转换：expected↔异常                                      │
└──────────────────────────────────────────────────────────────────┘
```

---

### 6. 总结

| 维度 | 异常 | 错误码 | std::expected |
|------|------|--------|---------------|
| 性能（正常）| 零开销 | 零开销 | ~零开销 |
| 性能（错误）| 极差 | 零开销 | 零开销 |
| 可忽略性 | 不可忽略 | 易忽略 | 不可忽略 |
| 错误信息 | 丰富 | 贫乏 | 丰富 |
| 可组合性 | 差 | 差 | 优秀(monadic) |

**实践建议**：如果项目能用C++23，`std::expected`是绝大多数场景的最佳选择——错误码的性能，异常的安全，monadic的优雅。
