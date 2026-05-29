---
title: "eBPF深度实战：从内核观测到网络加速的系统化指南"
categories: [Linux系统]
location: 西安
render_with_liquid: false
---

### 引言

eBPF（extended Berkeley Packet Filter）是近十年Linux内核最革命性的技术。它让你可以在不修改内核源码、不加载内核模块的情况下，在内核中运行安全的自定义程序——用于网络加速、安全监控、性能观测。

Netflix用eBPF做全栈观测，Cloudflare用它做DDoS防御，Cilium用它替代了iptables。作为后端开发者，eBPF让你能"透视"内核行为：每个系统调用、每次网络收包、每次内存分配——无侵入、低开销。

本文从eBPF架构讲起，覆盖程序编写、常见使用场景，以及XDP网络加速和安全监控的完整实战。

---

### 1. eBPF 架构概览

```
  eBPF 执行流程：

  用户态                           内核态
  ┌──────────────────┐           ┌─────────────────────────────────┐
  │                  │           │                                 │
  │  BPF 程序(C)     │  编译     │                                 │
  │  ──────────>    │──────>    │   Verifier (安全验证)            │
  │  clang -target  │ BPF字节码 │     │                           │
  │  bpf            │           │     ▼ 通过验证                   │
  │                  │  bpf()   │   JIT Compiler → 原生机器码     │
  │  加载器          │──系统调用→│     │                           │
  │  (libbpf/bcc)   │           │     ▼ 挂载到Hook点              │
  │                  │           │                                 │
  │                  │           │  ┌─── Hook Points ───────────┐ │
  │                  │           │  │ kprobe (内核函数入口)       │ │
  │                  │           │  │ tracepoint (静态跟踪点)    │ │
  │                  │           │  │ XDP (网卡收包最早点)       │ │
  │                  │           │  │ tc (流量控制)              │ │
  │                  │           │  │ socket filter              │ │
  │                  │           │  │ cgroup (容器级控制)        │ │
  │                  │           │  └────────────────────────────┘ │
  │                  │           │                                 │
  │  读取数据        │  BPF Map  │  eBPF程序通过Map与用户态通信    │
  │  (性能指标/事件) │←─────────│  (hash/array/ringbuf/...)      │
  │                  │           │                                 │
  └──────────────────┘           └─────────────────────────────────┘
```

#### eBPF 关键特性

| 特性 | 说明 |
|------|------|
| 安全 | Verifier静态分析，保证不会crash内核 |
| 高效 | JIT编译为原生代码，接近内核函数性能 |
| 非侵入 | 不改内核源码，不重启，动态加载/卸载 |
| 受限 | 栈空间512字节、不能有无限循环、函数调用深度有限 |

---

### 2. eBPF 程序类型与 Hook 点

```
  ┌────────────────┬──────────────────────────────┬─────────────────────────┐
  │   程序类型     │          Hook 位置            │         典型用途        │
  ├────────────────┼──────────────────────────────┼─────────────────────────┤
  │ kprobe/kretprobe│ 任意内核函数入口/返回        │ 追踪系统调用、内核行为  │
  ├────────────────┼──────────────────────────────┼─────────────────────────┤
  │ tracepoint     │ 内核预定义的静态跟踪点       │ 稳定的内核事件观测      │
  ├────────────────┼──────────────────────────────┼─────────────────────────┤
  │ uprobe         │ 用户态函数入口               │ 追踪应用程序函数调用    │
  ├────────────────┼──────────────────────────────┼─────────────────────────┤
  │ XDP            │ 网卡驱动收包最早点           │ 高性能包过滤/转发/修改  │
  ├────────────────┼──────────────────────────────┼─────────────────────────┤
  │ tc (clsact)    │ 流量控制(ingress/egress)     │ 网络策略、负载均衡      │
  ├────────────────┼──────────────────────────────┼─────────────────────────┤
  │ socket filter  │ socket 收发包               │ 包过滤、流量统计        │
  ├────────────────┼──────────────────────────────┼─────────────────────────┤
  │ cgroup         │ cgroup 级别                  │ 容器网络策略            │
  ├────────────────┼──────────────────────────────┼─────────────────────────┤
  │ perf_event     │ 性能计数器采样               │ CPU profiling           │
  └────────────────┴──────────────────────────────┴─────────────────────────┘
```

---

### 3. 编写 eBPF 程序：追踪系统调用

#### 3.1 BPF 内核程序（C）

```c
// trace_open.bpf.c — 追踪所有文件打开操作
#include <vmlinux.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

struct event {
    u32 pid;
    u32 uid;
    char comm[16];
    char filename[256];
    int ret;
};

// Ring Buffer: 向用户态发送事件
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);  // 256KB
} events SEC(".maps");

// 挂载到 sys_enter_openat tracepoint
SEC("tracepoint/syscalls/sys_enter_openat")
int trace_openat_enter(struct trace_event_raw_sys_enter* ctx) {
    struct event *e;

    e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e) return 0;

    // 获取当前进程信息
    e->pid = bpf_get_current_pid_tgid() >> 32;
    e->uid = bpf_get_current_uid_gid() & 0xFFFFFFFF;
    bpf_get_current_comm(&e->comm, sizeof(e->comm));

    // 获取文件名参数（第二个参数是filename）
    const char *filename = (const char *)ctx->args[1];
    bpf_probe_read_user_str(e->filename, sizeof(e->filename), filename);

    bpf_ringbuf_submit(e, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

#### 3.2 用户态加载程序（C++/libbpf）

```cpp
// trace_open.cpp — 用户态加载eBPF程序并读取事件
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include <signal.h>
#include <iostream>
#include "trace_open.skel.h"  // 由bpftool gen skeleton生成

struct event {
    uint32_t pid;
    uint32_t uid;
    char comm[16];
    char filename[256];
    int ret;
};

static volatile bool running = true;
void sig_handler(int sig) { running = false; }

// Ring Buffer 回调函数
static int handle_event(void *ctx, void *data, size_t data_sz) {
    auto *e = static_cast<event*>(data);
    printf("%-8d %-8d %-16s %s\n", e->pid, e->uid, e->comm, e->filename);
    return 0;
}

int main() {
    signal(SIGINT, sig_handler);

    // 1. 加载并验证BPF程序
    auto *skel = trace_open_bpf__open_and_load();
    if (!skel) {
        fprintf(stderr, "Failed to load BPF program\n");
        return 1;
    }

    // 2. Attach到tracepoint
    int err = trace_open_bpf__attach(skel);
    if (err) {
        fprintf(stderr, "Failed to attach: %d\n", err);
        trace_open_bpf__destroy(skel);
        return 1;
    }

    // 3. 创建Ring Buffer消费者
    auto *rb = ring_buffer__new(bpf_map__fd(skel->maps.events), handle_event, nullptr, nullptr);

    printf("%-8s %-8s %-16s %s\n", "PID", "UID", "COMMAND", "FILENAME");

    // 4. 持续读取事件
    while (running) {
        ring_buffer__poll(rb, 100 /* timeout_ms */);
    }

    ring_buffer__free(rb);
    trace_open_bpf__destroy(skel);
    return 0;
}
```

编译流程：
```bash
# 1. 编译BPF程序
clang -g -O2 -target bpf -c trace_open.bpf.c -o trace_open.bpf.o

# 2. 生成skeleton头文件
bpftool gen skeleton trace_open.bpf.o > trace_open.skel.h

# 3. 编译用户态程序
g++ -std=c++17 -o trace_open trace_open.cpp -lbpf -lelf -lz
```

---

### 4. XDP 网络加速：高性能包过滤

XDP（eXpress Data Path）在网卡驱动层处理包，跳过整个内核协议栈，性能可达**数百万包/秒**。

```
  包处理位置对比：

  传统iptables:
  网卡 → 驱动 → 内核协议栈 → netfilter/iptables → 应用
                                     ↑ 这里才处理（很晚）

  XDP:
  网卡 → 驱动 → XDP程序 → 决定命运
                    ↑ 最早点处理（最快）

  XDP返回值：
  XDP_PASS    → 正常进入内核协议栈
  XDP_DROP    → 直接丢弃（网卡层面）
  XDP_TX      → 从同一网卡发回去
  XDP_REDIRECT→ 转发到另一个网卡/CPU
```

#### DDoS 防御（丢弃恶意IP）

```c
// xdp_firewall.bpf.c
#include <vmlinux.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// 黑名单IP集合（用户态动态更新）
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 100000);
    __type(key, __u32);     // IPv4地址
    __type(value, __u64);   // 丢弃计数
} blacklist SEC(".maps");

// 流量统计
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 4);
    __type(key, __u32);
    __type(value, __u64);
} stats SEC(".maps");

enum stat_key { STAT_PASS = 0, STAT_DROP = 1, STAT_TOTAL = 2 };

SEC("xdp")
int xdp_firewall(struct xdp_md *ctx) {
    void *data = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    // 统计总包数
    __u32 key = STAT_TOTAL;
    __u64 *count = bpf_map_lookup_elem(&stats, &key);
    if (count) __sync_fetch_and_add(count, 1);

    // 解析以太网头
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end) return XDP_PASS;
    if (eth->h_proto != bpf_htons(ETH_P_IP)) return XDP_PASS;

    // 解析IP头
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end) return XDP_PASS;

    // 检查源IP是否在黑名单中
    __u32 src_ip = ip->saddr;
    __u64 *blocked = bpf_map_lookup_elem(&blacklist, &src_ip);
    if (blocked) {
        __sync_fetch_and_add(blocked, 1);
        key = STAT_DROP;
        count = bpf_map_lookup_elem(&stats, &key);
        if (count) __sync_fetch_and_add(count, 1);
        return XDP_DROP;  // 在网卡层直接丢弃，不进内核
    }

    key = STAT_PASS;
    count = bpf_map_lookup_elem(&stats, &key);
    if (count) __sync_fetch_and_add(count, 1);
    return XDP_PASS;
}

char LICENSE[] SEC("license") = "GPL";
```

性能对比：
```
  DDoS防御性能（单核，64字节小包）：

  ┌──────────────────┬─────────────────┬──────────────┐
  │     方案         │   吞吐(pps)     │    延迟      │
  ├──────────────────┼─────────────────┼──────────────┤
  │ iptables         │ ~2M pps         │ ~10μs        │
  ├──────────────────┼─────────────────┼──────────────┤
  │ nftables         │ ~3M pps         │ ~8μs         │
  ├──────────────────┼─────────────────┼──────────────┤
  │ XDP (generic)    │ ~5M pps         │ ~3μs         │
  ├──────────────────┼─────────────────┼──────────────┤
  │ XDP (native)     │ ~20M pps        │ ~1μs         │
  ├──────────────────┼─────────────────┼──────────────┤
  │ XDP (offload)    │ ~100M+ pps      │ ~0.1μs       │
  └──────────────────┴─────────────────┴──────────────┘

  XDP native 比 iptables 快 10 倍！
```

---

### 5. 安全监控：追踪可疑行为

```c
// security_monitor.bpf.c — 监控特权操作
SEC("tracepoint/syscalls/sys_enter_execve")
int trace_execve(struct trace_event_raw_sys_enter* ctx) {
    // 记录所有进程执行事件（谁在什么时候执行了什么命令）
    struct event e = {};
    e.pid = bpf_get_current_pid_tgid() >> 32;
    bpf_get_current_comm(&e.comm, sizeof(e.comm));

    const char *filename = (const char *)ctx->args[0];
    bpf_probe_read_user_str(e.filename, sizeof(e.filename), filename);

    // 检测可疑行为：非root用户执行/bin/sh
    e.uid = bpf_get_current_uid_gid() & 0xFFFFFFFF;

    bpf_ringbuf_output(&events, &e, sizeof(e), 0);
    return 0;
}

// 监控网络连接（检测反弹shell）
SEC("kprobe/tcp_connect")
int trace_connect(struct pt_regs *ctx) {
    struct sock *sk = (struct sock *)PT_REGS_PARM1(ctx);
    // 获取目标IP和端口
    // 如果是内部服务器连接外网非常用端口 → 告警
    return 0;
}
```

---

### 6. 性能观测：函数延迟分析

```c
// 测量内核函数执行耗时
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, u32);       // tid
    __type(value, u64);     // 开始时间
} start_times SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HISTOGRAM);  // 直方图
    __uint(max_entries, 64);
    __type(key, u32);
    __type(value, u64);
} latency_hist SEC(".maps");

SEC("kprobe/vfs_read")
int kprobe_vfs_read(struct pt_regs *ctx) {
    u32 tid = bpf_get_current_pid_tgid();
    u64 ts = bpf_ktime_get_ns();
    bpf_map_update_elem(&start_times, &tid, &ts, BPF_ANY);
    return 0;
}

SEC("kretprobe/vfs_read")
int kretprobe_vfs_read(struct pt_regs *ctx) {
    u32 tid = bpf_get_current_pid_tgid();
    u64 *start_ts = bpf_map_lookup_elem(&start_times, &tid);
    if (!start_ts) return 0;

    u64 latency_ns = bpf_ktime_get_ns() - *start_ts;
    u64 latency_us = latency_ns / 1000;

    // 记录到直方图（log2分桶）
    u32 bucket = bpf_log2l(latency_us);
    u64 *count = bpf_map_lookup_elem(&latency_hist, &bucket);
    if (count) __sync_fetch_and_add(count, 1);

    bpf_map_delete_elem(&start_times, &tid);
    return 0;
}
```

---

### 7. 常用 eBPF 工具生态

| 工具 | 用途 | 适合人群 |
|------|------|---------|
| bpftrace | 单行命令式追踪（类awk） | 快速排查 |
| bcc | Python封装的eBPF工具集 | 运维/开发 |
| libbpf + CO-RE | C库，可移植BPF程序 | 深度开发 |
| Cilium | K8s网络策略+Service Mesh | 云原生 |
| Falco | 运行时安全监控 | 安全团队 |
| Pixie | 自动化可观测性 | SRE |

**bpftrace 单行命令示例**：
```bash
# 追踪所有 open 系统调用
bpftrace -e 'tracepoint:syscalls:sys_enter_openat { printf("%s %s\n", comm, str(args->filename)); }'

# 统计每秒系统调用次数（按进程）
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); } interval:s:1 { print(@); clear(@); }'

# vfs_read延迟直方图
bpftrace -e 'kprobe:vfs_read { @start[tid] = nsecs; } kretprobe:vfs_read /@start[tid]/ { @us = hist((nsecs - @start[tid]) / 1000); delete(@start[tid]); }'

# 追踪TCP连接（五元组）
bpftrace -e 'kprobe:tcp_connect { @[ntop(((struct sock *)arg0)->__sk_common.skc_daddr)] = count(); }'
```

---

### 8. eBPF 开发注意事项

| 限制 | 说明 | 应对 |
|------|------|------|
| 栈空间512字节 | 不能声明大数组 | 用Map存储大数据 |
| 无无限循环 | Verifier拒绝 | 用bounded loop (#pragma unroll) |
| 函数调用深度 | 最大8层 | 减少嵌套，用tail call |
| 不能调用任意内核函数 | 只能用BPF helper | 查阅bpf-helpers手册 |
| 指针必须边界检查 | Verifier强制 | 每次解引用前检查data_end |
| 不能sleep/阻塞 | BPF在中断上下文运行 | 耗时操作放用户态 |

---

### 总结

eBPF的核心价值：

1. **非侵入式内核观测**：不改内核、不重启服务，动态加载追踪程序
2. **XDP高性能网络**：网卡层处理包，单核20M pps，比iptables快10倍
3. **安全监控**：追踪所有系统调用、网络连接、文件访问，无法绕过
4. **性能分析**：精确测量任意内核函数延迟，生成直方图/火焰图
5. **Verifier保安全**：静态验证防止BPF程序crash内核
6. **CO-RE可移植**：一次编译，跨内核版本运行

eBPF不是"高级运维工具"，而是后端开发者的"内核透视镜"。当你的服务出了诡异的性能问题（偶发延迟、莫名丢包、系统调用卡顿），eBPF能让你在不影响生产的情况下，看到内核里到底发生了什么。
