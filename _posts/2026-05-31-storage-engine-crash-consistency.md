---
title: "存储引擎核心原理：WAL、LSM-Tree与崩溃一致性"
categories: [数据库]
location: 西安
render_with_liquid: false
---

### 引言

数据库最重要的承诺是：即使在断电、crash的瞬间，已提交的数据也不会丢失。这个看似简单的承诺背后，是存储引擎复杂的崩溃一致性（Crash Consistency）机制。

我在实现一个嵌入式KV存储时，第一版直接写文件——结果测试时随机kill进程后，数据频繁损坏。加入WAL后再也没丢过数据。本文从"为什么直接写文件会丢数据"讲起，系统介绍WAL、LSM-Tree和B-Tree存储引擎的崩溃安全设计。

---

### 1. 为什么直接写文件不安全

```
  文件系统写入的非原子性：

  假设要更新一条记录（修改文件中的某个位置）：

  应用层:  write(fd, data, size)  → "写完了" ← 其实只到了Page Cache

  实际路径:
  应用 → Page Cache(内存) → [某个时刻] → 磁盘

  崩溃时机1: 数据在Page Cache，未落盘 → 数据丢失
  崩溃时机2: 大于4KB的写，写了一半 → 数据部分更新（torn write）
  崩溃时机3: 元数据(inode)和数据不一致 → 文件结构损坏

  fsync() 保证数据落盘，但：
  - fsync很慢（SSD ~100μs，HDD ~5ms）
  - 每次写都fsync → 性能灾难
  - 且不能保证"原子性"：写了一半时crash仍然是损坏

  结论：需要额外的机制保证"要么完全写入，要么完全没写"
```

---

### 2. Write-Ahead Log（WAL）

```
  WAL核心思想：先写日志，再写数据

  ┌──────────────────────────────────────────────────────────┐
  │                   WAL 保证原子性                          │
  │                                                          │
  │  写入流程：                                               │
  │  1. 将操作记录写入WAL文件（追加写，顺序IO，快）           │
  │  2. fsync WAL文件（确保日志持久化）                       │
  │  3. 返回"写入成功"给客户端                               │
  │  4. [稍后] 将修改应用到实际数据文件                       │
  │                                                          │
  │  崩溃恢复：                                               │
  │  - 重启时扫描WAL                                         │
  │  - 对于已写入WAL但未应用到数据文件的操作 → 重新应用       │
  │  - 对于未完成的WAL记录（写了一半）→ 丢弃                 │
  │                                                          │
  │  为什么WAL记录不会"写了一半"？                            │
  │  → 每条记录有CRC校验码，恢复时校验失败 = 不完整 = 丢弃   │
  └──────────────────────────────────────────────────────────┘
```

C++ WAL 实现：

```cpp
#include <fstream>
#include <string>
#include <vector>
#include <cstdint>
#include <cstring>

// WAL记录格式：[length(4B)][type(1B)][data(变长)][crc32(4B)]
struct WalRecord {
    enum Type : uint8_t { PUT = 1, DELETE = 2, COMMIT = 3 };
    uint32_t length;
    Type type;
    std::string key;
    std::string value;
    uint32_t crc;
};

class WriteAheadLog {
public:
    explicit WriteAheadLog(const std::string& path)
        : path_(path), file_(path, std::ios::binary | std::ios::app) {
        if (!file_) throw std::runtime_error("Cannot open WAL: " + path);
    }

    // 追加一条日志记录
    void append(WalRecord::Type type, const std::string& key,
                const std::string& value = "") {
        // 序列化记录
        std::vector<char> buf;
        uint32_t data_len = 1 + 4 + key.size() + 4 + value.size();
        
        // length
        buf.resize(4);
        std::memcpy(buf.data(), &data_len, 4);
        
        // type
        buf.push_back(static_cast<char>(type));
        
        // key (length-prefixed)
        uint32_t key_len = key.size();
        buf.insert(buf.end(), reinterpret_cast<char*>(&key_len),
                   reinterpret_cast<char*>(&key_len) + 4);
        buf.insert(buf.end(), key.begin(), key.end());
        
        // value (length-prefixed)
        uint32_t val_len = value.size();
        buf.insert(buf.end(), reinterpret_cast<char*>(&val_len),
                   reinterpret_cast<char*>(&val_len) + 4);
        buf.insert(buf.end(), value.begin(), value.end());
        
        // CRC32
        uint32_t crc = computeCRC32(buf.data() + 4, data_len);
        buf.insert(buf.end(), reinterpret_cast<char*>(&crc),
                   reinterpret_cast<char*>(&crc) + 4);
        
        // 写入文件
        file_.write(buf.data(), buf.size());
    }

    // 强制持久化
    void sync() {
        file_.flush();
        // POSIX: fdatasync(fd) 确保数据落盘
        fsync(fileno(file_));
    }

    // 崩溃恢复：读取所有有效记录
    std::vector<WalRecord> recover() {
        std::vector<WalRecord> records;
        std::ifstream reader(path_, std::ios::binary);
        
        while (reader.good()) {
            uint32_t length;
            if (!reader.read(reinterpret_cast<char*>(&length), 4)) break;
            
            std::vector<char> data(length);
            if (!reader.read(data.data(), length)) break;
            
            uint32_t stored_crc;
            if (!reader.read(reinterpret_cast<char*>(&stored_crc), 4)) break;
            
            // 校验CRC
            uint32_t computed_crc = computeCRC32(data.data(), length);
            if (computed_crc != stored_crc) {
                // CRC不匹配：记录不完整，停止恢复
                break;
            }
            
            // 解析记录
            WalRecord record;
            record.type = static_cast<WalRecord::Type>(data[0]);
            // ... 解析key和value ...
            records.push_back(std::move(record));
        }
        return records;
    }

private:
    uint32_t computeCRC32(const char* data, size_t len) {
        // CRC32实现（可用zlib的crc32()）
        uint32_t crc = 0xFFFFFFFF;
        for (size_t i = 0; i < len; i++) {
            crc ^= static_cast<uint8_t>(data[i]);
            for (int j = 0; j < 8; j++) {
                crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1));
            }
        }
        return ~crc;
    }

    std::string path_;
    std::ofstream file_;
};
```

---

### 3. LSM-Tree（Log-Structured Merge Tree）

```
  LSM-Tree 架构（LevelDB/RocksDB/Cassandra）：

  写入路径（极快：只有顺序IO）：
  ┌──────────┐   ┌──────────────┐   ┌───────────────────────┐
  │ Write    │──→│ MemTable     │──→│ Immutable MemTable    │
  │ (WAL)    │   │ (内存有序表) │   │ (冻结，等待flush)     │
  └──────────┘   └──────────────┘   └───────────┬───────────┘
                                                 │ flush到磁盘
                                                 ▼
  磁盘：
  ┌─────────────────────────────────────────────────────────┐
  │ Level 0:  [SST][SST][SST]  (从MemTable直接flush)       │
  │ Level 1:  [SST][SST][SST][SST][SST]  (10倍大小)        │
  │ Level 2:  [SST][SST]...[SST]  (100倍大小)              │
  │ Level 3:  [SST][SST]......[SST]  (1000倍大小)          │
  └─────────────────────────────────────────────────────────┘
                    ↑
            Compaction: 合并 + 排序 + 去重

  SSTable (Sorted String Table):
  ┌───────────────┬───────────────┬────────────────┬──────────┐
  │ Data Block 0  │ Data Block 1  │ ... Block N    │ Index    │
  │ (有序KV对)    │ (有序KV对)    │               │ (块索引) │
  └───────────────┴───────────────┴────────────────┴──────────┘
```

**为什么LSM-Tree写入快？**

```
  B-Tree写入 vs LSM-Tree写入：

  B-Tree:
  - 随机IO：更新可能需要修改树中任意位置的页
  - 写放大：修改一个key可能导致多次页分裂
  - 每次fsync一个页(4KB)

  LSM-Tree:
  - 顺序IO：所有写入都是追加到WAL和MemTable
  - 批量写：Compaction时批量顺序写SSTable
  - 只需fsync WAL（顺序追加）

  SSD随机写 vs 顺序写性能差距：
  随机4K写: ~50K IOPS
  顺序写:   ~500MB/s = ~125K 4K writes/s
  差距: 顺序写快2-3倍，且SSD寿命更长（减少写放大）
```

---

### 4. B-Tree 存储引擎的崩溃安全

```
  B-Tree（InnoDB/PostgreSQL）的崩溃保护：

  问题：修改一个页可能需要修改多个页（父节点、兄弟节点、叶子节点）
  如果crash在修改了2个页、还没改第3个时 → B-Tree结构损坏

  解决方案：

  方案1: WAL + Double Write Buffer (InnoDB)
  ┌───────┐
  │ WAL   │ → 记录逻辑操作（"在page X的offset Y写入Z"）
  └───────┘
  ┌────────────────────┐
  │ Double Write Buffer│ → 写入前先把整页拷贝到这里
  │ (2MB连续空间)      │    crash后可以从这里恢复完整的页
  └────────────────────┘

  恢复流程：
  1. 检查Double Write Buffer，修复torn page
  2. 扫描WAL，重做未应用的操作

  方案2: Copy-on-Write (Btrfs/LMDB)
  - 不修改原页，而是写新页
  - 最后原子更新根指针
  - 无需WAL（但写放大更大）
```

---

### 5. fsync 的语义与陷阱

```cpp
// fsync保证什么？
fsync(fd);  // 保证fd的数据和元数据都落盘

fdatasync(fd);  // 只保证数据落盘（不保证文件大小等元数据）
                // 比fsync快（少一次元数据写入）

// 陷阱1：只fsync文件本身不够！
// 新创建的文件需要fsync父目录（保证目录项持久化）
int fd = open("data/new_file.sst", O_CREAT|O_WRONLY, 0644);
write(fd, data, size);
fsync(fd);
close(fd);
// 还需要：
int dir_fd = open("data/", O_RDONLY);
fsync(dir_fd);  // 确保目录项（文件名→inode映射）持久化
close(dir_fd);

// 陷阱2：rename不是原子的（在crash面前）
rename("data.tmp", "data.final");
// rename对文件系统是原子的，但不保证持久化！
// 需要fsync目标目录
int dir_fd = open(".", O_RDONLY);
fsync(dir_fd);
close(dir_fd);

// 陷阱3：某些文件系统的fsync broken
// ext3的data=writeback模式下fsync可能不保证数据顺序
// 推荐: ext4 + data=ordered 或 data=journal
```

---

### 6. 写放大分析

```
  写放大 (Write Amplification) = 实际磁盘写入量 / 用户写入量

  ┌──────────────────┬────────────────┬───────────────────────────┐
  │ 存储引擎         │ 写放大         │ 原因                       │
  ├──────────────────┼────────────────┼───────────────────────────┤
  │ B-Tree (InnoDB)  │ 2-5x           │ WAL + 页写入 + double write│
  ├──────────────────┼────────────────┼───────────────────────────┤
  │ LSM-Tree (RocksDB)│ 10-30x        │ WAL + 多层Compaction       │
  ├──────────────────┼────────────────┼───────────────────────────┤
  │ Copy-on-Write    │ 1-2x           │ 写新页（不修改旧页）       │
  └──────────────────┴────────────────┴───────────────────────────┘

  LSM写放大高但写入快的原因：
  - 用户写入：顺序IO（快）
  - Compaction：后台异步，顺序IO
  - 总吞吐不受写放大影响（因为都是顺序IO）
  - 但影响SSD寿命和磁盘带宽

  B-Tree vs LSM-Tree 总结：
  ┌──────────────┬────────────┬──────────────┐
  │ 维度         │ B-Tree     │ LSM-Tree     │
  ├──────────────┼────────────┼──────────────┤
  │ 随机读       │ ✅ 快(1次) │ 🟡 慢(多层) │
  │ 范围读       │ ✅ 快      │ 🟡 需合并   │
  │ 随机写       │ 🟡 中     │ ✅ 快(顺序) │
  │ 空间利用     │ 🟡 ~60%  │ ✅ ~90%     │
  │ 写放大       │ ✅ 低     │ ❌ 高       │
  │ 读放大       │ ✅ 低     │ 🟡 中       │
  └──────────────┴────────────┴──────────────┘
```

---

### 7. 实际存储引擎选型

| 引擎 | 类型 | 适用场景 | 代表系统 |
|------|------|---------|---------|
| InnoDB | B-Tree | 事务性OLTP | MySQL |
| RocksDB | LSM-Tree | 写密集型KV | TiKV, CockroachDB |
| WiredTiger | B-Tree+LSM | 文档存储 | MongoDB |
| LMDB | Copy-on-Write B-Tree | 嵌入式只读密集 | OpenLDAP |
| BadgerDB | LSM(Go) | Go生态KV | Dgraph |

---

### 总结

存储引擎崩溃一致性的核心：

1. **WAL是安全基石**：先写日志再写数据，crash后从日志恢复
2. **CRC校验检测损坏**：不完整的写入通过CRC检出并丢弃
3. **fsync保证持久化**：不调用fsync的写入只到Page Cache，crash后丢失
4. **LSM-Tree写入最快**：全顺序IO，代价是读放大和写放大
5. **B-Tree读取最快**：随机读O(logN)，代价是随机写
6. **选型看负载**：写多读少→LSM，读多写少→B-Tree

存储引擎是数据库的"心脏"。理解WAL和崩溃恢复机制，不仅能帮你选对数据库，还能在设计任何需要持久化的系统时做出正确的工程决策。
