---
layout: post_layout
title: "Linux性能分析工具链：perf、ftrace、bpftrace实战"
date: 2026-05-27 02:30:00 +0800
categories: [Linux系统]
location: 西安
excerpt_separator: "```"
---

性能问题是后端开发最头疼的问题之一——它不像 bug 那样有明确的复现路径，往往表现为"偶尔慢一下"或者"最近 P99 涨了"。这篇文章梳理我在生产环境中最常用的三个工具：perf、ftrace、bpftrace，以及如何针对不同场景选择合适的工具。

## 可观测性金字塔

```
          ┌─────────┐
          │Profiling│  ← 最细粒度，开销最大
          ├─────────┤
          │ Traces  │  ← 分布式调用链
          ├─────────┤
          │  Logs   │  ← 事件驱动
          ├─────────┤
          │ Metrics │  ← 聚合数据，开销最小
          └─────────┘
```

Metrics 告诉你"有问题了"，Logs 告诉你"发生了什么"，Traces 告诉你"慢在哪个环节"，而 Profiling 告诉你"具体哪行代码慢"。今天聚焦最底层的 Profiling。

## perf：硬件级采样分析

perf 是 Linux 内核自带的性能分析工具，基于硬件 PMU（Performance Monitoring Unit）计数器做采样，开销极低（通常 <1%）。

```bash
# CPU 热点采样（99Hz 频率，持续 30 秒）
perf record -F 99 -p $(pidof my_server) -g -- sleep 30

# 查看报告
perf report --stdio

# 生成火焰图（配合 brendangregg/FlameGraph）
perf script | stackcollapse-perf.pl | flamegraph.pl > flame.svg
```

我最常用的几个场景：

- **CPU 热点**：`perf record -F 99 -g` 然后看火焰图
- **Cache miss 分析**：`perf stat -e cache-misses,cache-references`
- **分支预测失败**：`perf stat -e branch-misses`
- **指令级分析**：`perf annotate` 看具体汇编指令的耗时

一个实际案例：某服务 CPU 使用率突然从 40% 涨到 70%，火焰图显示 `std::unordered_map::find` 占了 25%。排查发现是一个缓存 map 从 1 万条膨胀到了 100 万条，hash 冲突严重。换成 `absl::flat_hash_map` 后 CPU 降回 45%。

## ftrace：内核函数追踪

ftrace 是内核内置的追踪框架，不需要额外安装。它的优势是能追踪内核函数调用，非常适合分析系统调用延迟和内核态问题。

```bash
# 启用 function_graph tracer，追踪特定函数
echo function_graph > /sys/kernel/debug/tracing/current_tracer
echo tcp_sendmsg > /sys/kernel/debug/tracing/set_graph_function
echo 1 > /sys/kernel/debug/tracing/tracing_on

# 查看输出
cat /sys/kernel/debug/tracing/trace_pipe

# 输出示例：
#  3)               |  tcp_sendmsg() {
#  3)   0.456 us    |    lock_sock_nested();
#  3)               |    tcp_sendmsg_locked() {
#  3)   0.213 us    |      tcp_rate_check_app_limited();
#  3)   2.891 us    |      sk_page_frag_refill();
#  3)   8.234 us    |    }
#  3)   0.198 us    |    release_sock();
#  3) + 10.012 us   |  }
```

ftrace 的 function_graph 能清晰展示函数调用层级和每层耗时，比 strace 粒度更细。我用它排查过一个诡异的延迟问题——某些请求的 `write()` 系统调用耗时 50ms，通过 ftrace 发现是 `balance_dirty_pages_ratelimited()` 触发了脏页回写等待。

## bpftrace：一行脚本解决问题

bpftrace 基于 eBPF 技术，可以在不修改代码、不重启进程的情况下动态追踪。它的一行脚本（one-liner）模式极其高效：

```bash
# 统计系统调用延迟分布（直方图）
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @start[tid] = nsecs; }
             tracepoint:raw_syscalls:sys_exit /@start[tid]/ {
                 @usecs = hist((nsecs - @start[tid]) / 1000);
                 delete(@start[tid]);
             }'

# 追踪特定进程的 malloc 调用大小分布
bpftrace -e 'uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc /pid == 12345/ {
    @sizes = hist(arg0);
}'

# 统计哪些函数持有 mutex 时间最长
bpftrace -e 'uprobe:./my_server:pthread_mutex_lock { @lock_start[tid] = nsecs; }
             uretprobe:./my_server:pthread_mutex_unlock /@lock_start[tid]/ {
                 @lock_held_us = hist((nsecs - @lock_start[tid]) / 1000);
                 delete(@lock_start[tid]);
             }'
```

## BCC 工具箱：开箱即用

BCC (BPF Compiler Collection) 提供了一系列现成的分析工具：

```
┌────────────────────────────────────────────────────────┐
│ 问题领域          │ 工具          │ 功能              │
├────────────────────────────────────────────────────────┤
│ 磁盘 I/O 延迟    │ biolatency   │ 块设备延迟直方图    │
│ 函数耗时         │ funclatency  │ 内核/用户函数延迟   │
│ TCP 连接生命周期  │ tcplife      │ 连接时长和吞吐量    │
│ CPU 采样         │ profile      │ 类似 perf 的采样    │
│ 内存泄漏         │ memleak      │ 未释放的分配追踪    │
│ 文件系统延迟     │ ext4slower   │ 慢文件系统操作      │
└────────────────────────────────────────────────────────┘
```

我最喜欢的组合：先用 `biolatency` 确认是否有 I/O 延迟，再用 `ext4slower` 找到具体哪个文件操作慢，最后用 `bpftrace` 自定义脚本追踪到具体代码路径。

## 选择正确的工具

```
性能问题
  │
  ├── CPU 相关？
  │     ├── 是 → perf record + 火焰图
  │     └── 需要实时观察？ → bpftrace + profile
  │
  ├── I/O 相关？
  │     ├── 块设备 → biolatency / biosnoop
  │     └── 文件系统 → ext4slower / bpftrace
  │
  ├── 网络相关？
  │     ├── 连接级 → tcplife / tcptracer
  │     └── 内核协议栈 → ftrace (tcp_sendmsg等)
  │
  └── 锁竞争？
        ├── 用户态 → bpftrace uprobe on mutex
        └── 内核态 → perf lock / lockstat
```

## 生产环境安全须知

在生产机器上做 profiling 必须注意开销：

- **perf record**：采样频率 99Hz 开销 <1%，可以长期运行
- **ftrace function_graph**：追踪高频函数时开销可达 5-10%，用完立即关闭
- **bpftrace**：取决于探针触发频率。追踪 `malloc` 这种每秒百万次的调用要小心
- **原则**：先用低开销工具（perf stat、metrics）缩小范围，再用高开销工具定点分析

## 实战：诊断锁竞争

某 C++ 服务在高并发时 P99 延迟从 5ms 飙到 200ms，CPU 使用率却不高（只有 30%）。

```bash
# Step 1: perf 确认不是 CPU 热点问题
perf record -F 99 -p $PID -g -- sleep 10
# 火焰图显示大量时间花在 futex_wait

# Step 2: bpftrace 追踪 mutex 持有时间
bpftrace -e '
uprobe:./server:pthread_mutex_lock { @start[tid] = nsecs; }
uretprobe:./server:pthread_mutex_lock /@start[tid]/ {
    @wait = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}'
# 结果显示 P99 等待时间 180ms

# Step 3: 用 perf lock 找到竞争最激烈的锁
perf lock record -p $PID -- sleep 5
perf lock report
```

最终发现是一个全局 mutex 保护的日志队列在高并发时成为瓶颈。改用无锁队列（`moodycamel::ConcurrentQueue`）后 P99 降回 8ms。

## 总结

这三个工具形成了一个完整的分析工具链：perf 做全局画像，ftrace 深入内核细节，bpftrace 灵活定制追踪逻辑。掌握它们之后，面对性能问题不再是"猜"，而是有方法论地定位。建议在开发环境先熟悉这些工具的用法，等生产出问题时才能从容应对。
