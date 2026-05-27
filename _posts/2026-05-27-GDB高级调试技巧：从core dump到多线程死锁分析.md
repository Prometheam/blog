---
layout: post_layout
title: "GDB高级调试技巧：从core dump到多线程死锁分析"
date: 2026-05-27 05:30:00 +0800
categories: [C++语言]
location: 西安
excerpt_separator: "```"
---

九年 C++ 后端生涯，GDB 是我用得最多的工具之一。从最初只会 `bt` 看堆栈，到现在用 Python 脚本批量分析、用反向调试定位竞态，GDB 的深度远超多数人的想象。今天分享一些生产环境中真正实用的高级技巧。

## Core Dump 配置与分析

生产服务崩溃时，core dump 是唯一的"犯罪现场"。首先确保配置正确：

```bash
# 允许生成core文件（不限大小）
ulimit -c unlimited

# 设置core文件路径和命名模式
echo "/data/coredumps/core.%e.%p.%t" > /proc/sys/kernel/core_pattern

# systemd环境用coredumpctl
coredumpctl list                    # 列出最近的core
coredumpctl gdb <PID>              # 直接用gdb打开
coredumpctl info <PID>             # 查看崩溃信息摘要
```

打开 core 文件的标准流程：

```bash
gdb ./my_server /data/coredumps/core.my_server.12345.1716789000
(gdb) bt                           # 查看崩溃线程的调用栈
(gdb) info threads                 # 查看所有线程
(gdb) thread apply all bt          # 打印所有线程的堆栈
(gdb) frame 3                      # 切换到第3帧
(gdb) info locals                  # 查看局部变量
(gdb) p *this                      # 打印当前对象
```

## 调试优化后的代码

生产环境通常用 `-O2` 编译，这给调试带来了麻烦：

```
┌─────────────────────────────────────────────┐
│ -O2 带来的调试困难                            │
├─────────────────────────────────────────────┤
│ • 变量 "optimized out" → 被寄存器替代或消除   │
│ • 函数被 inline → 栈帧中看不到               │
│ • 代码重排 → 单步执行跳来跳去                 │
│ • 尾调用优化 → 栈帧被复用                    │
└─────────────────────────────────────────────┘
```

应对策略：

```bash
# 编译时加 -g 保留调试信息（-O2 -g 可以共存）
# 对关键变量使用 volatile 防止被优化掉（仅调试时）

(gdb) info registers              # 变量被优化掉时看寄存器
(gdb) disas                       # 看汇编确认实际执行逻辑
(gdb) info line *0x4a3b20         # 地址反查源代码行
(gdb) set disassembly-flavor intel # 用Intel语法看汇编
```

我的建议：生产环境保持 `-O2 -g`，debuginfo 单独打包（`objcopy --only-keep-debug`），出问题时再关联。

## 多线程死锁分析

这是 GDB 最有价值的场景之一。一个真实案例——服务卡死不响应：

```bash
(gdb) thread apply all bt

# 看到多个线程卡在锁上：
Thread 5 (LWP 23401):
#0  __lll_lock_wait () at lowlevellock.S:49
#1  pthread_mutex_lock () at pthread_mutex_lock.c:80
#2  ConnectionPool::acquire() at conn_pool.cpp:45  # 等待 pool_mutex_

Thread 8 (LWP 23404):
#0  __lll_lock_wait () at lowlevellock.S:49
#1  pthread_mutex_lock () at pthread_mutex_lock.c:80
#2  Logger::write() at logger.cpp:78               # 等待 log_mutex_

Thread 5 持有 log_mutex_ 等待 pool_mutex_
Thread 8 持有 pool_mutex_ 等待 log_mutex_
→ 经典的 AB-BA 死锁！
```

快速定位锁持有者：

```bash
(gdb) p pool_mutex_
$1 = {__data = {__lock = 2, __owner = 23404, ...}}
# __owner 就是持有该锁的线程 LWP ID

(gdb) thread find 23404            # 找到持有者线程
(gdb) thread 8                     # 切换过去看它在等什么
```

## 条件断点与观察点

普通断点在高并发服务中会被频繁命中，条件断点精确过滤：

```bash
# 只在特定连接ID时断住
(gdb) break request_handler.cpp:120 if conn_id == 42

# 只在第100次命中时断住
(gdb) break hot_path.cpp:50
(gdb) ignore 1 99

# 观察点：某个内存地址被修改时断住（硬件辅助，几乎无开销）
(gdb) watch *(int*)0x7fff5a3b4c00
(gdb) rwatch buffer[1024]          # 读时断住
(gdb) awatch shared_counter        # 读或写时断住
```

watchpoint 是找内存踩踏的利器——当你知道某个变量被"莫名修改"但不知道是谁，设个 watchpoint 让 GDB 帮你抓现行。

## GDB Python 脚本

GDB 内置 Python 解释器，可以写自定义命令和 pretty-printer：

```python
# ~/.gdbinit 或单独的 .py 文件
import gdb

class DumpAllMutexes(gdb.Command):
    """打印所有 pthread_mutex 的持有者"""
    def __init__(self):
        super().__init__("dump-mutexes", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        # 遍历已知的mutex变量
        for sym in ['pool_mutex_', 'log_mutex_', 'queue_mutex_']:
            try:
                val = gdb.parse_and_eval(sym)
                owner = val['__data']['__owner']
                lock = val['__data']['__lock']
                print(f"{sym}: locked={lock}, owner_lwp={owner}")
            except:
                pass

DumpAllMutexes()
```

我在项目中还写过自定义 pretty-printer，让 `p my_buffer` 自动显示为可读的十六进制 dump 而不是一堆数字。

## 反向调试（Record and Replay）

GDB 支持记录执行过程然后"倒带"：

```bash
(gdb) record                       # 开始记录
(gdb) continue                     # 运行到崩溃点
(gdb) reverse-continue             # 反向执行到上一个断点
(gdb) reverse-step                 # 反向单步
(gdb) reverse-next                 # 反向逐过程

# 配合watchpoint：谁最后修改了这个变量？
(gdb) watch -l corrupted_var
(gdb) reverse-continue             # 回到最后一次修改处
```

注意：record 模式性能下降严重（10-100x），只适合复现后定点分析。生产环境推荐用 `rr`（Mozilla 出品），它的录制开销只有约 2x。

## 远程调试

容器化环境下，服务跑在精简镜像里没有调试工具：

```bash
# 容器内启动 gdbserver
gdbserver :9999 --attach <PID>

# 宿主机连接
gdb ./my_server
(gdb) target remote 172.17.0.2:9999
(gdb) set sysroot /path/to/container/rootfs  # 指定符号路径
```

## ASan + GDB 联合使用

Address Sanitizer 检测到问题时会打印报告然后 abort。设置在 abort 时进入 GDB：

```bash
ASAN_OPTIONS="abort_on_error=1" gdb ./my_server
(gdb) run
# ASan检测到问题 → 收到SIGABRT → 自动断住
(gdb) bt                           # 看到完整的越界访问调用栈
(gdb) frame 2
(gdb) p buffer_size                # 检查为什么越界
```

## 实战：定位生产死锁

最后分享一个完整流程。上周服务半夜卡死，早上分析 core：

```bash
# 1. 获取core（服务被watchdog kill -ABRT后生成）
coredumpctl gdb my_rpc_server

# 2. 全量堆栈扫描
(gdb) thread apply all bt full > /tmp/all_stacks.txt

# 3. 找到卡在锁上的线程
(gdb) thread apply all bt | grep -A5 "lll_lock_wait"

# 4. 对每个等锁的线程，查它等的是哪把锁
(gdb) frame 1
(gdb) info args                    # 看mutex地址

# 5. 查锁的owner
(gdb) p *(pthread_mutex_t*)0x55a3bc4560

# 6. 画出等待图，找到环 → 确认死锁
```

最终发现是新加的 metrics 采集代码在持有业务锁时调用了 log，而 log 内部又要获取 metrics 锁，形成了环路。修复方案：log 调用移到释放业务锁之后。

## 小结

GDB 不只是一个"设断点看变量"的工具，它是一个完整的调试平台。掌握条件断点、watchpoint、Python 脚本、反向调试这些高级特性，能让你从"猜测式 printf 调试"升级到"精确定位根因"。核心原则：**让工具帮你收窄问题范围，而不是用肉眼扫代码**。
