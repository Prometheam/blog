---
layout: post_layout
title: "微服务链路追踪：OpenTelemetry与分布式Tracing"
date: 2026-05-27 00:30:00 +0800
categories: [架构设计]
location: 西安
excerpt_separator: "```"
---

当你的系统从单体演变为几十个微服务时，一次用户请求可能穿越十几个服务。某天线上延迟突增，你面对的第一个问题是：到底慢在哪里？这就是分布式链路追踪要解决的核心问题。本文分享我在C++后端服务中落地OpenTelemetry的实践经验。

## 为什么需要分布式追踪

传统日志排查在微服务架构下失效：

```
用户请求 → API Gateway → 用户服务 → 订单服务 → 库存服务 → 支付服务
                                        ↓
                                    消息队列 → 通知服务

问题：某次请求耗时3秒，光看日志你无法判断瓶颈在哪
```

分布式追踪通过在请求链路中传播上下文，将散落在各服务的日志、指标串联为一条完整的调用链。

## 核心概念

```
Trace（一次完整请求）
├── Span A: API Gateway (0ms ~ 320ms)
│   ├── Span B: 用户服务 (10ms ~ 45ms)
│   └── Span C: 订单服务 (50ms ~ 310ms)
│       ├── Span D: 库存服务 (60ms ~ 120ms)
│       └── Span E: 支付服务 (130ms ~ 300ms) ← 瓶颈！
└── SpanContext: {trace_id, span_id, trace_flags}
```

- **Trace**：一次端到端请求，由唯一的trace_id标识
- **Span**：一个操作单元，记录开始时间、持续时间、状态、属性
- **SpanContext**：跨进程传播的上下文（trace_id + span_id + flags）
- **Baggage**：业务数据的跨服务透传（如用户ID、AB实验分组）

## OpenTelemetry架构

OpenTelemetry（OTel）统一了Tracing、Metrics、Logs三大信号的采集标准：

```
+-------------+     OTLP/gRPC     +-------------+     Export      +---------+
| 应用 + SDK  | ──────────────→   | OTel        | ─────────────→ | Jaeger  |
| (C++ 服务)  |                   | Collector   |                | Tempo   |
+-------------+                   +-------------+                | Zipkin  |
                                       │                         +---------+
                                       │ Pipeline:
                                       │ Receivers → Processors → Exporters
                                       │ (接收)      (采样/过滤)   (输出)
```

Collector作为独立进程部署，解耦了应用与后端存储，支持灵活的数据处理pipeline。

## W3C TraceContext传播格式

跨服务调用时，上下文通过HTTP头或gRPC metadata传播：

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │   │                                │                  │
             │   trace-id (16字节)                 span-id (8字节)    采样标志
             version
```

## C++ gRPC服务接入OpenTelemetry

以我们实际的网关服务为例：

```cpp
#include <opentelemetry/sdk/trace/tracer_provider.h>
#include <opentelemetry/exporters/otlp/otlp_grpc_exporter.h>
#include <opentelemetry/context/propagation/global_propagator.h>

namespace trace_sdk = opentelemetry::sdk::trace;
namespace otlp = opentelemetry::exporter::otlp;

void InitTracing() {
    // 配置OTLP导出器，发送到Collector
    otlp::OtlpGrpcExporterOptions opts;
    opts.endpoint = "otel-collector:4317";

    auto exporter = std::make_unique<otlp::OtlpGrpcExporter>(opts);

    // 批量处理器：攒批发送减少网络开销
    auto processor = trace_sdk::BatchSpanProcessorFactory::Create(
        std::move(exporter), {});

    // 采样器：生产环境不能全量采集
    auto sampler = std::make_unique<trace_sdk::ParentBasedSampler>(
        std::make_shared<trace_sdk::TraceIdRatioBasedSampler>(0.01));

    auto provider = trace_sdk::TracerProviderFactory::Create(
        std::move(processor), {}, std::move(sampler));

    opentelemetry::trace::Provider::SetTracerProvider(std::move(provider));
}
```

在gRPC拦截器中自动创建Span：

```cpp
class TracingInterceptor : public grpc::experimental::Interceptor {
    void Intercept(InterceptorBatchMethods* methods) override {
        if (methods->QueryInterceptionHookPoint(
                InterceptionHookPoint::POST_RECV_INITIAL_METADATA)) {
            // 从metadata中提取上游传来的SpanContext
            auto ctx = propagator_->Extract(carrier);
            auto span = tracer_->StartSpan(
                method_name_,
                {{"rpc.system", "grpc"},
                 {"rpc.service", service_name_}},
                {opentelemetry::trace::kSpanKindServer, ctx});
            // span在方法结束时自动End
        }
        methods->Proceed();
    }
};
```

## 采样策略

全量采集在高流量下不可行（我们网关QPS 10万+，每秒产生百万Span）：

```
+------------------+----------------------------------------+
| 策略             | 特点                                   |
+------------------+----------------------------------------+
| Head-based       | 入口决定是否采样，简单但可能丢失异常链路 |
| Tail-based       | 链路完成后决定，能保留错误/慢请求         |
| Adaptive         | 根据流量动态调整采样率                   |
+------------------+----------------------------------------+
```

我的实践方案是组合使用：
- 正常请求1%头部采样
- 错误请求和慢请求（>P99）通过Collector的tail-based processor 100%保留
- 特定用户/请求通过Baggage标记强制采样

## 后端选型对比

```
+----------+------------+----------+---------------------------+
| 后端     | 存储       | 查询能力 | 适用场景                  |
+----------+------------+----------+---------------------------+
| Jaeger   | ES/Cassandra| 强      | 中大规模，需复杂查询       |
| Zipkin   | ES/MySQL   | 中等     | 小规模，快速上手           |
| Tempo    | 对象存储   | TraceID  | 大规模，配合Grafana生态    |
+----------+------------+----------+---------------------------+
```

我们选择了Tempo + Grafana方案：存储成本低（直接写S3），通过TraceID从日志跳转到链路，配合Loki实现Trace-Log关联。

## Trace-Log-Metrics三信号关联

真正的可观测性在于三者的关联：

```cpp
// 日志中自动注入trace_id
spdlog::info("[trace_id={}] Processing order {}",
    span->GetContext().trace_id().Id(), order_id);

// Metrics中关联exemplar
histogram.Record(latency_ms, {{"trace_id", current_trace_id}});
```

在Grafana中，点击Metrics图表上的异常点 → 跳转到对应的Trace → 展开Span查看关联的Log。这个闭环让故障排查效率提升了一个数量级。

## 性能开销与生产注意事项

实测OpenTelemetry C++ SDK的开销：
- 创建Span：约500ns（开启采样后大部分请求直接跳过）
- 内存：BatchProcessor缓冲区默认2048 Span，约8MB
- 网络：gRPC批量上报，QPS 10万时带宽约5MB/s

关键生产配置：
1. **必须设置资源限制**：Collector的内存限制，防止反压时OOM
2. **优雅降级**：SDK连不上Collector时静默丢弃，不影响业务
3. **敏感数据脱敏**：通过Processor过滤Span属性中的身份证、手机号

分布式追踪不是银弹，但它是微服务架构下排查问题的基础设施。投入一周接入OTel，换来的是未来每次故障排查节省数小时。
