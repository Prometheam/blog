---
layout: post_layout
title: "Prometheus与Grafana：后端服务可观测性实战"
date: 2026-05-27 03:30:00 +0800
categories: [架构设计]
location: 西安
excerpt_separator: "```"
---

"没有度量就没有改进。"在运营过几十个后端服务之后，我越来越认同这句话。当服务数量增长到一定规模，靠 `tail -f` 看日志已经完全不够用了。这篇文章分享我在 C++ 后端服务中落地 Prometheus + Grafana 可观测性体系的实践经验。

## 可观测性三支柱

```
┌──────────────────────────────────────────────────────┐
│                  Observability                        │
├──────────────┬──────────────────┬────────────────────┤
│   Metrics    │      Logs        │      Traces        │
│              │                  │                    │
│ Prometheus   │  ELK / Loki     │  Jaeger / Tempo    │
│ + Grafana    │                  │  + OpenTelemetry   │
│              │                  │                    │
│ "发生了多少" │ "发生了什么"      │ "调用链路是什么"    │
└──────────────┴──────────────────┴────────────────────┘
```

三者互补：Metrics 用于告警和趋势分析（开销极低），Logs 记录具体事件细节，Traces 追踪跨服务的请求链路。今天聚焦 Metrics 层。

## Prometheus 架构

```
┌──────────┐  scrape   ┌────────────┐  query   ┌─────────┐
│ Targets  │◄──────────│Prometheus  │◄─────────│ Grafana │
│ (服务)   │  /metrics │   Server   │  PromQL  │         │
└──────────┘           │            │          └─────────┘
                       │  ┌──────┐  │
                       │  │ TSDB │  │   push   ┌────────────┐
                       │  └──────┘  │◄─────────│Alertmanager│
                       └────────────┘  alerts  └────────────┘
```

核心设计哲学：**Pull 模型**。Prometheus 主动拉取目标的 `/metrics` 端点，而不是让服务推送数据。优点是：
- 服务不需要知道监控系统的地址
- Prometheus 挂了不影响业务服务
- 天然支持服务发现（配合 K8s SD、Consul SD）

## 四种 Metric 类型

| 类型 | 用途 | 示例 |
|------|------|------|
| Counter | 只增不减的累计值 | 请求总数、错误总数 |
| Gauge | 可增可减的瞬时值 | 当前连接数、内存使用量 |
| Histogram | 分布统计（分桶） | 请求延迟分布、响应大小分布 |
| Summary | 分布统计（分位数） | P50/P99 延迟（客户端计算） |

**Histogram vs Summary**：Histogram 在服务端计算分位数（可聚合），Summary 在客户端计算（不可跨实例聚合）。我的建议是**一律用 Histogram**，除非你只有单实例且需要精确分位数。

## C++ 服务埋点（prometheus-cpp）

{% raw %}
```cpp
#include <prometheus/counter.h>
#include <prometheus/histogram.h>
#include <prometheus/exposer.h>
#include <prometheus/registry.h>

class MetricsManager {
public:
    MetricsManager() {
        // 暴露 /metrics HTTP 端点在 9090 端口
        exposer_ = std::make_unique<prometheus::Exposer>("0.0.0.0:9090");
        registry_ = std::make_shared<prometheus::Registry>();
        exposer_->RegisterCollectable(registry_);

        // 定义 Counter
        auto& req_counter_family = prometheus::BuildCounter()
            .Name("rpc_requests_total")
            .Help("Total RPC requests")
            .Labels({{"service", "order"}})
            .Register(*registry_);
        request_counter_ = &req_counter_family.Add({{"method", "CreateOrder"}});

        // 定义 Histogram（自定义桶边界）
        auto& latency_family = prometheus::BuildHistogram()
            .Name("rpc_duration_seconds")
            .Help("RPC latency distribution")
            .Register(*registry_);
        latency_hist_ = &latency_family.Add(
            {{"method", "CreateOrder"}},
            prometheus::Histogram::BucketBoundaries{
                0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0
            });
    }

    void RecordRequest(double duration_sec, bool success) {
        request_counter_->Increment();
        latency_hist_->Observe(duration_sec);
        if (!success) error_counter_->Increment();
    }

private:
    std::unique_ptr<prometheus::Exposer> exposer_;
    std::shared_ptr<prometheus::Registry> registry_;
    prometheus::Counter* request_counter_;
    prometheus::Counter* error_counter_;
    prometheus::Histogram* latency_hist_;
};
```
{% endraw %}

## RED 与 USE 方法论

对于后端服务，我固定监控两组指标：

**RED（面向请求）**：
- **R**ate — 每秒请求数 (`rate(rpc_requests_total[5m])`)
- **E**rrors — 错误率 (`rate(rpc_errors_total[5m]) / rate(rpc_requests_total[5m])`)
- **D**uration — 延迟分布 (`histogram_quantile(0.99, rate(rpc_duration_seconds_bucket[5m]))`)

**USE（面向资源）**：
- **U**tilization — CPU、内存、磁盘使用率
- **S**aturation — 队列深度、线程池饱和度
- **E**rrors — 硬件错误、丢包

## PromQL 核心用法

```promql
# 每秒请求率（5分钟窗口平滑）
rate(rpc_requests_total{service="order"}[5m])

# P99 延迟
histogram_quantile(0.99, 
    rate(rpc_duration_seconds_bucket{method="CreateOrder"}[5m])
)

# 错误率告警（超过1%触发）
rate(rpc_errors_total[5m]) / rate(rpc_requests_total[5m]) > 0.01

# 按实例聚合的 CPU 使用率
avg by (instance) (rate(process_cpu_seconds_total[5m])) * 100
```

常见陷阱：`rate()` 必须包裹 Counter 类型，窗口要 >= 2 倍抓取间隔；`histogram_quantile` 的精度取决于桶边界设计。

## 告警规则设计

{% raw %}
```yaml
# prometheus_rules.yml
groups:
  - name: service_alerts
    rules:
      # 记录规则：预计算常用查询
      - record: job:rpc_duration_seconds:p99
        expr: histogram_quantile(0.99, rate(rpc_duration_seconds_bucket[5m]))

      # 告警规则
      - alert: HighErrorRate
        expr: rate(rpc_errors_total[5m]) / rate(rpc_requests_total[5m]) > 0.01
        for: 5m  # 持续5分钟才告警，避免抖动
        labels:
          severity: warning
        annotations:
          summary: "服务 {{ $labels.service }} 错误率超过 1%"
          
      - alert: HighLatency
        expr: job:rpc_duration_seconds:p99 > 0.5
        for: 3m
        labels:
          severity: critical
```
{% endraw %}

告警设计原则：
1. **告警要可操作**——收到告警后应该明确知道要做什么
2. **设置合理的 `for` 持续时间**——避免瞬时抖动误报
3. **分级**：warning 发群消息，critical 打电话

## SLO / SLI / SLA

```
┌─────────────────────────────────────────────────────────┐
│ SLA (对外承诺): 99.9% 可用性 (年宕机 < 8.76h)           │
│                                                         │
│ SLO (内部目标): 99.95% 请求成功 + P99 < 200ms          │
│                                                         │
│ SLI (实际度量): rate(success) / rate(total)             │
│                  histogram_quantile(0.99, ...)          │
└─────────────────────────────────────────────────────────┘
```

**Error Budget（错误预算）** 是 SRE 的核心概念：如果 SLO 是 99.95%，那么每月允许 0.05% 的错误。当错误预算耗尽时，团队应停止发布新功能，专注于稳定性。

```promql
# 30天滚动错误预算剩余
1 - (
    (1 - avg_over_time(sli_success_rate[30d])) / (1 - 0.9995)
)
```

## Grafana Dashboard 设计建议

经过多次迭代，我总结的 Dashboard 最佳实践：

```
┌─────────────────────────────────────────────────┐
│ Row 1: 全局概览 (SLI/Error Budget)              │
├────────────────┬────────────────────────────────┤
│ Row 2: RED     │  QPS | Error Rate | P50/P99    │
├────────────────┼────────────────────────────────┤
│ Row 3: USE     │  CPU | Memory | Connections    │
├────────────────┼────────────────────────────────┤
│ Row 4: 业务    │  订单量 | 支付成功率 | 库存     │
└────────────────┴────────────────────────────────┘
```

原则：
1. **从上到下逐级深入**——第一眼看 SLI 是否健康，异常时往下看具体哪个指标出了问题
2. **时间范围统一**——所有面板用相同的时间窗口
3. **阈值线可视化**——在图上标出 SLO 对应的阈值线
4. **变量模板**——用 Grafana 变量实现服务/实例切换，一套 Dashboard 覆盖所有服务

## 总结

可观测性不是"加几个 metrics"就完事的，它是一套方法论：定义 SLI → 设定 SLO → 围绕 SLO 建设告警 → 用 Error Budget 驱动工程决策。Prometheus + Grafana 只是工具，真正重要的是想清楚"监控什么"和"为什么监控"。对于 C++ 后端服务，prometheus-cpp 库已经足够成熟，埋点成本很低，建议在项目初期就接入，不要等出了问题再补——那时候往往已经来不及了。
