---
title: "C++协程框架设计：调度器实现与io_uring集成"
categories: [C++语言]
location: 西安
render_with_liquid: false
---

### 引言

C++20引入了协程关键字（co_await/co_yield/co_return），但标准库只提供了底层原语——没有调度器、没有执行器、没有IO集成。如果你想在生产中使用协程做异步IO，必须自己构建框架或使用第三方库。

我在项目中从回调式异步（callback hell）迁移到协程后，代码量减少了40%，可读性大幅提升——异步代码写起来像同步的。但第一版协程框架有严重的性能问题（过多的动态分配），优化后才达到了与手写状态机等价的性能。

本文讲解如何从零设计一个C++协程框架：Task抽象、协程调度器、以及与io_uring的集成。

---

### 1. C++20 协程底层机制

```
  协程 vs 线程 vs 回调：

  ┌──────────────┬──────────────────────────────────────────────┐
  │ 模型         │ 特点                                         │
  ├──────────────┼──────────────────────────────────────────────┤
  │ 多线程       │ 每线程有独立栈（MB级），上下文切换~1μs       │
  │              │ 10万连接 = 10万线程 = OOM                    │
  ├──────────────┼──────────────────────────────────────────────┤
  │ 回调/状态机  │ 单线程处理多连接，但代码碎片化（callback hell）│
  │              │ 业务逻辑散落在多个回调中，难以理解            │
  ├──────────────┼──────────────────────────────────────────────┤
  │ 协程         │ 栈帧分配在堆上（~100B），挂起/恢复~10ns      │
  │              │ 代码像同步但执行是异步的                      │
  │              │ 10万连接 ≈ 10万协程 ≈ 10MB内存               │
  └──────────────┴──────────────────────────────────────────────┘

  C++20 协程生命周期：

  caller调用协程函数
    → 分配协程帧(coroutine frame)在堆上
    → 构造promise_type对象
    → 调用initial_suspend() → 决定是否立即挂起
    → 执行协程体
    → 遇到co_await expr
       → 调用expr.await_ready() → 如果true，不挂起
       → 调用expr.await_suspend(handle) → 挂起，把handle交给调度器
       → [协程挂起，控制权回到caller]
       → [某时刻调度器调用handle.resume()]
       → 调用expr.await_resume() → 获取co_await的返回值
    → co_return value
       → 调用promise.return_value(value)
       → 调用final_suspend()
       → 销毁协程帧
```

---

### 2. Task<T>：协程返回类型

```cpp
#include <coroutine>
#include <optional>
#include <exception>
#include <variant>

template<typename T = void>
class Task {
public:
    struct promise_type {
        std::variant<std::monostate, T, std::exception_ptr> result_;
        std::coroutine_handle<> continuation_;  // 等待此Task的协程

        Task get_return_object() {
            return Task{std::coroutine_handle<promise_type>::from_promise(*this)};
        }

        std::suspend_always initial_suspend() noexcept { return {}; }  // 惰性启动

        auto final_suspend() noexcept {
            struct FinalAwaiter {
                bool await_ready() noexcept { return false; }
                std::coroutine_handle<> await_suspend(
                    std::coroutine_handle<promise_type> h) noexcept {
                    // 完成后恢复等待者
                    if (h.promise().continuation_) {
                        return h.promise().continuation_;
                    }
                    return std::noop_coroutine();
                }
                void await_resume() noexcept {}
            };
            return FinalAwaiter{};
        }

        void return_value(T value) {
            result_ = std::move(value);
        }

        void unhandled_exception() {
            result_ = std::current_exception();
        }
    };

    // Awaitable接口：让Task可以被co_await
    bool await_ready() const noexcept { return handle_.done(); }

    std::coroutine_handle<> await_suspend(std::coroutine_handle<> caller) noexcept {
        handle_.promise().continuation_ = caller;
        return handle_;  // 对称转移：直接恢复被等待的协程
    }

    T await_resume() {
        auto& result = handle_.promise().result_;
        if (auto* ex = std::get_if<std::exception_ptr>(&result)) {
            std::rethrow_exception(*ex);
        }
        return std::get<T>(std::move(result));
    }

    // 手动启动（给调度器用）
    void resume() { handle_.resume(); }
    bool done() const { return handle_.done(); }

    ~Task() { if (handle_) handle_.destroy(); }

    // Move-only
    Task(Task&& other) noexcept : handle_(other.handle_) { other.handle_ = nullptr; }
    Task(const Task&) = delete;

private:
    Task(std::coroutine_handle<promise_type> h) : handle_(h) {}
    std::coroutine_handle<promise_type> handle_;
};

// void特化省略...
```

---

### 3. 协程调度器

```cpp
#include <queue>
#include <functional>
#include <thread>

class Scheduler {
public:
    // 提交协程到就绪队列
    void schedule(std::coroutine_handle<> handle) {
        ready_queue_.push(handle);
    }

    // 提交Task
    template<typename T>
    void spawn(Task<T> task) {
        schedule(task.handle_);
        // 注意：需要保持task存活直到完成
    }

    // 运行调度循环
    void run() {
        while (!ready_queue_.empty() || hasPendingIO()) {
            // 1. 执行所有就绪的协程
            while (!ready_queue_.empty()) {
                auto handle = ready_queue_.front();
                ready_queue_.pop();
                handle.resume();  // 恢复协程执行到下一个co_await
            }

            // 2. 等待IO完成，将完成的协程加入就绪队列
            pollIO();
        }
    }

private:
    virtual bool hasPendingIO() = 0;
    virtual void pollIO() = 0;

    std::queue<std::coroutine_handle<>> ready_queue_;
};
```

---

### 4. 与 io_uring 集成

```cpp
#include <liburing.h>

class IoUringScheduler : public Scheduler {
public:
    IoUringScheduler(int queue_depth = 256) {
        io_uring_queue_init(queue_depth, &ring_, 0);
    }

    ~IoUringScheduler() {
        io_uring_queue_exit(&ring_);
    }

    // 异步读取：返回awaitable
    auto asyncRead(int fd, void* buf, size_t len, off_t offset = 0) {
        struct ReadAwaiter {
            IoUringScheduler* sched;
            int fd;
            void* buf;
            size_t len;
            off_t offset;
            int result = 0;

            bool await_ready() { return false; }

            void await_suspend(std::coroutine_handle<> handle) {
                auto* sqe = io_uring_get_sqe(&sched->ring_);
                io_uring_prep_read(sqe, fd, buf, len, offset);
                io_uring_sqe_set_data(sqe, handle.address());
                io_uring_submit(&sched->ring_);
            }

            int await_resume() { return result; }
        };
        return ReadAwaiter{this, fd, buf, len, offset};
    }

    // 异步写入
    auto asyncWrite(int fd, const void* buf, size_t len, off_t offset = 0) {
        struct WriteAwaiter {
            IoUringScheduler* sched;
            int fd;
            const void* buf;
            size_t len;
            off_t offset;
            int result = 0;

            bool await_ready() { return false; }
            void await_suspend(std::coroutine_handle<> handle) {
                auto* sqe = io_uring_get_sqe(&sched->ring_);
                io_uring_prep_write(sqe, fd, buf, len, offset);
                io_uring_sqe_set_data(sqe, handle.address());
                io_uring_submit(&sched->ring_);
            }
            int await_resume() { return result; }
        };
        return WriteAwaiter{this, fd, buf, len, offset};
    }

    // 异步accept
    auto asyncAccept(int listen_fd) {
        struct AcceptAwaiter {
            IoUringScheduler* sched;
            int listen_fd;
            int result = -1;

            bool await_ready() { return false; }
            void await_suspend(std::coroutine_handle<> handle) {
                auto* sqe = io_uring_get_sqe(&sched->ring_);
                io_uring_prep_accept(sqe, listen_fd, nullptr, nullptr, 0);
                io_uring_sqe_set_data(sqe, handle.address());
                io_uring_submit(&sched->ring_);
            }
            int await_resume() { return result; }
        };
        return AcceptAwaiter{this, listen_fd};
    }

    // 异步sleep
    auto asyncSleep(std::chrono::milliseconds duration) {
        struct SleepAwaiter {
            IoUringScheduler* sched;
            __kernel_timespec ts;

            bool await_ready() { return false; }
            void await_suspend(std::coroutine_handle<> handle) {
                auto* sqe = io_uring_get_sqe(&sched->ring_);
                io_uring_prep_timeout(sqe, &ts, 0, 0);
                io_uring_sqe_set_data(sqe, handle.address());
                io_uring_submit(&sched->ring_);
            }
            void await_resume() {}
        };
        __kernel_timespec ts{
            .tv_sec = duration.count() / 1000,
            .tv_nsec = (duration.count() % 1000) * 1000000
        };
        return SleepAwaiter{this, ts};
    }

protected:
    bool hasPendingIO() override {
        return io_uring_cq_ready(&ring_) > 0 || pending_count_ > 0;
    }

    void pollIO() override {
        struct io_uring_cqe* cqe;
        // 等待至少一个完成事件
        io_uring_wait_cqe(&ring_, &cqe);

        // 收割所有完成事件
        unsigned head;
        io_uring_for_each_cqe(&ring_, head, cqe) {
            auto* handle_addr = io_uring_cqe_get_data(cqe);
            auto handle = std::coroutine_handle<>::from_address(handle_addr);

            // 将完成的协程加入就绪队列
            schedule(handle);
            pending_count_--;
        }
        io_uring_cq_advance(&ring_, io_uring_cq_ready(&ring_));
    }

private:
    struct io_uring ring_;
    int pending_count_ = 0;
};
```

---

### 5. 使用：协程式 Echo Server

```cpp
// 协程写法：看起来像同步，执行是异步的
Task<void> handleConnection(IoUringScheduler& sched, int client_fd) {
    char buffer[4096];

    while (true) {
        // co_await异步读取（不阻塞线程）
        int n = co_await sched.asyncRead(client_fd, buffer, sizeof(buffer));
        if (n <= 0) break;

        // co_await异步写回（不阻塞线程）
        int written = co_await sched.asyncWrite(client_fd, buffer, n);
        if (written <= 0) break;
    }

    close(client_fd);
}

Task<void> acceptLoop(IoUringScheduler& sched, int listen_fd) {
    while (true) {
        int client_fd = co_await sched.asyncAccept(listen_fd);
        if (client_fd < 0) continue;

        // 启动新协程处理连接（不阻塞accept循环）
        sched.spawn(handleConnection(sched, client_fd));
    }
}

int main() {
    int listen_fd = createListenSocket(8080);

    IoUringScheduler scheduler;
    scheduler.spawn(acceptLoop(scheduler, listen_fd));
    scheduler.run();  // 事件循环

    return 0;
}
```

对比回调式写法：
```cpp
// ❌ 回调式（同样功能，但代码分散、难以理解）
void onAccept(int client_fd) {
    auto* ctx = new ConnectionContext(client_fd);
    submitRead(ctx, [](ConnectionContext* ctx, int n) {
        if (n <= 0) { delete ctx; return; }
        submitWrite(ctx, ctx->buffer, n, [](ConnectionContext* ctx, int written) {
            if (written <= 0) { delete ctx; return; }
            submitRead(ctx, [](ConnectionContext* ctx, int n) {
                // 嵌套继续...回调地狱
            });
        });
    });
}
```

---

### 6. 性能优化

```
  协程性能关键点：

  ┌────────────────────────┬──────────────────────────────────┐
  │ 优化点                 │ 方案                              │
  ├────────────────────────┼──────────────────────────────────┤
  │ 协程帧堆分配           │ 自定义operator new使用内存池      │
  │ (每次co_await可能分配) │ 或HALO优化（编译器栈上分配）     │
  ├────────────────────────┼──────────────────────────────────┤
  │ 对称转移               │ await_suspend返回handle而非void  │
  │ (避免栈溢出)           │ 编译器优化为tail call            │
  ├────────────────────────┼──────────────────────────────────┤
  │ 避免不必要的挂起       │ await_ready()返回true跳过挂起    │
  ├────────────────────────┼──────────────────────────────────┤
  │ 批量提交IO             │ 多个co_await间攒一批sqe再submit  │
  └────────────────────────┴──────────────────────────────────┘

  性能数据（Echo Server，64B消息）：
  - 手写epoll状态机:  150万 QPS
  - 协程+io_uring:    140万 QPS（仅差~7%）
  - 协程+epoll:       120万 QPS
  - boost.asio协程:   100万 QPS
```

```cpp
// 协程帧自定义分配器（使用内存池消除malloc）
template<typename T>
struct Task<T>::promise_type {
    // 自定义operator new：从线程本地内存池分配
    static void* operator new(size_t size) {
        return CoroutinePool::getInstance().allocate(size);
    }
    static void operator delete(void* ptr, size_t size) {
        CoroutinePool::getInstance().deallocate(ptr, size);
    }
    // ... 其余不变
};
```

---

### 7. 现有协程库对比

```
  ┌──────────────────┬──────────┬────────────────┬──────────────────┐
  │ 库               │ IO后端   │ 特点           │ 适用             │
  ├──────────────────┼──────────┼────────────────┼──────────────────┤
  │ cppcoro          │ 无IO     │ 纯协程原语     │ 学习/组合使用    │
  ├──────────────────┼──────────┼────────────────┼──────────────────┤
  │ libcoro          │ io_uring │ 轻量级         │ Linux高性能      │
  ├──────────────────┼──────────┼────────────────┼──────────────────┤
  │ boost.asio       │ epoll/IOCP│ 成熟稳定      │ 跨平台           │
  ├──────────────────┼──────────┼────────────────┼──────────────────┤
  │ folly::coro      │ 多种     │ Facebook出品   │ 大规模系统       │
  ├──────────────────┼──────────┼────────────────┼──────────────────┤
  │ unifex/stdexec   │ 多种     │ 标准化方向     │ 未来标准         │
  └──────────────────┴──────────┴────────────────┴──────────────────┘
```

---

### 总结

C++协程框架的核心：

1. **Task<T>是基础**：封装coroutine_handle和promise_type，支持co_await链式组合
2. **调度器驱动执行**：协程不自己运行，由调度器在IO完成时resume
3. **io_uring是最佳IO后端**：异步提交+批量完成，与协程天然匹配
4. **对称转移防栈溢出**：await_suspend返回下一个handle而非void
5. **内存池消除分配开销**：自定义promise_type的operator new
6. **代码可读性是最大收益**：异步逻辑写成同步风格，维护成本大幅降低

协程不是"更快的异步"，而是"更好写的异步"。性能上它与手写状态机接近（差<10%），但代码可读性和可维护性提升是质的飞跃。
