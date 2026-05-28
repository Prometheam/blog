---
title: "API网关架构设计：认证、限流、路由与可观测性"
categories: [架构设计]
location: 西安
---

### 引言

微服务架构中，客户端面对的不应该是几十个服务地址，而是统一的网关入口。API网关是系统的"门面"：认证鉴权、流量控制、请求路由、协议转换、可观测性——所有横切关注点都在这里统一处理。

我们的系统从单体拆分到微服务时，最初让前端直接调各个服务。结果：认证逻辑在每个服务重复实现、限流策略不统一、跨域配置散落各处。引入API网关后，这些问题一次性解决，各服务专注业务逻辑。

本文系统讲解API网关的核心功能设计，对比主流网关选型，并用C++实现高性能限流器。

---

### 1. API 网关核心功能

```
API网关功能全景：

  Client Request
       │
       ▼
  ┌──────────────────────────────────────────────────────┐
  │                    API Gateway                        │
  │                                                      │
  │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐ │
  │  │认证   │→│限流   │→│路由   │→│转换   │→│观测   │ │
  │  │鉴权   │  │熔断   │  │负载均衡│  │协议   │  │日志   │ │
  │  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘ │
  │                                                      │
  │  横切能力：CORS、请求ID注入、Header改写、灰度分流     │
  └──────────────────────────────────────────────────────┘
       │
       ▼
  ┌─────────┐  ┌─────────┐  ┌─────────┐
  │Service A│  │Service B│  │Service C│
  └─────────┘  └─────────┘  └─────────┘
```

| 功能 | 作用 | 实现要点 |
|------|------|---------|
| 认证鉴权 | 验证请求者身份和权限 | JWT验签、OAuth2、API Key |
| 限流 | 保护后端免受流量洪峰 | 令牌桶、滑动窗口 |
| 路由 | 将请求转发到对应服务 | 路径匹配、Header路由 |
| 负载均衡 | 在多实例间分配请求 | 轮询、加权、最少连接 |
| 熔断 | 下游故障时快速失败 | 错误率阈值、半开探测 |
| 协议转换 | HTTP→gRPC、REST→GraphQL | 请求/响应格式映射 |
| 可观测性 | 全链路追踪、指标收集 | Trace注入、Prometheus |
| 灰度发布 | 按条件路由到新版本 | Header/Cookie/百分比 |

---

### 2. 认证方案对比

| 方案 | 原理 | 适用场景 | 优点 | 缺点 |
|------|------|---------|------|------|
| JWT | 自包含Token，网关本地验签 | 无状态API | 不查DB、水平扩展好 | Token无法主动失效 |
| OAuth2 | 授权框架，支持多种授权方式 | 第三方接入 | 标准化、权限细粒度 | 复杂度高 |
| API Key | 简单密钥认证 | 服务间/开放平台 | 简单直接 | 安全性较低 |
| mTLS | 证书双向认证 | 微服务内部 | 传输层安全 | 证书管理成本 |

#### JWT 在网关中的验证流程

```
JWT验证流程（网关侧）：

  Client                        Gateway                    Service
    │                              │                         │
    │  GET /api/orders             │                         │
    │  Authorization: Bearer xxx   │                         │
    │  ───────────────────────>   │                         │
    │                              │                         │
    │                              │ 1. 解码JWT Header       │
    │                              │ 2. 获取公钥(JWKS缓存)   │
    │                              │ 3. 验证签名             │
    │                              │ 4. 检查exp过期时间      │
    │                              │ 5. 检查issuer/audience  │
    │                              │                         │
    │                              │  ✅ 验证通过            │
    │                              │                         │
    │                              │  转发请求 + 注入头:     │
    │                              │  X-User-Id: 12345      │
    │                              │  X-User-Role: admin    │
    │                              │  ────────────────────> │
    │                              │                         │
    │                              │  <─── 200 + 响应 ───── │
    │  <───── 200 + 响应 ─────── │                         │
```

---

### 3. 限流算法深度

#### 3.1 令牌桶（Token Bucket）

```
令牌桶原理：

  ┌─────────────────────────┐
  │       令牌桶             │
  │  容量(burst): 100       │  ← 最大突发量
  │  当前令牌: 73           │
  │                         │
  │  ┌───────────────────┐  │
  │  │ ○ ○ ○ ○ ○ ○ ○ ... │  │  ← 令牌
  │  └───────────────────┘  │
  │                         │
  │  补充速率: 10个/秒      │  ← 稳态QPS
  └─────────────────────────┘
        │
        ▼
  请求到达 → 消耗1个令牌 → 放行
  请求到达 → 桶空 → 拒绝(429)

  特点：
  - 允许短暂突发（burst大小）
  - 长期速率恒定（rate限制）
  - 适合：对用户友好，允许短暂高峰
```

#### 3.2 滑动窗口（Sliding Window Log）

```
滑动窗口原理（精确版）：

  时间轴: ────────────────────────────────────>
  窗口大小: 1秒
  限制: 10次/秒

  当前时刻 T，回顾 [T-1s, T] 内的请求数：

  T-1s                              T
   │  x  x  x  x  x  x  x  x  x  │ x ← 新请求
   │  1  2  3  4  5  6  7  8  9  │ 10
   └──────── 窗口内已有9次 ─────────┘

  9 < 10 → 放行第10次

  下一个请求：
  T-1s                              T
   │     x  x  x  x  x  x  x  x  x│ x ← 新请求
   │     2  3  4  5  6  7  8  9  10│ 11
   └──────── 窗口内已有10次 ────────┘

  10 >= 10 → 拒绝！(429 Too Many Requests)
```

#### 3.3 C++ 高性能限流器实现

```cpp
#include <chrono>
#include <mutex>
#include <atomic>
#include <unordered_map>

// 令牌桶限流器
class TokenBucket {
public:
    TokenBucket(double rate, double burst)
        : rate_(rate), burst_(burst), tokens_(burst),
          last_time_(std::chrono::steady_clock::now()) {}
    
    // 尝试消耗n个令牌，返回是否成功
    bool tryConsume(double n = 1.0) {
        std::lock_guard<std::mutex> lock(mtx_);
        refill();
        if (tokens_ >= n) {
            tokens_ -= n;
            return true;
        }
        return false;
    }
    
    // 获取当前可用令牌数
    double available() const {
        std::lock_guard<std::mutex> lock(mtx_);
        return tokens_;
    }

private:
    void refill() {
        auto now = std::chrono::steady_clock::now();
        double elapsed = std::chrono::duration<double>(now - last_time_).count();
        tokens_ = std::min(burst_, tokens_ + elapsed * rate_);
        last_time_ = now;
    }
    
    double rate_;    // 每秒补充令牌数
    double burst_;   // 桶容量（最大突发）
    double tokens_;  // 当前令牌数
    std::chrono::steady_clock::time_point last_time_;
    mutable std::mutex mtx_;
};

// 滑动窗口限流器（精确版）
class SlidingWindowLog {
public:
    SlidingWindowLog(int max_requests, std::chrono::seconds window)
        : max_requests_(max_requests), window_(window) {}
    
    bool tryPass() {
        std::lock_guard<std::mutex> lock(mtx_);
        auto now = std::chrono::steady_clock::now();
        
        // 清理窗口外的旧记录
        while (!timestamps_.empty() && now - timestamps_.front() > window_) {
            timestamps_.pop_front();
        }
        
        if (static_cast<int>(timestamps_.size()) < max_requests_) {
            timestamps_.push_back(now);
            return true;
        }
        return false;
    }

private:
    int max_requests_;
    std::chrono::seconds window_;
    std::deque<std::chrono::steady_clock::time_point> timestamps_;
    std::mutex mtx_;
};

// 分布式限流器（基于Redis Lua脚本的令牌桶）
// 适用于多实例网关共享限流配额
class DistributedRateLimiter {
public:
    // Redis Lua脚本（原子操作）
    static constexpr const char* LUA_SCRIPT = R"(
        local key = KEYS[1]
        local rate = tonumber(ARGV[1])
        local burst = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local requested = tonumber(ARGV[4])
        
        local data = redis.call('hmget', key, 'tokens', 'last_time')
        local tokens = tonumber(data[1]) or burst
        local last_time = tonumber(data[2]) or now
        
        -- 计算补充的令牌
        local elapsed = now - last_time
        tokens = math.min(burst, tokens + elapsed * rate)
        
        local allowed = tokens >= requested
        if allowed then
            tokens = tokens - requested
        end
        
        redis.call('hmset', key, 'tokens', tokens, 'last_time', now)
        redis.call('expire', key, math.ceil(burst / rate) + 1)
        
        return allowed and 1 or 0
    )";
    
    // 在实际使用中通过Redis客户端调用此脚本
};

// 多维限流策略管理器
class RateLimitManager {
public:
    struct Policy {
        double rate;   // 每秒允许请求数
        double burst;  // 最大突发
    };
    
    // 按不同维度限流
    bool checkLimit(const std::string& user_id,
                    const std::string& api_path,
                    const std::string& client_ip) {
        // 用户级限流
        auto& user_bucket = getUserBucket(user_id);
        if (!user_bucket.tryConsume()) {
            return false;  // 429: 用户请求过快
        }
        
        // API级限流（某些API配额更低）
        auto& api_bucket = getApiBucket(api_path);
        if (!api_bucket.tryConsume()) {
            return false;  // 429: 该API超限
        }
        
        // IP级限流（防爬虫）
        auto& ip_bucket = getIpBucket(client_ip);
        if (!ip_bucket.tryConsume()) {
            return false;  // 429: IP请求过快
        }
        
        return true;
    }

private:
    TokenBucket& getUserBucket(const std::string& user_id) {
        std::lock_guard lock(mtx_);
        auto [it, _] = user_buckets_.try_emplace(
            user_id, user_policy_.rate, user_policy_.burst);
        return it->second;
    }
    
    TokenBucket& getApiBucket(const std::string& path) {
        std::lock_guard lock(mtx_);
        auto policy = api_policies_.count(path) ? api_policies_[path] : default_policy_;
        auto [it, _] = api_buckets_.try_emplace(path, policy.rate, policy.burst);
        return it->second;
    }
    
    TokenBucket& getIpBucket(const std::string& ip) {
        std::lock_guard lock(mtx_);
        auto [it, _] = ip_buckets_.try_emplace(
            ip, ip_policy_.rate, ip_policy_.burst);
        return it->second;
    }
    
    Policy user_policy_{100, 200};     // 用户：100QPS，突发200
    Policy ip_policy_{50, 100};        // IP：50QPS，突发100
    Policy default_policy_{1000, 2000}; // API默认：1000QPS
    
    std::unordered_map<std::string, Policy> api_policies_;
    std::unordered_map<std::string, TokenBucket> user_buckets_;
    std::unordered_map<std::string, TokenBucket> api_buckets_;
    std::unordered_map<std::string, TokenBucket> ip_buckets_;
    std::mutex mtx_;
};
```

---

### 4. 灰度发布策略

| 策略 | 实现 | 适用场景 |
|------|------|---------|
| 金丝雀 | 1-5%流量到新版本 | 新功能初始验证 |
| 蓝绿部署 | 两套环境瞬间切换 | 需要快速回滚 |
| A/B测试 | 按用户属性分流 | 功能对比实验 |
| Header路由 | 特定Header路由到新版本 | 开发测试 |

```
网关灰度路由配置示例：

  规则优先级（从高到低）：
  
  1. Header: X-Version=v2 → route to service-v2 (开发者测试)
  2. Cookie: beta=true → route to service-v2 (内测用户)
  3. User-Id % 100 < 5 → route to service-v2 (5%灰度)
  4. Default → route to service-v1 (正常流量)
```

---

### 5. 网关选型对比

| 维度 | Kong | Envoy | APISIX | 自研 |
|------|------|-------|--------|------|
| 语言 | Lua/Go | C++ | Lua(OpenResty) | - |
| 性能 | 高 | **极高** | 高 | 依实现 |
| 插件生态 | **最丰富** | 中等 | 丰富 | 按需 |
| 控制面 | Kong Admin API | xDS(Istio等) | Dashboard | 自建 |
| 服务网格 | 不擅长 | **原生支持** | 不擅长 | - |
| 学习成本 | 低 | 高 | 中 | 高 |
| 适用规模 | 中大型 | 大型/云原生 | 中大型 | 特殊需求 |
| 动态配置 | ✅ | ✅ (xDS) | ✅ (etcd) | 按需 |

**选型建议**：
- K8s服务网格 → **Envoy**（Istio数据面）
- 传统架构/快速上手 → **Kong**（插件丰富、社区活跃）
- 高性能+国产 → **APISIX**（基于OpenResty，性能接近Envoy）
- 极端定制需求 → 自研（慎重，维护成本高）

---

### 6. 网关可观测性

网关是注入观测信号的最佳位置：

```
网关注入的观测数据：

  Request                                    Response
  ────────>                                 <────────
  
  注入请求ID:                               记录：
  X-Request-Id: uuid-xxx                    • 状态码
  X-Trace-Id: trace-xxx                     • 响应时间
  X-Forwarded-For: client-ip                • 上游服务地址
                                            • 限流/熔断状态
  
  Prometheus指标（在网关统一收集）：
  ┌────────────────────────────────────────┐
  │ gateway_requests_total{                │
  │   service="order-svc",                 │
  │   method="POST",                       │
  │   path="/v1/orders",                   │
  │   status="200"                         │
  │ }                                      │
  │                                        │
  │ gateway_request_duration_seconds{      │
  │   service="order-svc",                 │
  │   quantile="0.99"                      │
  │ } = 0.045                              │
  │                                        │
  │ gateway_rate_limit_rejected_total{     │
  │   user="123", policy="user_limit"      │
  │ }                                      │
  └────────────────────────────────────────┘
```

---

### 7. 429 响应最佳实践

限流拒绝时，应给客户端足够的信息来合理重试：

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 2
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1716980400

{
  "type": "https://api.example.com/errors/rate-limit",
  "title": "Rate Limit Exceeded",
  "status": 429,
  "detail": "You have exceeded 100 requests per minute. Try again in 2 seconds.",
  "retry_after": 2
}
```

| Header | 含义 |
|--------|------|
| `Retry-After` | 建议等待秒数 |
| `X-RateLimit-Limit` | 总配额 |
| `X-RateLimit-Remaining` | 剩余配额 |
| `X-RateLimit-Reset` | 配额重置的Unix时间戳 |

---

### 总结

API网关设计的核心要点：

1. **统一入口**：所有横切关注点（认证、限流、日志）在网关层处理，服务专注业务
2. **限流分层**：IP级防爬虫 + 用户级防滥用 + API级保护关键接口
3. **令牌桶是默认选择**：允许突发但限制长期速率，对用户友好
4. **灰度发布能力**：网关天然适合做流量分配（金丝雀、A/B）
5. **可观测性注入**：请求ID、Trace ID在网关生成，全链路传播
6. **不要过早自研**：Kong/Envoy/APISIX足以覆盖99%需求

网关是系统的"第一道防线"，也是"最后一道兜底"。设计好网关，相当于给整个微服务集群加了一层保险。
