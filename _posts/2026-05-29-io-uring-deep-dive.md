---
title: "io_uring深度解析：Linux异步IO的终极形态"
categories: [网络编程]
location: 西安
render_with_liquid: false
---

### 引言

Linux的IO一直是个"遗憾"：epoll解决了网络IO的多路复用问题，但文件IO仍然是同步阻塞的（POSIX AIO几乎没人用）。io_uring在2019年（Linux 5.1）彻底改变了这个局面——它提供了一个统一的异步IO接口，覆盖网络、文件、定时器，性能碾压epoll。

在我们的存储服务中，从epoll+线程池切换到io_uring后，IOPS提升了40%，尾延迟降低60%。核心原因：零系统调用提交IO、批量完成通知、内核与用户态共享内存。

本文从io_uring的环形缓冲区原理讲起，对比epoll的性能差异，最后实现一个io_uring驱动的高性能文件服务器。

---

### 1. 为什么需要 io_uring

```
  传统Linux IO模型的问题：

  ┌──────────────────┬───────────────────────────────────────────────┐
  │ 同步阻塞IO       │ read()/write() 调用期间线程挂起               │
  │                  │ 需要线程池来并发 → 线程数爆炸/上下文切换开销   │
  ├──────────────────┼───────────────────────────────────────────────┤
  │ epoll            │ 仅支持网络IO的多路复用                         │
  │                  │ 文件IO仍然需要线程池（不支持普通文件）         │
  │                  │ 每次提交IO需要系统调用（epoll_wait + read）    │
  ├──────────────────┼───────────────────────────────────────────────┤
  │ POSIX AIO        │ 接口难用、内核实现用线程池模拟（不是真异步）   │
  │ (aio_read等)     │ 几乎无人使用                                  │
  ├──────────────────┼───────────────────────────────────────────────┤
  │ Linux AIO        │ 仅支持O_DIRECT文件IO，不支持网络              │
  │ (io_submit)      │ 缓冲IO下退化为同步                            │
  └──────────────────┴───────────────────────────────────────────────┘

  io_uring 解决所有问题：
  ✅ 真正的异步IO（网络+文件+定时器统一接口）
  ✅ 零系统调用提交（用户态直接写共享内存）
  ✅ 批量提交+批量收割（减少内核切换）
  ✅ 支持任意文件操作（包括缓冲IO）
```

---

### 2. io_uring 核心原理

```
  io_uring 双环形缓冲区架构：

  用户态                          内核态
  ┌─────────────────────────────────────────────────┐
  │                                                 │
  │  提交队列 (SQ - Submission Queue)                │
  │  ┌───┬───┬───┬───┬───┬───┬───┬───┐            │
  │  │SQE│SQE│SQE│   │   │   │   │   │            │
  │  │ 0 │ 1 │ 2 │   │   │   │   │   │            │
  │  └───┴───┴───┴───┴───┴───┴───┴───┘            │
  │        ↑                                        │
  │        │ 用户态写入SQE（无需系统调用）            │
  │        │ 然后更新 tail 指针                      │
  │                                                 │
  │  ←──── 共享内存（mmap）────→                    │
  │                                                 │
  │  完成队列 (CQ - Completion Queue)                │
  │  ┌───┬───┬───┬───┬───┬───┬───┬───┐            │
  │  │CQE│CQE│   │   │   │   │   │   │            │
  │  │ 0 │ 1 │   │   │   │   │   │   │            │
  │  └───┴───┴───┴───┴───┴───┴───┴───┘            │
  │    ↑                                            │
  │    │ 内核写入CQE（IO完成结果）                   │
  │    │ 用户态读取 head 到 tail 之间的CQE           │
  │                                                 │
  └─────────────────────────────────────────────────┘

  关键优势：
  1. SQ/CQ通过mmap共享内存，用户态直接读写，无需拷贝
  2. 提交IO = 写SQE到SQ → 原子更新tail（可以不进内核）
  3. 收割完成 = 读CQ的head到tail → 原子更新head
  4. SQPOLL模式：内核线程轮询SQ，用户态完全零系统调用
```

#### SQE（提交队列项）结构

```c
struct io_uring_sqe {
    __u8    opcode;     // 操作类型：IORING_OP_READ / WRITE / ACCEPT / CONNECT...
    __u8    flags;      // 标志：IOSQE_IO_LINK(链式IO) / IOSQE_FIXED_FILE
    __u16   ioprio;     // IO优先级
    __s32   fd;         // 文件描述符
    __u64   off;        // 文件偏移
    __u64   addr;       // 缓冲区地址
    __u32   len;        // 长度
    __u64   user_data;  // 用户自定义数据（在CQE中原样返回）
    // ... 更多字段
};
```

---

### 3. io_uring vs epoll 性能对比

```
  高并发网络服务器基准测试（Echo Server，100字节消息）：

  ┌────────────────────┬────────────┬──────────┬──────────────┐
  │     方案           │ QPS(万)    │ P99延迟  │ CPU利用率     │
  ├────────────────────┼────────────┼──────────┼──────────────┤
  │ epoll + 同步IO     │ 85万       │ 1.2ms   │ 95%          │
  ├────────────────────┼────────────┼──────────┼──────────────┤
  │ io_uring (普通模式)│ 120万      │ 0.6ms   │ 80%          │
  ├────────────────────┼────────────┼──────────┼──────────────┤
  │ io_uring (SQPOLL)  │ 150万      │ 0.3ms   │ 75%+1核busy  │
  └────────────────────┴────────────┴──────────┴──────────────┘

  文件IO（随机4K读，NVMe SSD）：

  ┌────────────────────┬────────────┬──────────┐
  │     方案           │ IOPS       │ 延迟(P99)│
  ├────────────────────┼────────────┼──────────┤
  │ 同步read()+线程池  │ 350K       │ 180μs   │
  ├────────────────────┼────────────┼──────────┤
  │ io_uring           │ 500K       │ 75μs    │
  ├────────────────────┼────────────┼──────────┤
  │ io_uring + 固定缓冲│ 580K       │ 60μs    │
  └────────────────────┴────────────┴──────────┘
```

---

### 4. liburing 实战：文件异步读取

```cpp
#include <liburing.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstdio>
#include <cstring>
#include <vector>

// 简单示例：异步读取文件
void async_read_file(const char* filename) {
    struct io_uring ring;
    // 初始化io_uring（队列深度256）
    io_uring_queue_init(256, &ring, 0);

    int fd = open(filename, O_RDONLY);
    if (fd < 0) { perror("open"); return; }

    const size_t BUF_SIZE = 4096;
    std::vector<char> buffer(BUF_SIZE);

    // 1. 获取一个SQE（提交队列项）
    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);

    // 2. 准备读操作
    io_uring_prep_read(sqe, fd, buffer.data(), BUF_SIZE, 0 /* offset */);
    sqe->user_data = 42;  // 自定义标识

    // 3. 提交（可以批量提交多个SQE后一次submit）
    io_uring_submit(&ring);

    // 4. 等待完成
    struct io_uring_cqe *cqe;
    io_uring_wait_cqe(&ring, &cqe);

    // 5. 处理结果
    if (cqe->res < 0) {
        fprintf(stderr, "Read error: %s\n", strerror(-cqe->res));
    } else {
        printf("Read %d bytes, user_data=%llu\n", cqe->res, cqe->user_data);
        buffer[cqe->res] = '\0';
        printf("Content: %.100s...\n", buffer.data());
    }

    // 6. 标记CQE已消费
    io_uring_cqe_seen(&ring, cqe);

    close(fd);
    io_uring_queue_exit(&ring);
}
```

---

### 5. 实战：io_uring 网络服务器

```cpp
#include <liburing.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cstring>
#include <cstdio>
#include <vector>

enum EventType { EVENT_ACCEPT, EVENT_READ, EVENT_WRITE };

struct ConnInfo {
    int fd;
    EventType type;
    char buffer[4096];
    int buf_len;
};

class IoUringServer {
    struct io_uring ring_;
    int listen_fd_;
    static constexpr int QUEUE_DEPTH = 1024;

public:
    IoUringServer(int port) {
        // 初始化io_uring
        io_uring_queue_init(QUEUE_DEPTH, &ring_, 0);

        // 创建监听socket
        listen_fd_ = socket(AF_INET, SOCK_STREAM, 0);
        int opt = 1;
        setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);
        addr.sin_addr.s_addr = INADDR_ANY;
        bind(listen_fd_, (sockaddr*)&addr, sizeof(addr));
        listen(listen_fd_, 512);

        printf("Server listening on port %d\n", port);
    }

    void run() {
        // 提交第一个accept
        submitAccept();

        while (true) {
            io_uring_submit_and_wait(&ring_, 1);

            struct io_uring_cqe *cqe;
            unsigned head;
            int count = 0;

            // 批量收割完成事件
            io_uring_for_each_cqe(&ring_, head, cqe) {
                auto *info = reinterpret_cast<ConnInfo*>(cqe->user_data);
                handleCompletion(info, cqe->res);
                count++;
            }
            io_uring_cq_advance(&ring_, count);
        }
    }

private:
    void submitAccept() {
        auto *info = new ConnInfo{listen_fd_, EVENT_ACCEPT, {}, 0};
        auto *sqe = io_uring_get_sqe(&ring_);
        io_uring_prep_accept(sqe, listen_fd_, nullptr, nullptr, 0);
        io_uring_sqe_set_data(sqe, info);
    }

    void submitRead(int fd) {
        auto *info = new ConnInfo{fd, EVENT_READ, {}, 0};
        auto *sqe = io_uring_get_sqe(&ring_);
        io_uring_prep_recv(sqe, fd, info->buffer, sizeof(info->buffer), 0);
        io_uring_sqe_set_data(sqe, info);
    }

    void submitWrite(int fd, const char* data, int len) {
        auto *info = new ConnInfo{fd, EVENT_WRITE, {}, len};
        memcpy(info->buffer, data, len);
        auto *sqe = io_uring_get_sqe(&ring_);
        io_uring_prep_send(sqe, fd, info->buffer, len, 0);
        io_uring_sqe_set_data(sqe, info);
    }

    void handleCompletion(ConnInfo* info, int result) {
        switch (info->type) {
            case EVENT_ACCEPT:
                if (result >= 0) {
                    submitRead(result);  // 新连接，提交读
                }
                submitAccept();  // 继续接受新连接
                break;

            case EVENT_READ:
                if (result > 0) {
                    // Echo: 读到数据，原样写回
                    submitWrite(info->fd, info->buffer, result);
                } else {
                    close(info->fd);  // 连接关闭
                }
                break;

            case EVENT_WRITE:
                if (result > 0) {
                    submitRead(info->fd);  // 写完继续读
                } else {
                    close(info->fd);
                }
                break;
        }
        delete info;
    }
};

int main() {
    IoUringServer server(8080);
    server.run();
    return 0;
}
```

编译：
```bash
g++ -std=c++17 -O2 -o uring_server server.cpp -luring
```

---

### 6. io_uring 高级特性

| 特性 | 说明 | 适用场景 |
|------|------|---------|
| SQPOLL | 内核线程轮询SQ，零系统调用 | 极致低延迟 |
| Fixed Files | 预注册fd，避免每次原子引用计数 | 高频IO同一fd |
| Fixed Buffers | 预注册buffer，避免每次内核映射 | 固定大小IO |
| IO链 | 多个操作按顺序执行（write后fsync） | 数据完整性 |
| Multishot Accept | 一次提交持续接受连接 | 服务器 |
| Cancel | 取消未完成的IO操作 | 超时处理 |

```cpp
// SQPOLL模式（零系统调用）
struct io_uring_params params = {};
params.flags = IORING_SETUP_SQPOLL;
params.sq_thread_idle = 2000;  // 空闲2秒后内核线程休眠
io_uring_queue_init_params(256, &ring, &params);
// 之后提交IO只需写SQE，不调用io_uring_submit()

// Fixed Buffers（注册缓冲区避免内核映射开销）
struct iovec iovecs[BUFFER_COUNT];
for (int i = 0; i < BUFFER_COUNT; i++) {
    iovecs[i].iov_base = buffers[i];
    iovecs[i].iov_len = BUFFER_SIZE;
}
io_uring_register_buffers(&ring, iovecs, BUFFER_COUNT);
// 后续用 io_uring_prep_read_fixed() 使用预注册缓冲
```

---

### 7. 何时用 io_uring vs epoll

```
  ┌──────────────────────┬────────────────────┬────────────────────┐
  │ 场景                 │ 推荐方案           │ 原因               │
  ├──────────────────────┼────────────────────┼────────────────────┤
  │ 纯网络服务（少连接） │ epoll              │ 简单够用           │
  ├──────────────────────┼────────────────────┼────────────────────┤
  │ 纯网络（高并发）     │ io_uring           │ 批量提交减少切换   │
  ├──────────────────────┼────────────────────┼────────────────────┤
  │ 文件IO               │ io_uring           │ epoll不支持文件    │
  ├──────────────────────┼────────────────────┼────────────────────┤
  │ 网络+文件混合        │ io_uring           │ 统一接口           │
  ├──────────────────────┼────────────────────┼────────────────────┤
  │ 需要兼容旧内核       │ epoll              │ io_uring需5.1+     │
  ├──────────────────────┼────────────────────┼────────────────────┤
  │ 极致低延迟           │ io_uring + SQPOLL  │ 零系统调用         │
  └──────────────────────┴────────────────────┴────────────────────┘
```

---

### 总结

io_uring的核心价值：

1. **统一异步接口**：网络、文件、定时器一套API搞定
2. **零系统调用提交**：共享内存环形缓冲区，用户态直接写SQE
3. **批量处理**：一次submit多个IO，一次收割多个完成事件
4. **SQPOLL极致性能**：内核线程轮询，用户态完全不切换到内核态
5. **取代epoll+线程池**：特别是混合网络+文件IO的场景
6. **Linux 5.1+可用**：主流发行版（Ubuntu 20.04+, CentOS 8+）已支持

io_uring是Linux IO子系统10年来最大的进步。如果你的服务跑在Linux上且对IO性能有要求，io_uring是未来的标准选择。
