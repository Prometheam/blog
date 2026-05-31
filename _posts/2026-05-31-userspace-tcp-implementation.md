---
title: "从零实现用户态TCP：滑动窗口、拥塞控制与状态机"
categories: [网络编程]
location: 西安
render_with_liquid: false
---

### 引言

理解TCP最好的方式是自己实现一遍。TCP表面是"可靠传输协议"，背后是一个精密的状态机+流量控制+拥塞控制系统。很多网络问题（重传风暴、窗口缩为零、TIME_WAIT堆积）只有理解了TCP内部机制才能真正定位。

我曾在DPDK项目中实现过一个精简版TCP栈（只支持单连接），用来做低延迟通信。整个实现约2000行C++，但让我对TCP的理解从"知道概念"变成了"知道每个字节在做什么"。

本文不是重复RFC 793，而是用工程视角实现TCP的核心机制：三次握手状态机、滑动窗口、快速重传、拥塞控制。

---

### 1. TCP 状态机

```
  TCP连接状态转换（完整11态）：

                              ┌──────────────┐
                              │   CLOSED     │
                              └──────┬───────┘
                     passive open    │    active open
                     ┌───────────────┼────────────────┐
                     ▼               │                ▼
              ┌──────────┐           │         ┌──────────┐
              │  LISTEN  │           │         │ SYN_SENT │
              └────┬─────┘           │         └────┬─────┘
         rcv SYN   │                 │              │ rcv SYN+ACK
         snd SYN+ACK                 │              │ snd ACK
                   ▼                 │              ▼
              ┌──────────┐           │     ┌────────────────┐
              │ SYN_RCVD │───────────┼───→ │  ESTABLISHED   │
              └──────────┘  rcv ACK  │     └───────┬────────┘
                                     │             │
                              close  │             │ close / rcv FIN
                                     │             │
                     ┌───────────────┘   ┌─────────┴──────────┐
                     ▼                   ▼                    ▼
              ┌──────────┐        ┌──────────┐        ┌──────────┐
              │ FIN_WAIT1│        │ CLOSE_WAIT│        │ LAST_ACK │
              └────┬─────┘        └────┬─────┘        └──────────┘
                   │                   │ close
                   ▼                   ▼
              ┌──────────┐        ┌──────────┐
              │ FIN_WAIT2│        │ CLOSING  │
              └────┬─────┘        └──────────┘
                   │ rcv FIN
                   ▼
              ┌──────────┐
              │ TIME_WAIT│ ← 等待2MSL(60秒)后进入CLOSED
              └──────────┘
```

---

### 2. 核心数据结构

```cpp
#include <cstdint>
#include <queue>
#include <chrono>
#include <vector>
#include <functional>

// TCP头部（20字节，无选项）
struct TcpHeader {
    uint16_t src_port;
    uint16_t dst_port;
    uint32_t seq_num;
    uint32_t ack_num;
    uint8_t  data_offset;  // 高4位=头部长度(32bit字)
    uint8_t  flags;        // SYN/ACK/FIN/RST/PSH
    uint16_t window_size;
    uint16_t checksum;
    uint16_t urgent_ptr;
} __attribute__((packed));

// TCP标志位
enum TcpFlags : uint8_t {
    FIN = 0x01,
    SYN = 0x02,
    RST = 0x04,
    PSH = 0x08,
    ACK = 0x10,
    URG = 0x20,
};

// 连接状态
enum class TcpState {
    CLOSED, LISTEN, SYN_SENT, SYN_RECEIVED,
    ESTABLISHED, FIN_WAIT_1, FIN_WAIT_2,
    CLOSE_WAIT, CLOSING, LAST_ACK, TIME_WAIT
};

// 发送缓冲区中的段
struct TcpSegment {
    uint32_t seq;
    std::vector<uint8_t> data;
    std::chrono::steady_clock::time_point sent_time;
    int retransmit_count = 0;
    bool acked = false;
};

// TCP 连接控制块
struct TcpControlBlock {
    // 连接标识
    uint32_t local_ip, remote_ip;
    uint16_t local_port, remote_port;
    TcpState state = TcpState::CLOSED;

    // 发送端变量
    uint32_t snd_una;    // 最早未确认的序号
    uint32_t snd_nxt;    // 下一个要发送的序号
    uint32_t snd_wnd;    // 发送窗口（对端通告）
    uint32_t iss;        // 初始发送序号

    // 接收端变量
    uint32_t rcv_nxt;    // 期望接收的下一个序号
    uint32_t rcv_wnd;    // 接收窗口（通告给对端）
    uint32_t irs;        // 初始接收序号

    // 拥塞控制
    uint32_t cwnd;       // 拥塞窗口
    uint32_t ssthresh;   // 慢启动阈值
    uint32_t mss = 1460; // 最大段大小

    // RTT估计
    double srtt = 0;      // 平滑RTT
    double rttvar = 0;    // RTT方差
    double rto = 1000;    // 重传超时(ms)

    // 快速重传
    int dup_ack_count = 0;

    // 发送缓冲
    std::deque<TcpSegment> send_buffer;
    // 接收缓冲
    std::vector<uint8_t> recv_buffer;
};
```

---

### 3. 三次握手实现

```cpp
class TcpConnection {
    TcpControlBlock tcb_;
    std::function<void(const uint8_t*, size_t)> send_packet_;

public:
    // 主动连接（客户端）
    void connect(uint32_t remote_ip, uint16_t remote_port) {
        tcb_.remote_ip = remote_ip;
        tcb_.remote_port = remote_port;
        tcb_.iss = generateISN();
        tcb_.snd_nxt = tcb_.iss + 1;
        tcb_.snd_una = tcb_.iss;

        // 发送SYN
        sendSegment(TcpFlags::SYN, tcb_.iss, 0, nullptr, 0);
        tcb_.state = TcpState::SYN_SENT;
    }

    // 被动监听（服务端）
    void listen() { tcb_.state = TcpState::LISTEN; }

    // 处理收到的TCP段
    void onReceive(const TcpHeader* hdr, const uint8_t* data, size_t len) {
        switch (tcb_.state) {
        case TcpState::LISTEN:
            if (hdr->flags & SYN) {
                // 收到SYN，回复SYN+ACK
                tcb_.irs = ntohl(hdr->seq_num);
                tcb_.rcv_nxt = tcb_.irs + 1;
                tcb_.iss = generateISN();
                tcb_.snd_nxt = tcb_.iss + 1;
                tcb_.snd_una = tcb_.iss;

                sendSegment(SYN | ACK, tcb_.iss, tcb_.rcv_nxt, nullptr, 0);
                tcb_.state = TcpState::SYN_RECEIVED;
            }
            break;

        case TcpState::SYN_SENT:
            if ((hdr->flags & (SYN | ACK)) == (SYN | ACK)) {
                // 收到SYN+ACK
                tcb_.irs = ntohl(hdr->seq_num);
                tcb_.rcv_nxt = tcb_.irs + 1;
                tcb_.snd_una = ntohl(hdr->ack_num);
                tcb_.snd_wnd = ntohs(hdr->window_size);

                // 发送ACK，完成三次握手
                sendSegment(ACK, tcb_.snd_nxt, tcb_.rcv_nxt, nullptr, 0);
                tcb_.state = TcpState::ESTABLISHED;
                tcb_.cwnd = tcb_.mss;  // 初始拥塞窗口
                tcb_.ssthresh = 65535;
            }
            break;

        case TcpState::SYN_RECEIVED:
            if (hdr->flags & ACK) {
                tcb_.snd_una = ntohl(hdr->ack_num);
                tcb_.state = TcpState::ESTABLISHED;
                tcb_.cwnd = tcb_.mss;
                tcb_.ssthresh = 65535;
            }
            break;

        case TcpState::ESTABLISHED:
            processEstablished(hdr, data, len);
            break;
        // ... FIN_WAIT等状态处理
        }
    }

private:
    void sendSegment(uint8_t flags, uint32_t seq, uint32_t ack,
                     const uint8_t* data, size_t len) {
        TcpHeader hdr{};
        hdr.src_port = htons(tcb_.local_port);
        hdr.dst_port = htons(tcb_.remote_port);
        hdr.seq_num = htonl(seq);
        hdr.ack_num = htonl(ack);
        hdr.data_offset = 0x50;  // 5 × 4 = 20 bytes
        hdr.flags = flags;
        hdr.window_size = htons(tcb_.rcv_wnd);

        // 组包并发送
        std::vector<uint8_t> packet(sizeof(hdr) + len);
        memcpy(packet.data(), &hdr, sizeof(hdr));
        if (len > 0) memcpy(packet.data() + sizeof(hdr), data, len);

        send_packet_(packet.data(), packet.size());
    }

    uint32_t generateISN() {
        // ISN应该随时间增长（防止旧连接的段被误认）
        auto now = std::chrono::steady_clock::now().time_since_epoch();
        return std::chrono::duration_cast<std::chrono::microseconds>(now).count() & 0xFFFFFFFF;
    }
};
```

---

### 4. 滑动窗口与流量控制

```
  发送端滑动窗口：

  ┌─────────┬────────────────────────────┬─────────────────────┬────────┐
  │已确认ACK │      已发送未确认          │     可以发送         │ 不能发│
  │(可释放)  │  (等待ACK或超时重传)       │ (窗口内未用部分)     │  送   │
  └─────────┴────────────────────────────┴─────────────────────┴────────┘
  ← snd_una─→                            ← snd_nxt─→
             │←──── 发送窗口(snd_wnd) ──→│
             │←── effective_window = min(snd_wnd, cwnd) ──→│

  发送条件：snd_nxt - snd_una < effective_window
  即：已发送未确认的数据量 < 有效窗口大小
```

```cpp
// 数据发送（受窗口限制）
void TcpConnection::send(const uint8_t* data, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        uint32_t effective_wnd = std::min(tcb_.snd_wnd, tcb_.cwnd);
        uint32_t in_flight = tcb_.snd_nxt - tcb_.snd_una;  // 在途数据量
        uint32_t available = (effective_wnd > in_flight) ? effective_wnd - in_flight : 0;

        if (available == 0) break;  // 窗口满，等待ACK

        size_t seg_size = std::min({(size_t)available, (size_t)tcb_.mss, len - sent});

        sendSegment(ACK | PSH, tcb_.snd_nxt, tcb_.rcv_nxt, data + sent, seg_size);

        // 记录到发送缓冲（用于重传）
        tcb_.send_buffer.push_back({
            tcb_.snd_nxt,
            {data + sent, data + sent + seg_size},
            std::chrono::steady_clock::now()
        });

        tcb_.snd_nxt += seg_size;
        sent += seg_size;
    }
}

// 处理ACK（滑动窗口前进）
void TcpConnection::processAck(uint32_t ack_num) {
    if (ack_num > tcb_.snd_una) {
        // 新数据被确认，滑动窗口前进
        uint32_t acked_bytes = ack_num - tcb_.snd_una;
        tcb_.snd_una = ack_num;

        // 从发送缓冲移除已确认的段
        while (!tcb_.send_buffer.empty() &&
               tcb_.send_buffer.front().seq + tcb_.send_buffer.front().data.size() <= ack_num) {
            // 更新RTT估计
            updateRTT(tcb_.send_buffer.front().sent_time);
            tcb_.send_buffer.pop_front();
        }

        // 拥塞控制：收到新ACK
        if (tcb_.cwnd < tcb_.ssthresh) {
            tcb_.cwnd += tcb_.mss;  // 慢启动：每个ACK增加1MSS（指数增长）
        } else {
            tcb_.cwnd += tcb_.mss * tcb_.mss / tcb_.cwnd;  // 拥塞避免（线性增长）
        }

        tcb_.dup_ack_count = 0;
    } else {
        // 重复ACK
        tcb_.dup_ack_count++;
        if (tcb_.dup_ack_count == 3) {
            // 快速重传
            fastRetransmit();
        }
    }
}
```

---

### 5. 拥塞控制

```
  TCP 拥塞控制状态机（Reno）：

  ┌────────────────────────────────────────────────────────────────┐
  │                                                                │
  │  慢启动 (Slow Start)                                           │
  │  cwnd从1MSS开始，每收到一个ACK，cwnd += 1MSS                  │
  │  效果：每个RTT翻倍（指数增长）                                  │
  │  退出条件：cwnd >= ssthresh → 进入拥塞避免                     │
  │                                                                │
  ├────────────────────────────────────────────────────────────────┤
  │                                                                │
  │  拥塞避免 (Congestion Avoidance)                               │
  │  每个RTT，cwnd += 1MSS（线性增长）                             │
  │  退出条件：丢包检测                                            │
  │                                                                │
  ├────────────────────────────────────────────────────────────────┤
  │                                                                │
  │  丢包处理：                                                    │
  │  - 超时丢包：ssthresh = cwnd/2, cwnd = 1MSS, 回到慢启动      │
  │  - 3个重复ACK：ssthresh = cwnd/2, cwnd = ssthresh + 3MSS      │
  │    (快速恢复)                                                  │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘

  cwnd变化图（时间轴）：

  cwnd
   │       ╱╲                ╱╲
   │      ╱  ╲              ╱  ╲
   │     ╱    ╲ 丢包!      ╱    ╲
   │    ╱      ╲──ssthresh ╱      ╲
   │   ╱   慢启动↗  ↘     ╱ 拥塞避免
   │  ╱            ↘  ╱  ╱
   │ ╱              ╲╱  ╱
   │╱              慢启动
   └──────────────────────────────────→ 时间
```

```cpp
// 快速重传 + 快速恢复
void TcpConnection::fastRetransmit() {
    // 3个重复ACK → 判定丢包
    tcb_.ssthresh = std::max(tcb_.cwnd / 2, 2 * tcb_.mss);
    tcb_.cwnd = tcb_.ssthresh + 3 * tcb_.mss;  // 快速恢复

    // 重传最早未确认的段
    if (!tcb_.send_buffer.empty()) {
        auto& seg = tcb_.send_buffer.front();
        sendSegment(ACK | PSH, seg.seq, tcb_.rcv_nxt, seg.data.data(), seg.data.size());
        seg.retransmit_count++;
        seg.sent_time = std::chrono::steady_clock::now();
    }
}

// 超时重传
void TcpConnection::onTimeout() {
    // 超时 → 网络严重拥塞
    tcb_.ssthresh = std::max(tcb_.cwnd / 2, 2 * tcb_.mss);
    tcb_.cwnd = tcb_.mss;  // 回到1MSS（慢启动重来）

    // 重传最早未确认的段
    if (!tcb_.send_buffer.empty()) {
        auto& seg = tcb_.send_buffer.front();
        sendSegment(ACK | PSH, seg.seq, tcb_.rcv_nxt, seg.data.data(), seg.data.size());
        seg.retransmit_count++;

        // 指数退避RTO
        tcb_.rto = std::min(tcb_.rto * 2, 60000.0);
    }
}

// RTT估计（Jacobson算法）
void TcpConnection::updateRTT(std::chrono::steady_clock::time_point sent_time) {
    double measured_rtt = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - sent_time).count();

    if (tcb_.srtt == 0) {
        tcb_.srtt = measured_rtt;
        tcb_.rttvar = measured_rtt / 2;
    } else {
        tcb_.rttvar = 0.75 * tcb_.rttvar + 0.25 * std::abs(tcb_.srtt - measured_rtt);
        tcb_.srtt = 0.875 * tcb_.srtt + 0.125 * measured_rtt;
    }
    tcb_.rto = tcb_.srtt + 4 * tcb_.rttvar;
    tcb_.rto = std::max(tcb_.rto, 200.0);  // 最小200ms
}
```

---

### 6. TIME_WAIT 的意义

```
  为什么需要TIME_WAIT（等待2MSL≈60秒）？

  问题1：防止旧连接的迟到段干扰新连接
  ───────────────────────────────────────
  连接A关闭后，如果立即复用同一四元组建立连接B
  → 连接A的迟到段可能被连接B误收

  TIME_WAIT等待2MSL保证：连接A的所有段都已在网络中消亡

  问题2：保证被动关闭方能收到最后的ACK
  ───────────────────────────────────────
  主动关闭方发送最后的ACK后进入TIME_WAIT
  如果该ACK丢失，被动方会重发FIN
  TIME_WAIT状态可以重发ACK

  TIME_WAIT过多的生产问题：
  - 每个TIME_WAIT占用一个四元组(src_ip:port → dst_ip:port)
  - 大量短连接 → 大量TIME_WAIT → 端口耗尽
  - 解决：连接池复用、SO_REUSEADDR/SO_REUSEPORT、减少短连接
```

---

### 总结

自研TCP的核心知识：

1. **状态机是骨架**：11个状态、清晰的转换条件，实现时严格按状态机走
2. **滑动窗口是流控**：effective_window = min(rwnd, cwnd)，控制在途数据量
3. **拥塞控制是核心复杂度**：慢启动→拥塞避免→快速重传/恢复，AIMD策略
4. **RTT估计驱动重传**：Jacobson算法平滑估计，RTO = SRTT + 4×RTTVAR
5. **序号空间是32位循环**：2^32字节后回绕，比较需要考虑回绕
6. **TIME_WAIT不能省**：保证连接正确关闭，生产中用连接池减少短连接

实现TCP不是为了替代内核协议栈，而是为了深入理解它。当你遇到"为什么重传"、"为什么窗口缩小"、"为什么延迟突然升高"时，TCP内部机制的认知能让你秒定位问题。
