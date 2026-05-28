---
layout: post_layout
title: "Linux内存管理：从虚拟内存到OOM Killer"
date: 2026-05-26 15:00:00 +0800
categories: [Linux系统]
location: 西安
excerpt_separator: "```"
---

上周我们线上一台机器触发了 OOM Killer，把主服务进程杀掉了。事后排查发现是内存 overcommit 配置不当加上 THP 导致的内存碎片问题。借这个机会系统地梳理一下 Linux 内存管理，这些知识对后端开发非常实用。

## 虚拟内存与页表

x86-64 上采用 4 级页表将 48 位虚拟地址映射到物理地址：

```
虚拟地址 (48bit):
┌────────┬────────┬────────┬────────┬──────────┐
│ PGD(9) │ PUD(9) │ PMD(9) │ PTE(9) │ Offset(12)│
└────┬───┴────┬───┴────┬───┴────┬───┴──────────┘
     │        │        │        │
     ▼        ▼        ▼        ▼
  Page Global → Page Upper → Page Middle → Page Table Entry
  Directory    Directory    Directory      → 物理页帧

每级9bit = 512个条目, 每个条目8字节 = 4KB一个页表页
一个进程最多: 512 × 512 × 512 × 512 × 4KB = 256TB 虚拟空间
```

关键点：页表本身也占物理内存。一个映射了大量稀疏虚拟地址的进程（比如用 mmap 分配了很多小块），页表开销可能达到几百MB。

## Memory Overcommit

Linux 默认允许进程申请超过物理内存+Swap 总量的虚拟内存，因为大多数程序申请了并不会全部用到（想想 malloc 一个大数组但只用了前几页）。

```
vm.overcommit_memory:
  0 (默认) - 启发式判断，允许"合理"的overcommit
  1 - 永远允许，不检查（适合知道自己在做什么的场景）
  2 - 严格模式: 总commit不超过 swap + RAM * overcommit_ratio/100

vm.overcommit_ratio = 50 (默认)
  → 最大可提交: swap_size + physical_ram × 50%
```

我们的服务器跑的是内存密集型应用，我一般设置 `overcommit_memory=2` 加 `overcommit_ratio=80`，让 malloc 在真正没内存时直接返回失败，而不是先成功后被 OOM Kill。

## 页面错误类型

进程访问已映射但未分配物理页的虚拟地址时触发 page fault：

```
Page Fault
    │
    ├── Minor Fault (软缺页)
    │   └── 页在page cache中，只需更新页表
    │       延迟: ~1μs
    │
    └── Major Fault (硬缺页)
        └── 需要从磁盘读取（swap或文件映射）
            延迟: ~1-10ms (HDD) / ~50-200μs (SSD)
```

监控 major fault 很重要——如果一个进程 majflt 频率突然上升，说明它在和别的进程抢内存，或者 working set 超过了可用物理内存。

## 内存区域划分

```
物理内存布局 (x86-64):
┌──────────────┐ 0
│   DMA Zone   │ 0 - 16MB (ISA DMA设备使用)
├──────────────┤
│  DMA32 Zone  │ 16MB - 4GB (32位DMA设备)
├──────────────┤
│  Normal Zone │ 4GB - 最大物理内存 (主要使用区域)
└──────────────┘

注: x86-64 没有 HighMem zone (那是32位时代的产物)
```

## THP：双刃剑

Transparent Huge Pages 用 2MB 大页替代 4KB 小页，减少 TLB miss。但对数据库类应用经常是坑：

```
THP 问题:
1. 内存碎片化 → khugepaged 后台合并 → CPU毛刺
2. 写时复制一个huge page = 复制2MB (vs 4KB)
3. 内存膨胀: 即使只需5KB也会分配2MB

建议:
  # 对Redis/MySQL/MongoDB类应用:
  echo never > /sys/kernel/mm/transparent_hugepage/enabled
  echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

这次线上事故就跟 THP 有关——服务 fork 子进程做数据快照时触发大量 2MB 粒度的 COW，内存瞬间翻倍。

## 内存回收机制

当 free 内存低于水位线时，内核启动回收：

```
内存水位:
  high ─── 正常状态，不回收
  low  ─── kswapd 被唤醒，后台异步回收
  min  ─── 直接回收(direct reclaim)，分配路径同步回收
             此时进程会被阻塞! 延迟会飙升

回收优先级:
  1. Page Cache (clean pages直接丢弃)
  2. Page Cache (dirty pages需要先写回)
  3. Anonymous pages → swap out
  4. 如果都不够 → OOM Killer
```

## OOM Killer 评分机制

内核通过 `oom_score` 选择要杀的进程，分数越高越容易被杀：

```
oom_score 计算 (简化):
  基础分 = 进程RSS占总内存的比例 × 1000
  调整分 = oom_score_adj (-1000 ~ 1000)
  最终分 = 基础分 + 调整分

保护关键服务:
  # 让主服务不被OOM Kill (设为-900而非-1000，留余地)
  echo -900 > /proc/<pid>/oom_score_adj

  # systemd服务:
  [Service]
  OOMScoreAdjust=-900
```

注意：`oom_score_adj=-1000` 完全禁止被 OOM Kill，但如果所有进程都这样设置，内核会 panic。

## 实战诊断

当线上出现内存压力时，我的排查流程：

```bash
# 1. 整体内存状态
$ cat /proc/meminfo | grep -E "MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree"

# 2. 内存压力指标 (Linux 4.20+)
$ cat /proc/pressure/memory
some avg10=0.00 avg60=2.35 avg300=1.82 total=892736
full avg10=0.00 avg60=0.89 avg300=0.52 total=341209
# some>0 表示有进程因内存等待; full>0 表示所有进程都在等

# 3. 找内存大户
$ ps aux --sort=-%mem | head -10

# 4. 具体进程内存构成
$ cat /proc/<pid>/status | grep -E "VmRSS|VmSwap|RssAnon|RssFile|RssShmem"

# 5. vmstat观察趋势 (si/so是swap in/out, 非零说明在换页)
$ vmstat 1
procs -----------memory---------- ---swap-- -----io----
 r  b   swpd   free   buff  cache   si   so    bi    bo
 2  0  10240  51200  32000 512000    0    0     4    12
```

经过这次事故，我们做了几个改进：1）所有服务设置 `oom_score_adj=-500`；2）关闭 THP；3）添加了内存压力的 Prometheus 告警（基于 PSI 指标）；4）设置 `overcommit_memory=2`。之后再没被 OOM Killer 搞过。理解内存管理的底层机制，是排查这类问题的基础。
