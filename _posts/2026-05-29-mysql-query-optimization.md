---
title: "MySQL查询优化深度指南：从索引设计到执行计划分析"
categories: [数据库]
location: 西安
render_with_liquid: false
---

### 引言

"这条SQL在测试环境秒出结果，线上跑了8秒"——如果你遇到过这个问题，多半是索引设计有坑。MySQL查询优化不是玄学，而是一套可量化、可复现的工程方法。

我曾经帮一个电商系统做性能优化，将订单列表查询从3.2秒降到18ms——只改了一行：加了一个组合索引。但知道"加哪个索引"才是关键，这需要理解MySQL优化器的决策逻辑。

本文从B+Tree索引原理讲起，系统介绍EXPLAIN执行计划分析、慢查询定位与优化，以及索引设计的最佳实践。

---

### 1. B+Tree 索引原理：为什么索引能加速查询

```
B+Tree结构（InnoDB聚簇索引）：

                    [10 | 20 | 30]              ← 根节点（内部节点）
                   /      |      \
          [1|3|5|8]   [11|13|15]   [21|25|28|30]  ← 中间节点
          /  |  | \    /  |  \      /  |  |  \
         叶子节点（包含完整行数据，叶子间双向链表连接）
         [1,row][3,row][5,row]...[28,row][30,row]→

  关键特性：
  1. 所有数据都在叶子节点（B+Tree，非B-Tree）
  2. 叶子节点通过双向链表连接（范围查询高效）
  3. 树高通常3-4层（1000万行数据，3次磁盘IO定位任意行）
  4. 内部节点只存key+指针，一个16KB页能容纳上千个key
```

#### 聚簇索引 vs 二级索引

```
  ┌──────────────────────────────────────────────────────────────┐
  │  聚簇索引（主键索引）：叶子节点存储完整行数据                   │
  │                                                              │
  │  主键: [1] → {id:1, name:"张三", age:25, ...完整行}          │
  │        [2] → {id:2, name:"李四", age:30, ...完整行}          │
  │                                                              │
  │  InnoDB表本身就是按主键组织的B+Tree                            │
  └──────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────┐
  │  二级索引（辅助索引）：叶子节点存储主键值                       │
  │                                                              │
  │  INDEX(name): ["张三"] → 主键1                                │
  │               ["李四"] → 主键2                                │
  │                                                              │
  │  查询过程: 二级索引找到主键 → 回表(到聚簇索引取完整行)          │
  └──────────────────────────────────────────────────────────────┘
```

**回表的代价**：每次回表是一次随机IO。如果二级索引返回1000行，就需要1000次回表。当回表比例太高时，MySQL优化器可能放弃索引，选择全表扫描。

---

### 2. EXPLAIN 执行计划详解

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 123 AND status = 'paid' ORDER BY created_at DESC LIMIT 20;
```

| 字段 | 含义 | 关注要点 |
|------|------|---------|
| type | 访问类型 | const > eq_ref > ref > range > index > ALL |
| possible_keys | 可能使用的索引 | 列出候选索引 |
| key | 实际使用的索引 | NULL=全表扫描 |
| key_len | 使用索引的字节数 | 判断是否用到组合索引的全部列 |
| rows | 预估扫描行数 | 越小越好 |
| filtered | 过滤比例(%) | 100%最好，10%以下需优化 |
| Extra | 额外信息 | 重点关注 |

#### type 访问类型（从好到差）

```
  const     → 通过主键或唯一索引精确匹配1行
              WHERE id = 1

  eq_ref    → JOIN时，对驱动表每行通过唯一索引匹配1行
              JOIN ... ON a.id = b.order_id (b.order_id有唯一索引)

  ref       → 通过非唯一索引匹配多行
              WHERE user_id = 123 (user_id有普通索引)

  range     → 索引范围扫描
              WHERE created_at > '2026-01-01'
              WHERE id IN (1,2,3)

  index     → 全索引扫描（比ALL好，但仍扫描整棵索引树）
              覆盖索引时出现

  ALL       → 全表扫描（最差！几乎一定需要优化）
              无可用索引时出现
```

#### Extra 关键信息

| Extra 值 | 含义 | 是否需要优化 |
|-----------|------|-------------|
| Using index | 覆盖索引，无需回表 | ✅ 最好 |
| Using where | Server层再过滤 | 🟡 看情况 |
| Using index condition | 索引条件下推(ICP) | ✅ 较好 |
| Using temporary | 使用临时表 | ❌ 需优化 |
| Using filesort | 额外排序操作 | ❌ 需优化 |
| Using join buffer | JOIN无索引 | ❌ 需优化 |

---

### 3. 组合索引设计原则

#### 3.1 最左前缀原则

```sql
-- 索引: INDEX idx_abc (a, b, c)

SELECT * FROM t WHERE a = 1 AND b = 2 AND c = 3;  -- ✅ 用到 a,b,c
SELECT * FROM t WHERE a = 1 AND b = 2;              -- ✅ 用到 a,b
SELECT * FROM t WHERE a = 1;                        -- ✅ 用到 a
SELECT * FROM t WHERE b = 2 AND c = 3;              -- ❌ 不能跳过a
SELECT * FROM t WHERE a = 1 AND c = 3;              -- 🟡 只用到a（c不连续）
```

#### 3.2 索引列顺序选择

```
  索引列排列原则（重要性从高到低）：

  1. 等值查询的列放前面
     WHERE user_id = ? AND status = ?
     → INDEX(user_id, status, ...)

  2. 范围查询的列放后面（范围后的列无法使用索引）
     WHERE user_id = ? AND created_at > ?
     → INDEX(user_id, created_at)  ✅
     → INDEX(created_at, user_id)  ❌ created_at是范围，user_id用不到

  3. 排序列紧跟查询条件列
     WHERE user_id = ? ORDER BY created_at DESC
     → INDEX(user_id, created_at)  ✅ 避免filesort

  4. 区分度高的列优先
     性别(M/F) vs 用户ID → 用户ID区分度高，放前面
```

#### 3.3 覆盖索引（避免回表）

```sql
-- 查询只需要索引中已包含的列 → 无需回表

-- 索引: INDEX idx_user_status_time (user_id, status, created_at)

-- ✅ 覆盖索引（只查索引中的列）
SELECT user_id, status, created_at FROM orders
WHERE user_id = 123 AND status = 'paid';
-- EXPLAIN: Extra = Using index

-- ❌ 需要回表（查了order_amount，不在索引中）
SELECT user_id, status, order_amount FROM orders
WHERE user_id = 123 AND status = 'paid';
-- EXPLAIN: Extra = NULL（需要回表取order_amount）
```

---

### 4. 慢查询定位与优化实战

#### 4.1 开启慢查询日志

```sql
-- 查看当前配置
SHOW VARIABLES LIKE 'slow_query%';
SHOW VARIABLES LIKE 'long_query_time';

-- 动态开启（无需重启）
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 0.1;  -- 100ms以上记录
SET GLOBAL log_queries_not_using_indexes = ON;  -- 记录不使用索引的查询
```

#### 4.2 常见慢查询案例及优化

**案例1：缺少索引**
```sql
-- 慢查询（全表扫描500万行）
SELECT * FROM orders WHERE user_id = 123 AND status = 'paid'
ORDER BY created_at DESC LIMIT 20;
-- type: ALL, rows: 5000000, Extra: Using where; Using filesort

-- 优化：添加组合索引
ALTER TABLE orders ADD INDEX idx_user_status_time(user_id, status, created_at);
-- type: ref, rows: 45, Extra: Using index condition
-- 效果：3200ms → 18ms
```

**案例2：深分页问题**
```sql
-- 慢查询（OFFSET大时性能急剧下降）
SELECT * FROM orders ORDER BY id DESC LIMIT 100000, 20;
-- 需要扫描100020行，丢弃前100000行

-- 优化方案1：游标分页（记住上次最后的ID）
SELECT * FROM orders WHERE id < 上次最后ID ORDER BY id DESC LIMIT 20;
-- 直接从索引定位，不扫描前面的行

-- 优化方案2：延迟关联
SELECT o.* FROM orders o
INNER JOIN (SELECT id FROM orders ORDER BY id DESC LIMIT 100000, 20) t
ON o.id = t.id;
-- 子查询只扫描索引（覆盖索引），减少回表次数
```

**案例3：隐式类型转换**
```sql
-- phone字段是VARCHAR，但传入数字
SELECT * FROM users WHERE phone = 13800138000;
-- ❌ MySQL将phone列转为数字比较 → 无法使用索引！

-- 正确写法
SELECT * FROM users WHERE phone = '13800138000';
-- ✅ 使用索引
```

**案例4：函数导致索引失效**
```sql
-- ❌ 对索引列使用函数
SELECT * FROM orders WHERE DATE(created_at) = '2026-05-29';
-- 索引失效：对每行计算DATE()

-- ✅ 改为范围查询
SELECT * FROM orders
WHERE created_at >= '2026-05-29 00:00:00'
  AND created_at < '2026-05-30 00:00:00';
-- 使用索引范围扫描
```

**案例5：OR条件优化**
```sql
-- ❌ OR可能导致索引失效
SELECT * FROM orders WHERE user_id = 123 OR status = 'refunding';
-- 如果user_id和status分别有索引，MySQL可能选择全表扫描

-- ✅ 改为UNION
SELECT * FROM orders WHERE user_id = 123
UNION ALL
SELECT * FROM orders WHERE status = 'refunding' AND user_id != 123;
-- 各自使用自己的索引
```

---

### 5. 索引设计最佳实践

| 实践 | 具体建议 | 原因 |
|------|---------|------|
| 主键用自增整数 | `BIGINT AUTO_INCREMENT` | 顺序写入，减少页分裂 |
| 组合索引优先 | 一个组合索引 > 多个单列索引 | 减少索引数量，优化器更确定 |
| 不超过5-6个索引 | 每张表索引数量控制 | INSERT/UPDATE需要维护所有索引 |
| 短索引优先 | VARCHAR(255)只索引前20字节 | 减少索引大小，提高缓存命中 |
| 避免冗余索引 | INDEX(a,b)已包含INDEX(a) | 定期检查并删除冗余索引 |
| 监控索引使用 | `sys.schema_unused_indexes` | 未使用的索引是纯开销 |

---

### 6. 实用诊断工具

```sql
-- 查看表的索引
SHOW INDEX FROM orders;

-- 查看索引使用统计（MySQL 8.0+）
SELECT * FROM sys.schema_index_statistics WHERE table_name = 'orders';

-- 查看未使用的索引
SELECT * FROM sys.schema_unused_indexes;

-- 查看冗余索引
SELECT * FROM sys.schema_redundant_indexes;

-- 查看当前执行的慢查询
SELECT * FROM information_schema.processlist WHERE time > 2;

-- 查看InnoDB缓冲池命中率
SHOW STATUS LIKE 'Innodb_buffer_pool_read%';
-- hit_rate = 1 - (Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests)
-- 应 > 99%
```

---

### 7. 查询优化检查清单

```
  SQL性能检查流程：

  ┌────────────────────┐
  │ 1. EXPLAIN 看执行计划│
  └─────────┬──────────┘
            │
  ┌─────────▼──────────┐
  │ type = ALL？        │──是──→ 添加索引
  └─────────┬──────────┘
            │否
  ┌─────────▼──────────┐
  │ rows > 预期？       │──是──→ 检查索引选择性/统计信息
  └─────────┬──────────┘
            │否
  ┌─────────▼──────────┐
  │ Extra有filesort？   │──是──→ 优化ORDER BY（加入索引）
  └─────────┬──────────┘
            │否
  ┌─────────▼──────────┐
  │ Extra有temporary？  │──是──→ 优化GROUP BY/DISTINCT
  └─────────┬──────────┘
            │否
  ┌─────────▼──────────┐
  │ 大量回表？          │──是──→ 覆盖索引/减少SELECT列
  └─────────┬──────────┘
            │否
            ▼
     查询已基本优化 ✅
```

---

### 总结

MySQL查询优化的核心要点：

1. **理解B+Tree**：索引是有序结构，范围查询、排序都依赖这个有序性
2. **EXPLAIN是第一工具**：任何性能问题先看执行计划，不要猜
3. **组合索引顺序很重要**：等值列前、范围列后、排序列跟随
4. **覆盖索引消除回表**：查询只需索引中的列时性能最佳
5. **避免索引失效陷阱**：类型转换、函数调用、前导%LIKE都会让索引失效
6. **深分页用游标**：OFFSET大时改用"上次最后ID"方式分页

数据库优化不是DBA的专利。作为后端开发者，写出的每条SQL都应该先EXPLAIN一下——这个习惯能帮你避免90%的线上性能问题。
