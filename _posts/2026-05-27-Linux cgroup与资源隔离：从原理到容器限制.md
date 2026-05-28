---
layout: post_layout
title: "Linux cgroup与资源隔离：从原理到容器限制"
date: 2026-05-27 01:00:00 +0800
categories: [Linux系统]
location: 西安
excerpt_separator: "```"
---

作为后端开发，理解cgroup是理解容器资源限制的基础。当你的服务在K8s中被OOM Kill或CPU被throttle时，底层都是cgroup在起作用。本文从cgroup原理出发，讲清楚资源隔离的机制和实战中的坑。

## cgroup v1 vs v2

Linux内核提供了两代cgroup实现：

```
cgroup v1（层级式，每个controller独立树）：
/sys/fs/cgroup/
├── cpu/
│   └── docker/
│       └── container_abc/
│           ├── cpu.cfs_quota_us
│           └── cpu.shares
├── memory/
│   └── docker/
│       └── container_abc/
│           └── memory.limit_in_bytes
└── blkio/

cgroup v2（统一层级，单棵树）：
/sys/fs/cgroup/
└── system.slice/
    └── docker-abc.scope/
        ├── cpu.max          (替代 cfs_quota_us + cfs_period_us)
        ├── memory.max       (替代 memory.limit_in_bytes)
        └── io.max           (替代 blkio)
```

v2的核心改进：统一层级避免了v1中不同controller对进程分组不一致的问题；新增PSI（Pressure Stall Information）接口提供资源压力指标。目前主流发行版和K8s 1.25+已默认使用v2。

## CPU控制器

CPU资源限制有三种机制：

```
┌─────────────────────────────────────────────────┐
│ cpu.shares (权重，软限制)                         │
│   默认1024，按比例分配空闲CPU                     │
│   例：A=1024, B=2048 → B获得2倍的CPU时间          │
├─────────────────────────────────────────────────┤
│ cpu.cfs_quota_us / cpu.cfs_period_us (硬限制)    │
│   quota=200000, period=100000 → 最多用2个核       │
│   对应K8s的 resources.limits.cpu: "2"            │
├─────────────────────────────────────────────────┤
│ cpuset.cpus (绑核)                               │
│   cpuset.cpus=0-3 → 只能运行在CPU 0~3            │
│   适合延迟敏感型服务，避免跨NUMA调度              │
└─────────────────────────────────────────────────┘
```

## Memory控制器

```bash
# v1 设置内存限制
echo 1073741824 > /sys/fs/cgroup/memory/mygroup/memory.limit_in_bytes  # 1GB

# v2 等价写法
echo "max 1073741824" > /sys/fs/cgroup/mygroup/memory.max
```

关键文件解读：

```bash
cat /sys/fs/cgroup/memory/mygroup/memory.stat
# cache 524288000      ← Page Cache（可回收）
# rss 234567890        ← 实际物理内存占用
# swap 0
# pgfault 12345678     ← 缺页次数
# inactive_anon 56789  ← 不活跃匿名页（OOM时优先回收）
```

**OOM行为**：当cgroup内存使用达到limit时，内核首先尝试回收Page Cache；若仍不足则触发cgroup OOM Killer，选择cgroup内oom_score最高的进程杀死。注意这和系统级OOM Killer是独立的。

## IO控制器

```bash
# 限制某块设备的读写带宽（v2）
echo "8:0 rbps=10485760 wbps=10485760" > /sys/fs/cgroup/mygroup/io.max
# 8:0 是设备号(major:minor)，限制读写各10MB/s

# 限制IOPS
echo "8:0 riops=1000 wiops=1000" > /sys/fs/cgroup/mygroup/io.max
```

## Docker/K8s如何映射到cgroup

K8s的资源模型与cgroup的对应关系：

```yaml
# K8s Pod Spec
resources:
  requests:            # 调度依据 + cpu.shares权重
    cpu: "500m"        # → cpu.shares = 512 (500/1000 * 1024)
    memory: "256Mi"    # → 影响调度，不直接设cgroup
  limits:              # 硬限制
    cpu: "2"           # → cpu.cfs_quota_us = 200000
    memory: "1Gi"      # → memory.limit_in_bytes = 1073741824
```

**重要区别**：requests影响调度决策和shares权重，limits才是真正的cgroup硬限制。设置requests不设limits时，CPU不会被throttle，但可能在节点繁忙时被抢占。

## CPU Throttle：最常见的性能陷阱

我们线上服务曾出现周期性延迟毛刺，排查发现是CPU throttle：

```bash
cat /sys/fs/cgroup/cpu/docker/abc123/cpu.stat
# nr_periods 1856432
# nr_throttled 23456    ← 被限流的调度周期数
# throttled_time 8923456789  ← 累计被限流的纳秒数

# throttle比率 = nr_throttled / nr_periods
# 超过5%就需要关注
```

典型场景：Go/Java GC或C++服务中的周期性大任务（如日志flush、统计聚合）在短时间内突破quota，即使平均CPU使用率很低也会被throttle。

解决方案：
1. 适当放大limits（如实际使用1核，limits设2核）
2. 对延迟敏感服务使用cpuset绑核，不设quota
3. 将突发任务拆分为多个小批次

## 实战：为C++服务配置资源限制

```bash
#!/bin/bash
# 创建cgroup v2资源组
CGROUP="/sys/fs/cgroup/my_cpp_service"
mkdir -p $CGROUP

# CPU：最多使用1.5核，保证至少0.5核
echo "150000 100000" > $CGROUP/cpu.max    # 硬限制1.5核
echo "512" > $CGROUP/cpu.weight           # 权重(v2中shares变为weight)

# 内存：限制4GB，超出直接OOM
echo "4294967296" > $CGROUP/memory.max
echo "3758096384" > $CGROUP/memory.high   # 3.5GB时触发回收压力

# IO：限制磁盘写入带宽
echo "259:0 wbps=52428800" > $CGROUP/io.max  # 50MB/s写入限制

# 将进程加入cgroup
echo $PID > $CGROUP/cgroup.procs
```

`memory.high`是v2新增的软限制：达到时内核积极回收该cgroup的内存，造成分配变慢但不会OOM Kill。这比直接触发OOM要温和得多。

## 监控cgroup指标做容量规划

我在Prometheus中监控以下cgroup指标：

```
# CPU throttle率 > 5% 告警
rate(container_cpu_cfs_throttled_periods_total[5m])
/ rate(container_cpu_cfs_periods_total[5m]) > 0.05

# 内存使用率 > 80% 告警
container_memory_working_set_bytes
/ container_spec_memory_limit_bytes > 0.8

# PSI压力指标（v2特有）
# some: 至少有一个任务因资源不足而阻塞的时间比例
# full: 所有任务都因资源不足而阻塞的时间比例
cat /sys/fs/cgroup/mygroup/memory.pressure
# some avg10=2.35 avg60=1.56 avg300=0.89 total=45678
# full avg10=0.12 avg60=0.08 avg300=0.03 total=1234
```

PSI指标比简单的使用率更能反映服务是否真的受到资源限制。`memory.pressure`的some值持续>10说明内存确实成为了瓶颈。

## 总结

理解cgroup让你能够：
- 设置合理的K8s requests/limits，避免throttle和OOM
- 快速诊断容器内性能问题的根因
- 为服务做精确的容量规划

核心经验：**limits不是设得越紧越好**。过紧的CPU limit导致throttle引发延迟毛刺，过紧的memory limit导致频繁OOM重启。建议limits设为实际峰值的1.5-2倍，通过监控数据逐步收紧。
