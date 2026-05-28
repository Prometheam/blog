---
layout: post_layout
title: "C++内存泄漏排查实战：从Valgrind到生产环境定位"
date: 2026-05-27 00:00:00 +0800
categories: [C++语言]
location: 西安
excerpt_separator: "```"
---

做了九年C++后端开发，内存问题是我遇到最多的线上故障类型。本文总结我在实际项目中排查内存泄漏的完整方法论，从开发阶段的工具链到生产环境的定位手段。

## 内存问题的四种类型

首先明确我们面对的敌人：

```
+------------------+-------------------------------------------+
| 类型             | 表现                                      |
+------------------+-------------------------------------------+
| Memory Leak      | 分配后未释放，RSS持续增长                 |
| Use-After-Free   | 访问已释放内存，随机崩溃或数据损坏        |
| Double-Free      | 重复释放，堆结构破坏，延迟崩溃            |
| Buffer Overflow  | 越界写入，覆盖相邻数据或元信息            |
+------------------+-------------------------------------------+
```

## Valgrind Memcheck：开发阶段首选

Valgrind是我排查内存问题的第一选择，无需重新编译即可使用：

```bash
valgrind --leak-check=full \
         --show-leak-kinds=all \
         --track-origins=yes \
         --suppressions=./project.supp \
         ./my_server --config test.conf
```

典型输出解读：

```
==12345== 1,024 bytes in 4 blocks are definitely lost
==12345==    at 0x4C2FB0F: malloc (vg_replace_malloc.c:381)
==12345==    by 0x401234: ConnectionPool::createConn() (pool.cpp:42)
==12345==    by 0x401567: handleRequest() (handler.cpp:87)
```

`definitely lost`是确定性泄漏，必须修复；`possibly lost`通常是指针算术导致的误报。对于第三方库的误报，我会编写suppression文件：

```
{
   ignore_protobuf_arena
   Memcheck:Leak
   match-leak-kinds: possible
   fun:malloc
   ...
   fun:*google*protobuf*Arena*
}
```

Valgrind的缺点是性能下降20-50倍，不适合压测场景。

## AddressSanitizer：编译期插桩

ASan通过编译时插桩实现，性能开销仅2倍左右：

```cmake
# CMakeLists.txt
if(ENABLE_ASAN)
    add_compile_options(-fsanitize=address -fno-omit-frame-pointer)
    add_link_options(-fsanitize=address)
endif()
```

ASan的核心是Shadow Memory机制：

```
+------------------+     映射关系      +------------------+
| 应用内存 8字节   | ───────────────→  | Shadow 1字节     |
| 0x10000000       |   Addr >> 3 + Off | 0x20002000       |
+------------------+                   +------------------+

Shadow值含义：
  0x00 = 8字节全部可访问
  0x01-0x07 = 前N字节可访问
  0xFA = 栈红区（Stack Red Zone）
  0xFD = 已释放内存（Freed Heap）
```

每次内存访问前，编译器插入检查代码验证Shadow状态。ASan能精确报告use-after-free和buffer-overflow，并附带分配/释放的完整调用栈。

## LeakSanitizer：轻量泄漏检测

LSan可独立使用，也可与ASan配合：

```bash
# 独立使用LSan
export LSAN_OPTIONS="suppressions=lsan.supp:print_suppressions=0"
clang++ -fsanitize=leak -g main.cpp -o main

# ASan已内置LSan，进程退出时自动检测
export ASAN_OPTIONS="detect_leaks=1"
```

## 生产环境：不能重启的服务怎么办

生产环境不能用Valgrind，我的做法分三层：

**第一层：观测RSS趋势**

```bash
# 监控进程虚拟内存映射
cat /proc/<pid>/smaps | grep -A 2 "[heap]"
# 输出示例：
# Size:     524288 kB
# Rss:      312456 kB  ← 关注此值的增长趋势

# glibc内置统计
malloc_stats();  // 在信号处理函数中调用，打印到stderr
```

**第二层：jemalloc Profiling**

我们线上服务统一使用jemalloc替代glibc malloc，它自带heap profiling能力：

```bash
# 启动时启用profiling
export MALLOC_CONF="prof:true,prof_prefix:jeprof,lg_prof_interval:30"

# 生成profile文件后用jeprof分析
jeprof --svg ./my_server jeprof.12345.0.heap > heap.svg
```

**第三层：tcmalloc + pprof**

Google的tcmalloc提供更精细的heap profiler：

```cpp
#include <gperftools/heap-profiler.h>

// 在怀疑泄漏的代码段前后打点
HeapProfilerStart("/tmp/myprofile");
// ... 执行一段时间 ...
HeapProfilerDump("checkpoint_1");
HeapProfilerStop();
```

```bash
pprof --pdf ./my_server /tmp/myprofile.0001.heap > leak.pdf
```

## Debug构建的自定义追踪分配器

在测试环境，我会使用带追踪功能的分配器：

```cpp
class TrackedAllocator {
    struct AllocInfo {
        size_t size;
        std::string_view file;
        int line;
        std::chrono::steady_clock::time_point ts;
    };
    std::unordered_map<void*, AllocInfo> active_allocs_;
    std::mutex mtx_;

public:
    void* allocate(size_t n, const char* file, int line) {
        void* p = ::malloc(n);
        std::lock_guard lk(mtx_);
        active_allocs_[p] = {n, file, line,
                             std::chrono::steady_clock::now()};
        return p;
    }

    void dump_leaks(std::chrono::seconds older_than) {
        auto now = std::chrono::steady_clock::now();
        for (auto& [ptr, info] : active_allocs_) {
            if (now - info.ts > older_than) {
                spdlog::warn("Potential leak: {}:{} size={} age={}s",
                    info.file, info.line, info.size,
                    duration_cast<seconds>(now - info.ts).count());
            }
        }
    }
};
```

## 实战案例：长期运行服务的慢泄漏

去年我们的网关服务每周RSS增长约200MB，但压测环境无法复现。最终定位过程：

1. jemalloc profiling发现热点在`std::shared_ptr`的控制块分配
2. 排查发现是`shared_ptr`循环引用：Session持有Connection的shared_ptr，Connection的回调lambda又捕获了Session的shared_ptr

```cpp
// 有问题的代码
class Session : public std::enable_shared_from_this<Session> {
    std::shared_ptr<Connection> conn_;

    void start() {
        conn_->set_callback([self = shared_from_this()](Data d) {
            //  ↑ lambda捕获了Session的shared_ptr
            //    而Session又持有Connection的shared_ptr → 循环！
            self->process(d);
        });
    }
};

// 修复：lambda捕获weak_ptr
conn_->set_callback([weak_self = weak_from_this()](Data d) {
    if (auto self = weak_self.lock()) {
        self->process(d);
    }
});
```

这个案例给我的教训是：lambda捕获shared_ptr形成的循环引用比裸指针更隐蔽，因为生命周期被回调链延长，只有在特定断连-重连序列下才会泄漏。

## 总结

内存排查的工具链选择：

```
开发阶段 ──→ ASan + LSan（CI必开）
            │
测试阶段 ──→ Valgrind（全量检测）+ 自定义追踪分配器
            │
生产环境 ──→ jemalloc prof / tcmalloc pprof + /proc监控
```

关键原则：**在CI中强制开启ASan，把问题消灭在合入之前**。对于长期运行的服务，jemalloc profiling是成本最低的生产环境诊断手段。
