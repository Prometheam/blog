---
layout: post_layout
title: "TCP半连接队列与全连接队列：从SYN Flood到内核调优"
date: 2026-05-26 11:00:00 +0800
categories: [网络协议]
location: 西安
excerpt_separator: "```"
---

搞后端开发，TCP连接管理是绕不开的话题。最近排查了一个线上服务连接失败率飙升的问题，根因是全连接队列溢出。借这个机会，把TCP两个队列的机制、攻防和调优系统讲一遍。

## 三次握手与两个队列

TCP建立连接时，内核维护两个队列来管理不同阶段的连接：

```
Client                     Server
  │                          │
  │──── SYN ────────────────→│ ← 进入SYN队列(半连接队列)
  │                          │   状态: SYN_RECV
  │←─── SYN+ACK ────────────│
  │                          │
  │──── ACK ────────────────→│ ← 移入Accept队列(全连接队列)
  │                          │   状态: ESTABLISHED
  │                          │
  │            ┌─────────────┤
  │            │ accept()    │ ← 应用层取走连接
  │            └─────────────┤
  │                          │

┌────────────────────────────────────────────┐
│  SYN Queue (半连接队列)                      │
│  - 存放收到SYN但未完成握手的连接              │
│  - 大小: tcp_max_syn_backlog                │
│  - 超时: SYN+ACK重传后丢弃                  │
├────────────────────────────────────────────┤
│  Accept Queue (全连接队列)                   │
│  - 存放已完成三次握手等待accept()的连接       │
│  - 大小: min(backlog, somaxconn)            │
│  - 满时: 根据tcp_abort_on_overflow决定行为  │
└────────────────────────────────────────────┘
```

## 半连接队列与SYN Cookies

当SYN队列满时，正常的新SYN包会被丢弃。攻击者正是利用这一点发起SYN Flood攻击——发送大量伪造源IP的SYN包，填满半连接队列，导致正常连接无法建立。

**SYN Cookies**是内核的防御机制：队列满时不分配资源，而是将连接信息编码到SYN+ACK的序列号中。收到第三次ACK时从序列号解码出连接信息，直接建立连接。

```
SYN Cookie编码：
┌─────────────────────────────────────────┐
│ ISN = hash(saddr, daddr, sport, dport,  │
│            secret) + timestamp           │
│                                          │
│ 高5位: 时间戳(分钟级)                     │
│ 中3位: MSS编码                            │
│ 低24位: 加密hash                          │
└─────────────────────────────────────────┘
```

代价是：SYN Cookies无法携带TCP选项（Window Scale、SACK等），开启后性能略有影响。所以默认只在队列满时才激活。

## 全连接队列溢出

Accept队列满时，内核行为取决于`tcp_abort_on_overflow`：
- **=0（默认）**：丢弃ACK，客户端会重传，有机会恢复
- **=1**：发送RST，客户端立即收到"Connection Reset"

最阴险的是默认行为——客户端以为连接建立成功（已发送ACK），开始发数据，但服务端没有这个连接，导致超时或RST。

## 关键内核参数

```bash
# 查看/调整半连接队列大小
sysctl net.ipv4.tcp_max_syn_backlog
# 默认128或256，高并发服务建议调到4096+

# 全连接队列上限（系统级）
sysctl net.core.somaxconn
# 默认128，建议调到4096
# 实际队列大小 = min(listen backlog参数, somaxconn)

# 开启SYN Cookies
sysctl net.ipv4.tcp_syncookies
# 0=关闭, 1=队列满时开启(推荐), 2=始终开启

# 全连接队列满时的行为
sysctl net.ipv4.tcp_abort_on_overflow
# 0=静默丢弃ACK(默认), 1=发RST
```

## 诊断工具

```bash
# 查看监听socket的队列状态
ss -lnt
# Recv-Q: 当前Accept队列中的连接数
# Send-Q: Accept队列最大长度(即backlog)

# 示例输出：
# State  Recv-Q  Send-Q  Local Address:Port
# LISTEN 129     128     0.0.0.0:8080
#        ^^^     ^^^
#        当前积压  队列上限  ← 已经溢出!

# 查看全连接队列溢出次数
nstat -az TcpExtListenOverflows
nstat -az TcpExtListenDrops

# 查看SYN队列溢出
nstat -az TcpExtTCPReqQFullDoCookies  # 触发cookie次数
nstat -az TcpExtTCPReqQFullDrop       # 直接丢弃次数
```

## TIME_WAIT问题

高并发短连接场景下，TIME_WAIT状态的socket大量堆积，占用端口资源：

```
主动关闭方状态变迁：
ESTABLISHED → FIN_WAIT_1 → FIN_WAIT_2 → TIME_WAIT → CLOSED
                                              │
                                              └─ 等待2MSL(60s)

# 解决方案
sysctl net.ipv4.tcp_tw_reuse=1     # 允许复用TIME_WAIT连接
sysctl net.ipv4.tcp_timestamps=1    # 必须配合时间戳(默认开)
```

注意：`tcp_tw_recycle`在NAT环境下有严重问题（不同客户端共享IP导致时间戳乱序），Linux 4.12已移除该参数。

## 实战：连接失败率飙升排查

上周线上一个RPC服务，客户端报大量"connection timeout"。排查过程：

```bash
# 1. 确认是服务端问题
ss -lnt | grep 9090
# LISTEN 129 128 *:9090  ← Recv-Q > Send-Q，队列溢出!

# 2. 确认溢出计数在增长
watch -n1 'nstat -az | grep -i listen'
# TcpExtListenOverflows 每秒+200

# 3. 根因：应用accept()太慢
# 业务线程池打满，处理goroutine阻塞在下游调用
# accept()被阻塞，全连接队列堆积

# 4. 临时措施
sysctl -w net.core.somaxconn=4096
# 程序重启时listen(fd, 4096)

# 5. 根本修复
# 分离accept线程和业务处理线程
# accept()用独立epoll，拿到fd后丢入业务线程池
```

## 调优总结

针对高并发C++网络服务，我的标准调优参数：

```bash
# /etc/sysctl.d/99-tcp-tuning.conf
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_max_tw_buckets = 50000
net.core.netdev_max_backlog = 5000
```

同时应用层要确保：listen的backlog参数与somaxconn匹配，accept()循环不做阻塞操作，监控队列积压指标并设置告警。TCP队列管理看似内核底层的事，但它直接影响服务的连接成功率和延迟，是后端工程师必须掌握的基本功。
