---
title: "Linux虚拟内存深度：mmap、写时复制与透明大页"
categories: [Linux系统]
location: 西安
render_with_liquid: false
---

### 引言

每个进程都拥有完整的4GB（32位）或128TB（64位）虚拟地址空间——这是操作系统最伟大的抽象之一。但这个抽象不是免费的：页表遍历、TLB miss、缺页中断、COW、mmap——理解这些机制对写出高性能系统至关重要。

我们的内存映射数据库引擎在启动时mmap了一个200GB的文件。第一版实现在随机访问时性能很差，profiling发现大量的major page fault。优化后通过madvise预取和大页映射，随机读性能提升了3倍。

本文深入Linux虚拟内存子系统：从页表结构到COW、mmap、THP的内核实现原理。

---

### 1. 虚拟内存地址空间布局

```
  64位Linux进程地址空间（用户态128TB）：

  ┌────────────────────────────────┐ 0xFFFFFFFFFFFFFFFF
  │         内核空间                │ (用户不可访问)
  ├────────────────────────────────┤ 0xFFFF800000000000
  │         (空洞)                  │
  ├────────────────────────────────┤ 0x00007FFFFFFFFFFF
  │                                │
  │         栈 (Stack)             │ ↓ 向下增长
  │         [8MB默认]              │
  │                                │
  ├─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
  │                                │
  │  内存映射区 (mmap)             │ ↓ 向下增长
  │  [动态库、mmap文件、匿名映射]  │
  │                                │
  ├─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
  │                                │
  │         堆 (Heap)              │ ↑ 向上增长 (brk/sbrk)
  │         [malloc分配]           │
  │                                │
  ├────────────────────────────────┤
  │         BSS段 (未初始化全局)    │
  │         Data段 (已初始化全局)   │
  │         Text段 (代码)          │
  ├────────────────────────────────┤
  │         (NULL页，访问=SIGSEGV)  │
  └────────────────────────────────┘ 0x0000000000000000
```

---

### 2. 页表与地址翻译

```
  4级页表（x86_64，4KB页）：

  虚拟地址 (48位有效):
  ┌──────┬──────┬──────┬──────┬────────────┐
  │ PGD  │ PUD  │ PMD  │ PTE  │  Page Offset│
  │ 9bit │ 9bit │ 9bit │ 9bit │   12bit     │
  └──┬───┴──┬───┴──┬───┴──┬───┴─────┬──────┘
     │      │      │      │         │
     ▼      ▼      ▼      ▼         │
  ┌─────┐┌─────┐┌─────┐┌─────┐     │
  │ PGD ││ PUD ││ PMD ││ PTE │     │
  │Entry││Entry││Entry││Entry│──→ 物理页帧号
  └─────┘└─────┘└─────┘└─────┘     │
                                     │
                          物理地址 = 页帧号 + Offset

  翻译代价：
  - 每次访问内存需要4次页表查找（4级遍历）
  - 但TLB缓存可以跳过遍历
  - TLB miss时：4次内存访问（~400ns）才能得到物理地址

  TLB容量（典型值）：
  - L1 DTLB: 64项（4KB页）+ 32项（2MB大页）
  - L2 STLB: 1536项
  - 4KB页覆盖: 64 × 4KB = 256KB（太少！）
  - 2MB大页覆盖: 32 × 2MB = 64MB（好多了）
```

---

### 3. 缺页中断（Page Fault）

```
  三种缺页中断：

  ┌──────────────────┬───────────────────────────────────────────────┐
  │ Minor Page Fault │ 页在内存中（Page Cache），只需建立映射          │
  │ (软缺页)         │ 成本: ~1-2μs                                  │
  ├──────────────────┼───────────────────────────────────────────────┤
  │ Major Page Fault │ 页不在内存，需要从磁盘读取                     │
  │ (硬缺页)         │ 成本: ~1-10ms (HDD) / ~100μs (SSD)            │
  ├──────────────────┼───────────────────────────────────────────────┤
  │ Invalid Fault    │ 非法访问（SIGSEGV/SIGBUS）                     │
  │                  │ 空指针、越界、写只读页                         │
  └──────────────────┴───────────────────────────────────────────────┘

  缺页中断触发场景：
  1. 首次访问mmap映射但未加载的页 → Major/Minor
  2. 写COW页（fork后首次写入）→ Minor（分配新页+拷贝）
  3. 堆扩展（malloc触发brk）→ Minor
  4. 栈增长 → Minor
  5. 访问已swap out的页 → Major（从swap读回）
```

---

### 4. mmap：内存映射文件

```cpp
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>

// 基本mmap用法
class MappedFile {
public:
    MappedFile(const std::string& path, bool read_only = true) {
        int flags = read_only ? O_RDONLY : O_RDWR;
        fd_ = open(path.c_str(), flags);
        if (fd_ < 0) throw std::runtime_error("Cannot open file");

        // 获取文件大小
        size_ = lseek(fd_, 0, SEEK_END);

        // 映射到虚拟地址空间
        int prot = read_only ? PROT_READ : (PROT_READ | PROT_WRITE);
        data_ = static_cast<char*>(mmap(nullptr, size_, prot, MAP_SHARED, fd_, 0));
        if (data_ == MAP_FAILED) throw std::runtime_error("mmap failed");
    }

    ~MappedFile() {
        if (data_ != MAP_FAILED) munmap(data_, size_);
        if (fd_ >= 0) close(fd_);
    }

    // 直接指针访问（零拷贝！无需read()系统调用）
    const char* data() const { return data_; }
    size_t size() const { return size_; }

    // 性能优化：提示内核预取策略
    void adviseSequential() {
        madvise(data_, size_, MADV_SEQUENTIAL);  // 顺序访问优化
    }
    void adviseRandom() {
        madvise(data_, size_, MADV_RANDOM);      // 随机访问（禁止预取）
    }
    void adviseWillNeed(size_t offset, size_t len) {
        madvise(data_ + offset, len, MADV_WILLNEED);  // 预取到Page Cache
    }
    void adviseDontNeed(size_t offset, size_t len) {
        madvise(data_ + offset, len, MADV_DONTNEED);  // 释放物理页
    }

private:
    int fd_ = -1;
    char* data_ = nullptr;
    size_t size_ = 0;
};

// 使用：内存映射数据库
class MmapDatabase {
    MappedFile file_;
public:
    MmapDatabase(const std::string& path) : file_(path) {
        file_.adviseRandom();  // 数据库是随机访问模式
    }

    // 读取记录：直接指针访问，零拷贝
    Record getRecord(size_t offset) {
        // 首次访问该页会触发minor page fault（从Page Cache加载）
        // 后续访问直接命中（零系统调用）
        return *reinterpret_cast<const Record*>(file_.data() + offset);
    }
};
```

#### mmap vs read() 性能对比

```
  读取1GB文件：

  ┌──────────────────────┬──────────┬───────────────────────────────┐
  │ 方式                 │ 耗时     │ 原因                           │
  ├──────────────────────┼──────────┼───────────────────────────────┤
  │ read() 顺序读       │ ~800ms   │ 每次read = 系统调用+内核拷贝  │
  ├──────────────────────┼──────────┼───────────────────────────────┤
  │ mmap 顺序访问       │ ~600ms   │ 无系统调用,page fault代替     │
  │ + MADV_SEQUENTIAL   │          │ 内核预读大块                   │
  ├──────────────────────┼──────────┼───────────────────────────────┤
  │ mmap 随机访问       │ 取决于   │ 热数据在Page Cache = ~ns级    │
  │ (热数据在缓存)      │ 命中率   │ 冷数据 = major fault ~100μs   │
  └──────────────────────┴──────────┴───────────────────────────────┘

  mmap适合: 随机访问大文件（数据库、索引）
  read适合: 顺序处理、需要精确控制缓存的场景
```

---

### 5. 写时复制（Copy-on-Write）

```
  COW 机制（fork时的关键优化）：

  fork()前：
  ┌──────────┐
  │ Process  │     虚拟页A ──→ 物理页 X (RW)
  │          │     虚拟页B ──→ 物理页 Y (RW)
  └──────────┘

  fork()后（COW：标记为只读共享）：
  ┌──────────┐     虚拟页A ──→ 物理页 X (RO, refcount=2)
  │ Parent   │     虚拟页B ──→ 物理页 Y (RO, refcount=2)
  └──────────┘
  ┌──────────┐     虚拟页A ──→ 物理页 X (RO, refcount=2)  ← 共享!
  │ Child    │     虚拟页B ──→ 物理页 Y (RO, refcount=2)  ← 共享!
  └──────────┘

  Parent写入虚拟页A时（触发COW page fault）：
  ┌──────────┐     虚拟页A ──→ 物理页 X' (RW) ← 新分配+拷贝
  │ Parent   │     虚拟页B ──→ 物理页 Y (RO, refcount=1→RW)
  └──────────┘
  ┌──────────┐     虚拟页A ──→ 物理页 X (RW, refcount=1)
  │ Child    │     虚拟页B ──→ 物理页 Y (RW, refcount=1)
  └──────────┘

  优势：fork()几乎零成本（不拷贝内存，只拷贝页表）
  代价：首次写入时有COW缺页中断开销
```

**COW 在实践中的应用**：
- `fork()`: 子进程共享父进程内存，写时才拷贝
- `std::string` (短字符串优化前的COW实现)
- Redis `bgsave`: fork后子进程遍历数据写RDB，父进程继续服务
- 容器overlay文件系统: 共享基础镜像层

---

### 6. 透明大页（THP）

```
  透明大页 vs 显式大页(hugetlbfs)：

  ┌──────────────────┬────────────────────┬──────────────────────┐
  │                  │ THP(透明大页)      │ hugetlbfs(显式大页)  │
  ├──────────────────┼────────────────────┼──────────────────────┤
  │ 粒度             │ 2MB               │ 2MB 或 1GB           │
  ├──────────────────┼────────────────────┼──────────────────────┤
  │ 需要应用修改     │ ❌ 透明            │ ✅ 需要mmap+mount   │
  ├──────────────────┼────────────────────┼──────────────────────┤
  │ 碎片化问题       │ 有（khugepaged）  │ 预留，无碎片         │
  ├──────────────────┼────────────────────┼──────────────────────┤
  │ Swap支持         │ 部分              │ ❌                    │
  ├──────────────────┼────────────────────┼──────────────────────┤
  │ 延迟抖动         │ 可能（compaction）│ 无                    │
  └──────────────────┴────────────────────┴──────────────────────┘

  THP的好处（对于大内存应用）：
  - TLB覆盖从256KB(64×4KB)提升到64MB(32×2MB)
  - 页表项减少512倍
  - 页表遍历从4级可能减少到3级

  THP的风险：
  - khugepaged后台合并小页为大页时可能导致延迟抖动
  - 内存碎片化严重时合并失败
  - 某些场景（Redis）建议关闭THP
```

```bash
# 查看THP状态
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# 推荐设置：madvise模式（应用主动请求才使用大页）
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# 应用中主动请求大页
madvise(addr, size, MADV_HUGEPAGE);
```

```cpp
// 对大内存块主动请求THP
void* allocateWithHugepages(size_t size) {
    // 对齐到2MB边界
    size_t aligned_size = (size + (2 << 20) - 1) & ~((2 << 20) - 1);

    void* ptr = mmap(nullptr, aligned_size,
                     PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (ptr == MAP_FAILED) return nullptr;

    // 提示内核使用大页
    madvise(ptr, aligned_size, MADV_HUGEPAGE);
    return ptr;
}
```

---

### 7. 内存监控与调试

```bash
# 查看进程内存映射详情
cat /proc/<PID>/smaps  # 每个VMA的RSS、PSS、Shared/Private

# 关键指标
cat /proc/<PID>/status
# VmRSS:  实际使用的物理内存
# VmSize: 虚拟地址空间总大小
# VmSwap: 被swap出去的内存

# 查看page fault统计
cat /proc/<PID>/stat | awk '{print "minor:", $10, "major:", $12}'

# 实时监控page fault
perf stat -e page-faults,minor-faults,major-faults -p <PID> sleep 10

# 查看THP使用情况
cat /proc/<PID>/smaps | grep -i huge
# AnonHugePages: 表示正在使用的透明大页
```

---

### 总结

Linux虚拟内存的核心：

1. **地址翻译靠页表+TLB**：TLB miss代价巨大（~400ns），大页能显著减少miss
2. **mmap零拷贝访问文件**：适合随机访问大文件，配合madvise提示优化预取
3. **COW让fork几乎免费**：fork不拷贝内存只拷贝页表，写时才分配新页
4. **THP用madvise模式**：对大内存应用显式请求，避免always模式的延迟抖动
5. **major page fault是性能杀手**：预取（MADV_WILLNEED）和mlock可以避免
6. **RSS才是真正的内存占用**：VmSize包含未分配物理页的映射，不代表实际占用

理解虚拟内存是理解"程序如何使用内存"的基础。mmap、COW、THP——这些不是内核开发者的专利，而是每个写高性能服务的后端工程师都应该掌握的工具。
