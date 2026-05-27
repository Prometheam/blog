---
layout: post_layout
title: "C++单元测试实战：GoogleTest与Mock技巧"
date: 2026-05-27 04:30:00 +0800
categories: [C++语言]
location: 西安
excerpt_separator: "```"
---

九年 C++ 后端开发，我经历过"一个 bugfix 引入三个新 bug"的至暗时刻，也经历过"有测试兜底所以放心重构"的快感。今天聊聊我在实际项目中积累的 GoogleTest + GoogleMock 实践经验。

## 为什么 C++ 后端更需要单元测试

C++ 不像 Java/Go 有运行时安全网，一个野指针、一次越界就是 coredump。加上后端服务通常是长期运行的进程，内存泄漏这类问题可能几天后才暴露。单元测试提供两个核心价值：**回归防护**（改一处不崩其他地方）和**重构信心**（大胆优化数据结构和算法）。

## GoogleTest 基础

最简单的测试用例：

```cpp
#include <gtest/gtest.h>
#include "packet_parser.h"

TEST(PacketParserTest, ParseValidHeader) {
    uint8_t raw[] = {0xAA, 0xBB, 0x00, 0x0C, 0x01};
    auto header = PacketParser::parseHeader(raw, sizeof(raw));
    EXPECT_EQ(header.magic, 0xAABB);
    EXPECT_EQ(header.length, 12);
    EXPECT_EQ(header.type, 1);
}

TEST(PacketParserTest, RejectShortBuffer) {
    uint8_t raw[] = {0xAA, 0xBB};
    EXPECT_THROW(PacketParser::parseHeader(raw, 2), ParseError);
}
```

**EXPECT vs ASSERT**：EXPECT 失败后继续执行后面的断言，ASSERT 失败则直接终止当前函数。我的原则是：前置条件用 ASSERT（后面的断言依赖它），独立检查用 EXPECT（尽可能多地暴露问题）。

## Test Fixture：管理测试状态

当多个测试用例共享初始化逻辑时，使用 TEST_F：

```cpp
class ConnectionPoolTest : public ::testing::Test {
protected:
    void SetUp() override {
        pool_ = std::make_unique<ConnectionPool>(config_);
        pool_->init();
    }
    void TearDown() override {
        pool_->shutdown();
    }

    PoolConfig config_{.max_conns = 10, .timeout_ms = 100};
    std::unique_ptr<ConnectionPool> pool_;
};

TEST_F(ConnectionPoolTest, AcquireReturnsValidConnection) {
    auto conn = pool_->acquire();
    ASSERT_NE(conn, nullptr);
    EXPECT_TRUE(conn->isAlive());
}

TEST_F(ConnectionPoolTest, ExhaustPoolReturnsNull) {
    std::vector<Connection*> conns;
    for (int i = 0; i < 10; i++)
        conns.push_back(pool_->acquire());
    EXPECT_EQ(pool_->acquire(), nullptr);  // 池耗尽
}
```

生命周期：每个 TEST_F 都会创建新的 fixture 实例，调用 SetUp → 测试体 → TearDown → 析构。测试之间完全隔离。

## GoogleMock：隔离外部依赖

后端服务最大的测试难题是外部依赖（数据库、网络、文件系统）。核心思路：通过接口抽象 + 依赖注入实现隔离。

```cpp
// 抽象接口
class IRedisClient {
public:
    virtual ~IRedisClient() = default;
    virtual std::optional<std::string> get(const std::string& key) = 0;
    virtual bool set(const std::string& key, const std::string& val,
                     int ttl_sec) = 0;
};

// Mock 类
class MockRedisClient : public IRedisClient {
public:
    MOCK_METHOD(std::optional<std::string>, get, (const std::string&), (override));
    MOCK_METHOD(bool, set, (const std::string&, const std::string&, int), (override));
};

// 测试用例
TEST(SessionManagerTest, LoadSessionFromCache) {
    MockRedisClient mock_redis;
    SessionManager mgr(&mock_redis);

    EXPECT_CALL(mock_redis, get("session:abc123"))
        .WillOnce(Return(std::optional<std::string>("{\"uid\":42}")));

    auto session = mgr.loadSession("abc123");
    ASSERT_TRUE(session.has_value());
    EXPECT_EQ(session->uid, 42);
}
```

常用 Matcher 和 Action：

```cpp
// Matcher：匹配参数
EXPECT_CALL(mock, send(StartsWith("GET "), Gt(0)));
EXPECT_CALL(mock, query(HasSubstr("WHERE id")));

// Action：控制返回值
.WillOnce(Return(OK))
.WillRepeatedly(Invoke([](auto& key) { return std::nullopt; }))
.WillOnce(DoAll(SetArgPointee<1>(data), Return(true)));
```

## 测试异步和多线程代码

多线程测试最容易写出 flaky test。我的经验：

```cpp
TEST_F(AsyncWorkerTest, TaskCompletesWithinTimeout) {
    std::promise<int> promise;
    auto future = promise.get_future();

    worker_->submit([&promise]() {
        promise.set_value(doHeavyWork());
    });

    // 用 future 同步等待，设超时避免死等
    ASSERT_EQ(future.wait_for(std::chrono::seconds(5)),
              std::future_status::ready);
    EXPECT_EQ(future.get(), 42);
}
```

原则：**不要 sleep 等结果**，用同步原语（future/condition_variable/latch）明确等待。对于竞态测试，配合 ThreadSanitizer 比写并发测试用例更有效。

## 测试中的时间处理

后端代码经常依赖当前时间（超时、TTL、限流）。注入时钟接口：

```cpp
class IClock {
public:
    virtual ~IClock() = default;
    virtual TimePoint now() = 0;
};

class FakeClock : public IClock {
public:
    TimePoint now() override { return current_; }
    void advance(Duration d) { current_ += d; }
private:
    TimePoint current_{};
};

TEST(RateLimiterTest, AllowsAfterWindowExpires) {
    FakeClock clock;
    RateLimiter limiter(&clock, /*max_req=*/1, /*window=*/1s);

    EXPECT_TRUE(limiter.allow());   // 第1次通过
    EXPECT_FALSE(limiter.allow());  // 超限

    clock.advance(1s);              // 快进1秒
    EXPECT_TRUE(limiter.allow());   // 窗口刷新，再次通过
}
```

## 代码覆盖率：gcov + lcov

```bash
# 编译时加覆盖率标志
g++ -fprofile-arcs -ftest-coverage -O0 -g -o test_runner *.cpp -lgtest

# 运行测试
./test_runner

# 生成报告
lcov --capture --directory . --output-file coverage.info
genhtml coverage.info --output-directory coverage_html
```

我一般要求核心模块行覆盖率 > 80%，分支覆盖率 > 60%。不追求 100%——getter/setter 和纯代理代码测了也没什么价值。

## TDD 实战流程

我并不教条地"先写测试"，但对于复杂逻辑（状态机、协议解析、算法），TDD 确实高效：

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ 写失败的 │───▶│ 写最少的 │───▶│ 重构使其 │──┐
│ 测试(Red)│    │代码(Green)│    │ 整洁     │  │
└──────────┘    └──────────┘    └──────────┘  │
      ▲                                        │
      └────────────────────────────────────────┘
```

## 小结

好的测试应该是**快速、隔离、可重复**的。GoogleTest 提供了测试组织框架，GoogleMock 提供了依赖隔离能力，两者配合再加上 CI 流水线的覆盖率门禁，基本就构建了一个可靠的质量防线。我的建议是：从核心模块开始，逐步建立测试文化，不要试图一次性给整个项目补测试。
