---
title: "结构化日志与日志聚合：从printf到可观测性"
categories: [架构设计]
location: 西安
---

### 引言

"在生产环境grep日志找问题"——如果你的故障排查流程仍然停留在这一步，说明日志体系该升级了。

我们的一个服务每天产生约50GB日志，散落在20+台机器上。有一次线上出现间歇性超时，团队花了4小时在各台机器上grep、按时间戳手动关联上下文。如果当时有结构化日志+集中式聚合，10分钟内就能定位。

本文讲解从非结构化日志到结构化日志的演进路径，对比主流日志聚合方案，并用C++ spdlog实现一个生产级的结构化日志方案。

---

### 1. 非结构化 vs 结构化日志

```
非结构化日志（传统方式）：
[2026-05-29 10:23:15.234] [INFO] User 12345 placed order 67890, amount=99.99, items=3

结构化日志（JSON格式）：
{"ts":"2026-05-29T10:23:15.234Z","level":"info","msg":"order_placed",
 "user_id":12345,"order_id":67890,"amount":99.99,"items":3,
 "trace_id":"abc-123","service":"order-svc","host":"prod-03"}
```

| 维度 | 非结构化 | 结构化 |
|------|---------|--------|
| 人类可读 | ✅ 好 | 🟡 需要格式化工具 |
| 机器解析 | ❌ 需要正则（脆弱） | ✅ 标准JSON解析 |
| 字段查询 | ❌ 全文搜索 | ✅ `user_id=12345` 精确查询 |
| 聚合统计 | ❌ 困难 | ✅ `SELECT count(*) WHERE level='error' GROUP BY service` |
| 告警规则 | ❌ 基于关键词 | ✅ 基于字段值 + 阈值 |
| 存储效率 | 🟡 压缩依赖内容 | ✅ 列式存储/索引优化 |
| 上下文关联 | ❌ 手动grep trace_id | ✅ 一键查看完整请求链路 |

**结论**：生产系统应全面使用结构化日志。非结构化日志只适合开发调试阶段。

---

### 2. 日志分级策略

#### 2.1 级别定义

| 级别 | 数值 | 使用场景 | 生产默认 |
|------|------|---------|---------|
| TRACE | 0 | 函数进出、变量值 | ❌ 关闭 |
| DEBUG | 1 | 详细逻辑流程 | ❌ 关闭 |
| INFO | 2 | 关键业务事件（订单创建、用户登录） | ✅ 开启 |
| WARN | 3 | 异常但可恢复（重试成功、降级触发） | ✅ 开启 |
| ERROR | 4 | 失败需关注（DB连接失败、下游超时） | ✅ 开启 |
| FATAL | 5 | 进程即将崩溃 | ✅ 开启 |

#### 2.2 动态日志级别

生产环境默认INFO，排查问题时临时开启DEBUG——无需重启服务：

```cpp
#include <atomic>
#include <spdlog/spdlog.h>

// 全局日志级别（支持运行时动态修改）
std::atomic<spdlog::level::level_enum> g_log_level{spdlog::level::info};

// HTTP接口动态调整日志级别
// PUT /admin/log-level {"level": "debug"}
void setLogLevel(const std::string& level) {
    static const std::unordered_map<std::string, spdlog::level::level_enum> levels = {
        {"trace", spdlog::level::trace},
        {"debug", spdlog::level::debug},
        {"info", spdlog::level::info},
        {"warn", spdlog::level::warn},
        {"error", spdlog::level::err},
    };
    
    auto it = levels.find(level);
    if (it != levels.end()) {
        spdlog::set_level(it->second);
        g_log_level.store(it->second);
        SPDLOG_INFO("Log level changed to: {}", level);
    }
}

// 可选：带自动恢复的临时DEBUG
// 5分钟后自动恢复INFO，防止忘记关闭导致日志量暴增
void enableDebugTemporarily(std::chrono::minutes duration = std::chrono::minutes(5)) {
    spdlog::set_level(spdlog::level::debug);
    std::thread([duration]() {
        std::this_thread::sleep_for(duration);
        spdlog::set_level(spdlog::level::info);
        SPDLOG_INFO("Log level auto-restored to INFO after {} min", duration.count());
    }).detach();
}
```

---

### 3. C++ spdlog 结构化日志实战

spdlog是C++最流行的日志库：零开销（compile-time级别过滤）、高性能（异步模式达数百万条/s）。

#### 3.1 JSON格式化器

```cpp
#include <spdlog/spdlog.h>
#include <spdlog/sinks/rotating_file_sink.h>
#include <spdlog/sinks/stdout_color_sinks.h>
#include <spdlog/pattern_formatter.h>
#include <nlohmann/json.hpp>
#include <chrono>

using json = nlohmann::json;

// 自定义JSON格式化器
class JsonFormatter : public spdlog::custom_flag_formatter {
public:
    void format(const spdlog::details::log_msg& msg,
                const std::tm&, spdlog::memory_buf_t& dest) override {
        // 这里只是flag的一部分，完整实现见下方
    }
    std::unique_ptr<custom_flag_formatter> clone() const override {
        return std::make_unique<JsonFormatter>();
    }
};

// 更实用的方式：自定义sink直接输出JSON
class JsonFileSink : public spdlog::sinks::base_sink<std::mutex> {
public:
    explicit JsonFileSink(const std::string& filename)
        : file_(filename, std::ios::app) {}

protected:
    void sink_it_(const spdlog::details::log_msg& msg) override {
        json log_entry;
        
        // 时间戳（ISO 8601格式）
        auto time_point = msg.time;
        auto epoch_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            time_point.time_since_epoch()).count();
        log_entry["ts"] = epoch_ms;
        
        // 级别
        log_entry["level"] = spdlog::level::to_string_view(msg.level).data();
        
        // 消息
        log_entry["msg"] = std::string(msg.payload.begin(), msg.payload.end());
        
        // 源文件位置（debug时有用）
        if (!msg.source.empty()) {
            log_entry["source"]["file"] = msg.source.filename;
            log_entry["source"]["line"] = msg.source.line;
            log_entry["source"]["func"] = msg.source.funcname;
        }
        
        // 线程ID
        log_entry["tid"] = msg.thread_id;
        
        // 写入文件（一行一条JSON）
        file_ << log_entry.dump() << '\n';
        file_.flush();
    }

    void flush_() override { file_.flush(); }

private:
    std::ofstream file_;
};
```

#### 3.2 带上下文的日志（MDC模式）

请求级别的上下文（trace_id、user_id等）应自动附加到每条日志：

```cpp
#include <string>
#include <unordered_map>

// Thread-local上下文（MDC: Mapped Diagnostic Context）
class LogContext {
public:
    static void set(const std::string& key, const std::string& value) {
        getContext()[key] = value;
    }
    
    static void remove(const std::string& key) {
        getContext().erase(key);
    }
    
    static void clear() {
        getContext().clear();
    }
    
    static const std::unordered_map<std::string, std::string>& getAll() {
        return getContext();
    }

private:
    static std::unordered_map<std::string, std::string>& getContext() {
        thread_local std::unordered_map<std::string, std::string> ctx;
        return ctx;
    }
};

// RAII守卫：请求开始时设置，结束时自动清理
class LogContextGuard {
public:
    LogContextGuard(std::initializer_list<std::pair<std::string, std::string>> entries) {
        for (auto& [k, v] : entries) {
            keys_.push_back(k);
            LogContext::set(k, v);
        }
    }
    ~LogContextGuard() {
        for (auto& k : keys_) {
            LogContext::remove(k);
        }
    }
private:
    std::vector<std::string> keys_;
};

// 使用示例：HTTP请求处理
void handleRequest(const Request& req) {
    // 请求入口：设置上下文
    LogContextGuard ctx({
        {"trace_id", req.getHeader("X-Trace-Id")},
        {"user_id", req.getUserId()},
        {"method", req.method()},
        {"path", req.path()}
    });
    
    // 后续所有日志自动带上 trace_id、user_id 等字段
    SPDLOG_INFO("Request received");
    
    auto result = processBusinessLogic(req);
    
    SPDLOG_INFO("Request completed, status={}", result.status);
    // 输出: {"ts":...,"msg":"Request completed, status=200",
    //        "trace_id":"abc-123","user_id":"U456","method":"POST","path":"/orders"}
}
```

---

### 4. 日志聚合方案对比

当日志分散在数十上百台机器上，需要集中式日志聚合系统：

```
日志聚合架构（通用模型）：

  App Servers                 Collectors         Storage & Query
  ┌──────────┐              ┌───────────┐      ┌──────────────┐
  │ Service A │──stdout───> │           │      │              │
  │ (JSON log)│             │ Fluentd   │─────>│ Elasticsearch│──> Kibana
  └──────────┘              │    or     │      │   or Loki    │──> Grafana
  ┌──────────┐              │ Vector    │      │   or         │
  │ Service B │──file────>  │    or     │─────>│ ClickHouse   │──> 自建UI
  │ (JSON log)│             │ Filebeat  │      │              │
  └──────────┘              └───────────┘      └──────────────┘
```

#### 4.1 方案对比

| 维度 | ELK Stack | Grafana Loki | ClickHouse |
|------|-----------|--------------|------------|
| 架构 | ES + Logstash + Kibana | Loki + Promtail + Grafana | ClickHouse + Vector |
| 索引策略 | 全文倒排索引 | 只索引label（元数据） | 列式存储+稀疏索引 |
| 存储成本 | 高（索引膨胀2-3倍） | **低（日志体不索引）** | 中（列式压缩好） |
| 查询速度 | 快（任意字段秒级） | 中（非label字段需扫描） | 快（聚合分析极强） |
| 运维复杂度 | **高**（JVM调优、分片管理） | 低（对象存储+无状态） | 中（单binary但需调优） |
| 适合规模 | 中大型（需专人运维） | 中小型（云原生友好） | 大型（百TB级分析） |
| 告警集成 | ElastAlert | Grafana Alerting | 需外接 |
| 生态 | 最成熟 | Grafana全家桶 | 需自建 |

#### 4.2 选型建议

```
选型决策树：

  日志量 < 10GB/天？
    ├── 是 → 已有 Grafana？
    │         ├── 是 → Grafana Loki ✅（成本最低，无缝集成）
    │         └── 否 → 看团队熟悉程度
    │
    └── 否 → 需要复杂全文搜索？
              ├── 是 → ELK Stack（需运维投入）
              └── 否 → 主要做聚合分析？
                        ├── 是 → ClickHouse（百TB级无压力）
                        └── 否 → Grafana Loki + 加label
```

---

### 5. 日志采集器对比

| 采集器 | 语言 | 内存占用 | 吞吐 | 特色 |
|--------|------|---------|------|------|
| Filebeat | Go | ~30MB | 中 | ELK生态默认 |
| Fluentd | Ruby+C | ~100MB | 中 | 插件丰富 |
| Fluent Bit | C | **~5MB** | 高 | 极轻量，适合容器sidecar |
| Vector | Rust | ~50MB | **极高** | 可编程transform、新星 |
| Promtail | Go | ~30MB | 中 | Loki专用 |

**推荐**：
- K8s环境 → Fluent Bit（DaemonSet，极低资源占用）
- 需要复杂ETL → Vector（VRL脚本语言，灵活转换）
- Loki方案 → Promtail（官方配套）

---

### 6. 日志查询实战

#### Grafana Loki (LogQL)

{% raw %}
```logql
# 查看某服务最近1小时的ERROR日志
{service="order-svc"} |= "error" | json | level="error"

# 统计每分钟错误率
sum(rate({service="order-svc"} |= "error" [1m])) by (host)

# 按trace_id追踪完整请求链路
{trace_id="abc-123-def-456"} | json

# P99延迟超过500ms的请求
{service="order-svc"} | json | latency_ms > 500 | line_format "{{.method}} {{.path}} {{.latency_ms}}ms"

# 统计各状态码分布
sum by (status) (count_over_time({service="order-svc"} | json [5m]))
```
{% endraw %}

#### Elasticsearch (KQL)

```
# 基本搜索
service: "order-svc" AND level: "error" AND @timestamp >= "2026-05-29T10:00:00"

# 按字段聚合
{
  "aggs": {
    "errors_by_host": {
      "terms": { "field": "host.keyword" },
      "aggs": {
        "error_count": {
          "filter": { "term": { "level": "error" } }
        }
      }
    }
  }
}
```

---

### 7. 日志最佳实践

| 实践 | 具体要求 | 原因 |
|------|---------|------|
| 一行一条 | 每条日志是完整的JSON行（JSONL格式） | 采集器按行切分 |
| 必带trace_id | 所有日志携带分布式追踪ID | 跨服务关联 |
| 避免敏感信息 | 脱敏手机号、身份证、密码 | 合规要求 |
| 控制日志量 | INFO级别不超过100条/s/实例 | 防止存储爆炸 |
| 采样高频日志 | 每秒超过1000条的相同msg采样1% | 成本控制 |
| 日志与指标分离 | 统计类数据用Prometheus指标，不用日志计数 | 性能+成本 |
| 异步写入 | 日志写入不阻塞业务线程 | 避免IO毛刺 |
| 保留时间分级 | ERROR保留90天，INFO保留7天，DEBUG保留1天 | 成本优化 |

---

### 8. 完整集成方案

```cpp
// production_logger.h — 生产级日志配置
#include <spdlog/spdlog.h>
#include <spdlog/async.h>
#include <spdlog/sinks/rotating_file_sink.h>
#include <spdlog/sinks/stdout_color_sinks.h>

void initProductionLogger(const std::string& service_name) {
    // 异步日志（8192条队列，满时丢弃最旧的）
    spdlog::init_thread_pool(8192, 1);
    
    // 文件sink：按大小轮转（100MB/文件，保留10个）
    auto file_sink = std::make_shared<spdlog::sinks::rotating_file_sink_mt>(
        "/var/log/" + service_name + "/app.log",
        100 * 1024 * 1024,  // 100MB
        10                   // 保留10个文件
    );
    
    // 控制台sink（开发环境彩色输出）
    auto console_sink = std::make_shared<spdlog::sinks::stdout_color_sink_mt>();
    
    // 组合sink
    std::vector<spdlog::sink_ptr> sinks = {file_sink, console_sink};
    
    auto logger = std::make_shared<spdlog::async_logger>(
        service_name, sinks.begin(), sinks.end(),
        spdlog::thread_pool(),
        spdlog::async_overflow_policy::overrun_oldest  // 队列满时丢弃旧日志
    );
    
    // JSON格式化模式（spdlog原生pattern接近JSON）
    logger->set_pattern(
        R"({"ts":"%Y-%m-%dT%H:%M:%S.%e%z","level":"%l","logger":"%n","msg":"%v","tid":%t})"
    );
    
    logger->set_level(spdlog::level::info);
    spdlog::set_default_logger(logger);
    
    SPDLOG_INFO("Logger initialized for service: {}", service_name);
}
```

---

### 总结

结构化日志体系的核心要点：

1. **JSON格式是基线**：所有服务输出JSONL格式日志，每条包含timestamp、level、msg、trace_id
2. **上下文自动传播**：用MDC模式（thread-local）自动附加request级别字段
3. **集中式聚合是必须**：20+台机器的日志必须有统一查询入口
4. **选型匹配规模**：小规模用Loki（成本低），大规模用ClickHouse（分析强），通用选ELK
5. **异步写入不阻塞**：spdlog async模式，日志IO不应影响业务延迟
6. **动态级别调整**：通过HTTP接口运行时切换，排查问题时临时开DEBUG

日志不是"事后补救"工具，而是系统设计的一部分。在写代码时就想好"出了问题我需要哪些信息来定位"，日志自然就写对了。
