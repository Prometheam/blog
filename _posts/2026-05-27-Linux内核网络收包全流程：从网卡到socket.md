---
layout: post_layout
title: "Linux内核网络收包全流程：从网卡到socket"
date: 2026-05-27 16:00:00 +0800
categories: [Linux系统]
location: 西安
excerpt_separator: "```"
---

### 引言

在做网关性能优化时，我遇到一个现象：CPU软中断（si%）占到40%，但用户态程序只用了20% CPU。大量算力浪费在了内核的网络包处理上。为了优化这个问题，我不得不深入理解Linux内核是如何收包的——从网卡中断到数据送达用户态socket，中间经历了哪些环节，每个环节的开销是多少。

这篇文章追踪一个网络包在Linux内核中的完整旅程，从硬件中断到应用层recv()，并在最后介绍GRO、RSS、XDP等高性能优化手段。

---

### 1. 收包全景：一个包的旅程

```
┌──────────────────────────────────────────────────────────────────────────┐
│                 网络包从网线到应用层的完整路径                              │
│                                                                          │
│  ① 网卡收到帧 → DMA写入Ring Buffer → 触发硬中断                         │
│        │                                                                 │
│        ▼                                                                 │
│  ② 硬中断处理(很短) → 关闭硬中断 → 触发软中断(NET_RX_SOFTIRQ)           │
│        │                                                                 │
│        ▼                                                                 │
│  ③ ksoftirqd线程处理软中断 → NAPI poll → 从Ring Buffer取包               │
│        │                                                                 │
│        ▼                                                                 │
│  ④ GRO合并 → netfilter/iptables → IP层路由决策                          │
│        │                                                                 │
│        ▼                                                                 │
│  ⑤ TCP/UDP协议栈处理 → 放入socket接收队列                               │
│        │                                                                 │
│        ▼                                                                 │
│  ⑥ 唤醒阻塞在recv()/epoll_wait()的用户进程                              │
│        │                                                                 │
│        ▼                                                                 │
│  ⑦ 用户态read()/recv() → 从socket队列拷贝数据到用户空间buffer            │
└──────────────────────────────────────────────────────────────────────────┘
```

---

### 2. 网卡与DMA

#### 2.1 Ring Buffer

网卡使用**环形缓冲区（Ring Buffer）**接收数据包。Ring Buffer由驱动在初始化时分配，是一组描述符（descriptor），每个描述符指向一个预分配的内存buffer：

```
┌────────────────────────────────────────────────────────────────┐
│                    RX Ring Buffer                                │
│                                                                │
│   ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐          │
│   │desc 0│→│desc 1│→│desc 2│→│desc 3│→│desc 4│→ ...        │
│   └──┬───┘  └──┬───┘  └──┬───┘  └──┬───┘  └──┬───┘          │
│      │         │         │         │         │               │
│      ▼         ▼         ▼         ▼         ▼               │
│   [buffer] [buffer] [buffer] [buffer] [buffer]               │
│   (已收包) (已收包) (空)     (空)     (空)                    │
│                      ↑                                        │
│                      │                                        │
│               NIC写入位置(tail)                                │
│      ↑                                                        │
│      │                                                        │
│   驱动处理位置(head)                                           │
│                                                                │
│   网卡通过DMA将数据写入buffer，更新tail指针                    │
│   驱动处理完后回收buffer，更新head指针                          │
│   head == tail → Ring Buffer空（包被处理完了）                 │
│   tail追上head → Ring Buffer满（来不及处理，丢包！）            │
└────────────────────────────────────────────────────────────────┘
```

```bash
# 查看Ring Buffer大小和使用情况
ethtool -g eth0
# Ring parameters for eth0:
# Pre-set maximums:
# RX:     4096
# Current hardware settings:
# RX:     256    ← 默认可能很小，高流量时需要增大

# 增大Ring Buffer（减少丢包概率）
ethtool -G eth0 rx 4096
```

#### 2.2 DMA写入过程

```
网卡收到完整以太网帧后：
  1. 读取Ring Buffer中下一个可用描述符（tail位置）
  2. 通过DMA将帧数据写入描述符指向的内存地址
  3. 更新描述符状态为"已完成"
  4. 递增tail指针
  5. 向CPU发起硬中断（通知有新包到达）

关键：DMA是网卡直接写主存，不经过CPU！
     CPU在整个写入过程中无感知，直到收到中断
```

---

### 3. 中断处理

#### 3.1 硬中断（Top Half）

硬中断处理必须极快（不能睡眠、不能做复杂处理），只做最少量工作：

```c
// 简化的网卡硬中断处理函数 (drivers/net/ethernet/intel/ixgbe/ixgbe_main.c)
static irqreturn_t ixgbe_msix_clean_rings(int irq, void *data)
{
    struct ixgbe_q_vector *q_vector = data;

    // 关键操作1: 禁用该队列的中断（避免中断风暴）
    ixgbe_irq_disable_queues(q_vector);

    // 关键操作2: 调度NAPI（触发软中断）
    napi_schedule(&q_vector->napi);

    return IRQ_HANDLED;
}
// 总耗时: < 1μs
```

#### 3.2 软中断（Bottom Half）与NAPI

硬中断仅触发软中断调度，真正的收包处理在软中断中（`ksoftirqd`内核线程或中断返回时）：

```
NAPI (New API) 机制：
  
传统方式（每个包一个中断）：
  包1到达 → 硬中断 → 处理 → 返回
  包2到达 → 硬中断 → 处理 → 返回   ← 万一每秒100万个包？100万次中断！
  包3到达 → 硬中断 → 处理 → 返回

NAPI方式（中断+轮询混合）：
  包1到达 → 硬中断 → 关中断 → 进入轮询模式
  连续poll: 处理包1, 包2, 包3, ..., 包N (批量处理，无中断开销)
  Ring Buffer空了 → 退出轮询 → 重新开启中断
  
  高流量: 大部分时间在poll模式（无中断开销）
  低流量: 包到达立即触发中断（低延迟）
```

```c
// NAPI poll函数（简化版）
static int ixgbe_poll(struct napi_struct *napi, int budget)
{
    int work_done = 0;

    // 从Ring Buffer中批量取包
    while (work_done < budget) {
        struct sk_buff *skb = ixgbe_fetch_rx_buffer(ring);
        if (!skb) break;  // Ring Buffer空了

        // 基本校验和协议识别
        ixgbe_process_skb_fields(skb);

        // 送入上层协议栈
        napi_gro_receive(napi, skb);
        work_done++;
    }

    // 处理量 < budget → Ring Buffer已空 → 退出轮询，开启中断
    if (work_done < budget) {
        napi_complete(napi);
        ixgbe_irq_enable_queues(q_vector);  // 重新开启中断
    }

    return work_done;
}
// budget默认64：每次poll最多处理64个包
// 超过64个？下次软中断继续处理（避免软中断长时间占用CPU）
```

---

### 4. 协议栈处理

#### 4.1 GRO（Generic Receive Offload）

在送入IP层之前，GRO尝试将多个小包合并为一个大包，减少协议栈处理次数：

```
GRO合并示例：

收到: TCP包1 (payload 1460B, seq=0)
收到: TCP包2 (payload 1460B, seq=1460)
收到: TCP包3 (payload 1460B, seq=2920)

GRO合并后: 一个大TCP包 (payload 4380B, seq=0)
           只需要经过一次IP/TCP协议栈处理！

合并条件：
  - 同一个TCP流（相同5元组）
  - 序号连续
  - 相同的TCP flags
  
性能收益：
  不开GRO: 每个1460B包经过一次完整协议栈 → 小包越多开销越大
  开GRO:   合并后走一次协议栈 → 高吞吐场景下显著减少CPU开销
```

#### 4.2 netfilter/iptables

包通过GRO后进入IP层，netfilter在多个hook点拦截：

```
                     ┌───────────────────────────────┐
                     │        netfilter hooks         │
                     │                               │
  收包 → [PREROUTING] → 路由决策 → [INPUT] → 本机协议栈
                              │
                              └→ [FORWARD] → [POSTROUTING] → 转发出去
                              
  每个hook点可以有多条iptables规则
  规则多 → 每个包都要逐条匹配 → CPU开销！
  
  生产教训：
  某次iptables有2000+条规则，每个包遍历 → 单核30%CPU浪费在netfilter
  解决：用ipset替代大量规则，O(n)→O(1)
```

#### 4.3 TCP协议栈处理

```c
// 包到达TCP层后的处理（net/ipv4/tcp_input.c 简化）
int tcp_rcv_established(struct sock *sk, struct sk_buff *skb)
{
    struct tcp_sock *tp = tcp_sk(sk);

    // 1. 快速路径检查（Fast Path）
    //    大部分包是正常的数据包，走快速路径
    if (tcp_fast_path_check(tp, skb)) {
        // 序号检查
        // 更新窗口
        // ACK处理（释放发送缓冲区）
        // 数据入队
        tcp_queue_rcv(sk, skb);  // 放入socket接收队列
        
        // 唤醒等待的进程
        sk->sk_data_ready(sk);
        return 0;
    }

    // 2. 慢速路径（乱序、重传、窗口探测等异常情况）
    return tcp_rcv_slow_path(sk, skb);
}
```

---

### 5. Socket接收队列与用户态

#### 5.1 sk_buff结构

`sk_buff`是Linux网络栈的核心数据结构，贯穿整个收包路径：

```
┌──────────────────────────────────────────────────────────────┐
│                    sk_buff 结构                                │
│                                                              │
│  ┌─────────────┐                                            │
│  │ sk_buff元数据│ protocol, dev, tstamp, mark...            │
│  ├─────────────┤                                            │
│  │ head        │──→ ┌────────────────────────────────┐      │
│  │ data        │──→ │ headroom │ L2 │ L3 │ L4 │ payload │   │
│  │ tail        │──→ │          │eth │ip  │tcp │  data   │   │
│  │ end         │──→ └────────────────────────────────┘      │
│  ├─────────────┤         ↑                                  │
│  │ transport_hdr│─────────┘  (指向TCP/UDP头)                │
│  │ network_hdr │─────────── (指向IP头)                      │
│  │ mac_hdr     │─────────── (指向以太网头)                  │
│  └─────────────┘                                            │
│                                                              │
│  设计精妙之处：                                              │
│  - 头部指针递进：剥离一层头部只需移动指针，不拷贝数据        │
│  - headroom预留：如果需要封装隧道头，向前扩展即可            │
│  - 引用计数：同一个skb可以被多个子系统引用                   │
└──────────────────────────────────────────────────────────────┘
```

#### 5.2 Socket接收队列

```
TCP socket有三个队列接收数据：

┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  1. receive_queue（接收队列）                                │
│     └── 有序的、可以直接读取的数据                          │
│     └── recv()/read()从这里取数据                           │
│                                                             │
│  2. backlog队列                                             │
│     └── socket被用户进程锁定时，新到的包暂存这里            │
│     └── 用户进程释放锁后处理backlog                         │
│                                                             │
│  3. out_of_order_queue（乱序队列）                           │
│     └── 序号不连续的包暂存这里                              │
│     └── 等缺失的包到达后重新排序合并到receive_queue         │
│                                                             │
└─────────────────────────────────────────────────────────────┘

用户态read()的过程：
  1. 检查receive_queue是否有数据
  2. 有 → 拷贝数据到用户空间buffer → 返回
  3. 无 → 阻塞等待（或非阻塞返回EAGAIN）
  
  拷贝！这是最后一次数据拷贝：
  内核空间sk_buff数据 → 用户空间buffer
  （这就是为什么有zero-copy方案：避免这次拷贝）
```

---

### 6. 高性能优化技术

#### 6.1 RSS（Receive Side Scaling）

```
问题：单CPU核处理所有网络中断 → 单核瓶颈

RSS：网卡硬件将不同的流分散到不同的CPU核处理

┌────────────────────────────────────────────────────────────┐
│                    RSS多队列                                 │
│                                                            │
│  网卡                                                      │
│  ┌───────────────────────────────────────────┐            │
│  │  收到包 → Hash(src_ip, dst_ip, src_port,  │            │
│  │           dst_port, protocol)              │            │
│  │         → hash % N 决定放入哪个队列        │            │
│  └───────┬────────────┬────────────┬─────────┘            │
│          │            │            │                       │
│       Queue 0      Queue 1      Queue 2                   │
│          │            │            │                       │
│       IRQ → CPU0   IRQ → CPU1   IRQ → CPU2               │
│                                                            │
│  同一个TCP流的所有包 → 同一个队列 → 同一个CPU             │
│  （保证处理顺序，同时利用多核）                             │
└────────────────────────────────────────────────────────────┘
```

```bash
# 查看网卡队列数
ethtool -l eth0
# Combined:       8  ← 当前8个队列

# 查看中断绑定
cat /proc/interrupts | grep eth0
# 检查IRQ是否分散到不同CPU

# 设置IRQ亲和性（手动绑定队列到CPU）
echo 1 > /proc/irq/30/smp_affinity   # 队列0 → CPU0
echo 2 > /proc/irq/31/smp_affinity   # 队列1 → CPU1
echo 4 > /proc/irq/32/smp_affinity   # 队列2 → CPU2

# 或者使用irqbalance自动均衡
systemctl start irqbalance
```

#### 6.2 XDP（eXpress Data Path）

XDP是Linux最快的包处理路径——在驱动层（NAPI poll之前）直接处理包，跳过整个协议栈：

```
传统路径：
  网卡 → DMA → Ring Buffer → 硬中断 → NAPI → GRO → IP → TCP → socket
  延迟: ~10μs, 处理能力: ~1-5 Mpps/core

XDP路径：
  网卡 → DMA → Ring Buffer → 硬中断 → NAPI → [XDP程序] → 决策
                                                │
                            ┌───────────────────┼────────────────┐
                            │                   │                │
                         XDP_DROP           XDP_TX          XDP_PASS
                         (直接丢弃)        (原路返回)      (继续正常路径)
  
  延迟: ~2-3μs, 处理能力: ~10-24 Mpps/core
```

```c
// XDP程序示例：简单的DDoS过滤
// 编译为BPF字节码，加载到网卡驱动

SEC("xdp")
int xdp_ddos_filter(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    // 解析以太网头
    struct ethhdr *eth = data;
    if ((void*)(eth + 1) > data_end)
        return XDP_PASS;

    // 只处理IPv4
    if (eth->h_proto != htons(ETH_P_IP))
        return XDP_PASS;

    // 解析IP头
    struct iphdr *ip = (void*)(eth + 1);
    if ((void*)(ip + 1) > data_end)
        return XDP_PASS;

    // 查询黑名单（BPF map）
    __u32 src_ip = ip->saddr;
    __u32 *blocked = bpf_map_lookup_elem(&blacklist_map, &src_ip);
    if (blocked && *blocked > 0) {
        return XDP_DROP;  // 在驱动层直接丢弃，无任何内核开销
    }

    return XDP_PASS;  // 正常包继续走内核协议栈
}
```

```bash
# 加载XDP程序
ip link set dev eth0 xdp obj xdp_filter.o sec xdp

# 查看统计
bpftool prog show
bpftool map dump id 1  # 查看黑名单map
```

#### 6.3 各优化方案对比

```
┌─────────────────────────────────────────────────────────────────────┐
│              高性能网络优化方案对比                                    │
├──────────────┬──────────┬──────────────────┬────────────────────────┤
│ 方案         │ 层级     │ 性能             │ 适用场景               │
├──────────────┼──────────┼──────────────────┼────────────────────────┤
│ 增大Ring Buf │ 驱动     │ 减少丢包         │ 突发流量场景           │
│ RSS多队列    │ 网卡硬件 │ 多核并行处理     │ 所有高流量场景         │
│ GRO          │ 驱动     │ 减少协议栈调用   │ 大数据量TCP传输       │
│ 减少iptables │ IP层     │ 减少规则匹配     │ 规则过多时             │
│ SO_REUSEPORT │ Socket   │ 多进程负载均衡   │ 多worker架构           │
│ XDP          │ 驱动     │ 10M+ pps/core    │ 防火墙/负载均衡/过滤  │
│ DPDK         │ 用户态   │ 线速处理         │ 专用网络设备           │
│ io_uring     │ 系统调用 │ 减少用户态切换   │ 高并发socket IO       │
└──────────────┴──────────┴──────────────────┴────────────────────────┘
```

---

### 7. 实战：用bpftrace追踪收包路径

#### 7.1 追踪单个包的处理延迟

```bash
# 追踪从软中断到socket的延迟
bpftrace -e '
kprobe:netif_receive_skb_core {
    @start[arg0] = nsecs;
}

kprobe:tcp_queue_rcv {
    $skb = arg1;
    if (@start[$skb]) {
        $latency = (nsecs - @start[$skb]) / 1000;
        @usecs = hist($latency);
        delete(@start[$skb]);
    }
}
'

# 输出延迟分布直方图：
# @usecs:
# [1, 2)     1234 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@   |
# [2, 4)      567 |@@@@@@@@@@@@@@                     |
# [4, 8)      123 |@@@                                |
# [8, 16)      45 |@                                  |
```

#### 7.2 定位丢包位置

```bash
# 追踪内核中所有kfree_skb调用（包被释放=丢包）
bpftrace -e '
kprobe:kfree_skb_reason {
    @drops[kstack] = count();
}

interval:s:5 {
    print(@drops);
    clear(@drops);
}
'

# 输出会显示哪些内核函数调用了kfree_skb
# 常见丢包位置：
#   netfilter规则DROP
#   socket接收队列满（sk_rcvbuf溢出）
#   TCP校验和错误
#   Ring Buffer满（网卡层面）
```

---

### 8. 总结

```
收包路径的性能开销分布（典型服务器，单包平均）：

┌────────────────────────┬─────────────┬────────────────────────┐
│ 阶段                   │ 耗时占比    │ 优化手段               │
├────────────────────────┼─────────────┼────────────────────────┤
│ 硬中断+调度            │ ~5%         │ MSI-X多队列            │
│ 软中断(NAPI poll)      │ ~15%        │ Busy polling           │
│ GRO/协议解析           │ ~10%        │ GRO合包                │
│ netfilter              │ ~5-30%      │ ipset/减少规则/XDP     │
│ TCP协议栈              │ ~20%        │ 难优化（核心逻辑）     │
│ 数据拷贝到用户态       │ ~20%        │ zero-copy/io_uring     │
│ 用户态处理             │ ~20%        │ 应用层优化             │
└────────────────────────┴─────────────┴────────────────────────┘
```

核心认知：

1. **NAPI机制**是Linux网络高性能的基石——中断+轮询混合，避免中断风暴
2. **RSS多队列**是多核利用的关键——同一条流的包始终在同一个CPU处理
3. **GRO合包**减少协议栈处理次数——对大流量TCP传输效果显著
4. **XDP**是终极武器——在驱动层直接处理，跳过整个内核协议栈
5. **不要凭感觉优化**——用bpftrace/perf追踪确认瓶颈在哪个环节

理解了这条收包路径，你就能准确判断性能瓶颈在哪一层，选择正确的优化手段，而不是盲目加机器。
