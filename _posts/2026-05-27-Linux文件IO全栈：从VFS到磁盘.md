---
layout: post_layout
title: "Linux文件IO全栈：从VFS到磁盘"
date: 2026-05-27 23:00:00 +0800
categories: [Linux系统]
location: 西安
excerpt_separator: "```"
---

作为后端开发，文件 IO 是我每天都在打交道的东西。但从 `write()` 系统调用到数据真正落盘，中间经过的层次比大多数人想象的要复杂得多。今天我从上到下把整条链路串一遍。

## VFS 抽象层

Linux 的 Virtual File System 是一层精巧的抽象，让 ext4、XFS、NFS 甚至 procfs 都共享同一套接口：

```
用户空间
─────────────────────────────────
   write(fd, buf, len)
         │
         ▼ (系统调用)
┌─────────────────────────────┐
│         VFS 层               │
│                             │
│  struct file {              │
│    f_op -> file_operations  │  ← 函数指针表
│    f_inode -> inode         │
│    f_pos (文件偏移)          │
│  }                          │
│                             │
│  struct inode {             │
│    i_mode, i_size           │
│    i_op -> inode_operations │
│    address_space            │  ← 关联 Page Cache
│  }                          │
│                             │
│  struct dentry {            │
│    d_name (文件名)           │
│    d_parent (父目录)         │
│    d_inode (关联inode)       │
│  }                          │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│   具体文件系统 (ext4/XFS)    │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│   Block Layer (通用块层)     │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│   磁盘驱动 / 硬件           │
└─────────────────────────────┘
```

核心思想：**一切皆文件**。`file_operations` 结构体中的函数指针决定了具体行为——ext4 有自己的 `ext4_file_write_iter`，XFS 有 `xfs_file_write_iter`。

## Page Cache：读写的核心加速器

几乎所有的文件 IO 都经过 Page Cache（除了 Direct IO）：

```
Buffered Write 路径:
                                    ┌──────────────┐
write(fd, buf, 4096)               │   磁盘       │
    │                               │              │
    ▼                               │  最终落盘     │
┌──────────────┐    writeback       │              │
│  Page Cache  │──────────────────>│              │
│              │    (异步/定时)      └──────────────┘
│  ┌────────┐  │
│  │ Page 0 │  │ ← Dirty (已修改未写回)
│  ├────────┤  │
│  │ Page 1 │  │ ← Clean (与磁盘一致)
│  ├────────┤  │
│  │ Page 2 │  │ ← Dirty
│  └────────┘  │
└──────────────┘

Buffered Read 路径:
read(fd, buf, 4096)
    │
    ▼
Page Cache 命中? ──Yes──> 直接拷贝到用户空间 (快!)
    │
    No
    ▼
从磁盘读取 -> 填充 Page Cache -> 拷贝到用户空间
```

**Writeback 触发条件：**
- 定时器：dirty page 超过 `dirty_expire_centisecs`（默认 30 秒）
- 比例阈值：dirty page 占比超过 `dirty_background_ratio`（默认 10%）触发后台刷写
- 硬阈值：超过 `dirty_ratio`（默认 20%）时阻塞写入进程直到刷写完成

我曾遇到过生产事故——大批量写入导致 dirty page 比例触顶，所有写线程被阻塞 10+ 秒。调优方案：

```bash
# 降低后台刷写阈值，避免积累太多脏页
echo 5 > /proc/sys/vm/dirty_background_ratio
echo 10 > /proc/sys/vm/dirty_ratio
# 缩短过期时间
echo 1500 > /proc/sys/vm/dirty_expire_centisecs
```

## Direct IO vs Buffered IO

```cpp
// Buffered IO (默认)
int fd = open("data.bin", O_WRONLY | O_CREAT, 0644);
write(fd, buf, len);  // 数据先到 Page Cache

// Direct IO (绕过 Page Cache)
int fd = open("data.bin", O_WRONLY | O_CREAT | O_DIRECT, 0644);
// 要求: buf 地址对齐, len 是扇区大小的倍数
posix_memalign(&buf, 4096, len);
write(fd, buf, len);  // 数据直接到磁盘控制器
```

**何时用 Direct IO：**
- 数据库引擎（自己管理缓存，不需要 Page Cache 二次缓存）
- 大文件顺序读写（Page Cache 反而浪费内存）
- 需要精确控制落盘时机

MySQL InnoDB 的 `innodb_flush_method=O_DIRECT` 就是典型案例——InnoDB 有自己的 Buffer Pool，Page Cache 是多余的。

## IO 调度器

```
IO 请求路径:
应用层  →  Page Cache  →  通用块层  →  IO 调度器  →  设备驱动

IO 调度器对比:
┌──────────────┬────────────────────────────────────────────┐
│ mq-deadline  │ 保证请求不会饿死，读优先于写                   │
│              │ 适合: HDD + 数据库负载                        │
├──────────────┼────────────────────────────────────────────┤
│ BFQ          │ 按进程公平分配带宽，类似 CFS                   │
│              │ 适合: 桌面交互 + 多用户环境                    │
├──────────────┼────────────────────────────────────────────┤
│ none (noop)  │ 不做任何排序和合并，直接下发                    │
│              │ 适合: NVMe SSD (硬件自己调度更高效)            │
└──────────────┴────────────────────────────────────────────┘
```

查看和切换调度器：

```bash
# 查看当前调度器
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline

# NVMe SSD 推荐 none
echo none > /sys/block/nvme0n1/queue/scheduler
```

## Block 层与 bio 结构

内核用 `struct bio` 描述一次块 IO 操作：

```
struct bio {
    bi_iter.bi_sector   // 起始扇区号
    bi_iter.bi_size     // 总字节数
    bi_io_vec[]         // 物理页面数组 (scatter-gather)
    bi_opf              // 操作类型 (READ/WRITE/FLUSH)
}

一次 write 可能产生:
┌──────┐    ┌──────┐    ┌──────┐
│ bio1 │───>│ bio2 │───>│ bio3 │  (bio chain)
└──────┘    └──────┘    └──────┘
  4KB         4KB         4KB

IO 调度器可能合并为:
┌──────────────────────────┐
│      merged request       │  12KB 连续写入
└──────────────────────────┘
```

这个合并优化对 HDD 至关重要（减少磁头寻道），对 SSD 也有帮助（减少命令数量）。

## fsync 语义与持久性

```cpp
write(fd, data, len);    // 数据到 Page Cache，可能丢失
fsync(fd);               // 等待文件数据 + 元数据刷到磁盘
fdatasync(fd);           // 只刷数据，不刷不影响读取的元数据(如 atime)
```

**fsync 的真实开销：**

```
fsync 做了什么:
1. 刷写该文件所有 dirty pages
2. 刷写 inode 元数据 (size, mtime 等)
3. 发送 FLUSH/FUA 命令到磁盘控制器
4. 等待磁盘确认写入非易失性存储

耗时: HDD ~5-15ms, SSD ~0.1-1ms, NVMe ~50-200μs
```

注意：`fsync` 保证的是当前文件描述符关联的数据。如果你创建了新文件，还需要对**父目录** fsync 才能保证目录项持久化：

```cpp
// 安全的原子文件替换
int fd = open("data.tmp", O_WRONLY | O_CREAT, 0644);
write(fd, data, len);
fsync(fd);
close(fd);
rename("data.tmp", "data.dat");  // 原子操作
int dir_fd = open(".", O_RDONLY);
fsync(dir_fd);  // 保证 rename 持久化!
close(dir_fd);
```

## WAL 实现中的 IO 考量

Write-Ahead Log 是数据库持久性的基石。我在实现类似组件时的关键决策：

```cpp
class WAL {
    int log_fd_;        // O_WRONLY | O_APPEND | O_DIRECT
    int current_size_;

public:
    void append(const Record& record) {
        // 1. 序列化到对齐缓冲区
        AlignedBuffer buf(4096);
        serialize(record, buf);

        // 2. 追加写入 (顺序IO，性能好)
        write(log_fd_, buf.data(), buf.size());

        // 3. 根据持久性要求决定是否 fsync
        if (sync_policy_ == EVERY_WRITE) {
            fdatasync(log_fd_);  // 最安全，最慢
        }
        // GROUP_COMMIT: 攒一批再 fsync，吞吐量提升10x
    }
};
```

**Group Commit** 是性能与持久性的折中——攒 1ms 的写入一起 fsync，单次 fsync 开销被数十个请求分摊。

## 性能调优实践

```bash
# 1. 预读优化 (大文件顺序读场景)
blockdev --setra 2048 /dev/sda  # 设置预读 1MB

# 2. 查看 IO 统计
iostat -x 1
# 关注: await(IO延迟), %util(设备饱和度), r/s w/s(IOPS)

# 3. 用 ionice 设置进程 IO 优先级
ionice -c2 -n0 -p $PID  # Best-effort, 最高优先级

# 4. 检查 Page Cache 使用情况
free -h  # buff/cache 列
vmstat 1  # bi/bo: 块设备IO量
```

我在调优一个日志服务时，发现 `await` 长期 > 50ms。排查发现是 Buffered IO + 大量随机小文件写入导致 Page Cache 频繁回收。改为 Direct IO + 日志聚合写入后，延迟降到 2ms 以内。

## 总结

理解 Linux IO 全栈，核心是理解每一层的缓冲和刷写语义。Page Cache 给了我们性能，但也带来了持久性的不确定。在设计数据密集型系统时，务必想清楚：数据什么时候真正安全了？答案永远是——fsync 返回之后。
