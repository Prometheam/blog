---
title: "分布式缓存策略：一致性模式、缓存击穿与多级缓存架构"
categories: [架构设计]
location: 西安
render_with_liquid: false
---

### 引言

缓存是提升系统性能的第一手段——一次Redis查询0.5ms vs 一次MySQL查询5ms，10倍差距。但缓存引入的一致性问题、击穿/雪崩/穿透三大灾难，处理不好反而让系统更脆弱。

我们的商品详情页每天访问量2亿次，不加缓存MySQL直接打崩。加了缓存后，又遇到过两次大促时缓存集中过期导致的"雪崩"事故。本文系统讲解缓存一致性策略、三大灾难防御、以及多级缓存架构设计。

---

### 1. 缓存一致性模式

```
  ┌──────────────────┬──────────────────────────────────────────────────┐
  │ 模式             │ 流程                                             │
  ├──────────────────┼──────────────────────────────────────────────────┤
  │ Cache Aside      │ 读: 先查缓存→miss→查DB→写缓存                   │
  │ (旁路缓存)       │ 写: 先更新DB→再删除缓存                          │
  │                  │ 最常用，但有短暂不一致窗口                        │
  ├──────────────────┼──────────────────────────────────────────────────┤
  │ Read Through     │ 读: 应用只问缓存，缓存miss时缓存层自己查DB       │
  │                  │ 写: 同Cache Aside                                │
  │                  │ 缓存层封装了数据加载逻辑                         │
  ├──────────────────┼──────────────────────────────────────────────────┤
  │ Write Through    │ 写: 先写缓存，缓存层同步写DB                     │
  │                  │ 强一致，但写入延迟高（等DB确认）                  │
  ├──────────────────┼──────────────────────────────────────────────────┤
  │ Write Behind     │ 写: 先写缓存，缓存层异步批量写DB                 │
  │ (Write Back)     │ 写入极快，但有丢失风险（缓存挂了未落盘）         │
  └──────────────────┴──────────────────────────────────────────────────┘
```

#### Cache Aside 详解（最常用）

```
  读取流程：
  ┌────────┐    1.GET key    ┌─────────┐
  │  App   │───────────────→│  Cache  │
  │        │←── 2a.命中 ────│ (Redis) │
  │        │←── 2b.miss ────│         │
  │        │                 └─────────┘
  │        │    3.SELECT     ┌─────────┐
  │        │───────────────→│   DB    │
  │        │←── 4.结果 ─────│ (MySQL) │
  │        │    5.SET key    ┌─────────┐
  │        │───────────────→│  Cache  │
  └────────┘                 └─────────┘

  写入流程（为什么是"删除"而不是"更新"缓存）：
  ┌────────┐    1.UPDATE     ┌─────────┐
  │  App   │───────────────→│   DB    │
  │        │    2.DEL key    ┌─────────┐
  │        │───────────────→│  Cache  │
  └────────┘                 └─────────┘

  为什么删除而不是更新？
  - 避免并发写时缓存值覆盖顺序错误
  - 例：A更新DB(v2)→B更新DB(v3)→B更新缓存(v3)→A更新缓存(v2) → 缓存是v2！
  - 删除后下一次读会从DB拉取最新值
```

#### 延迟双删（更安全的一致性）

```cpp
// 场景：先删缓存再更新DB时，并发读可能读到旧值并写回缓存
// 解决：延迟双删

void updateWithDoubleDelete(const std::string& key, const Data& new_value) {
    // 1. 删除缓存
    redis.del(key);
    
    // 2. 更新数据库
    db.update(new_value);
    
    // 3. 延迟再删一次（覆盖并发读写回的旧值）
    std::thread([key]() {
        std::this_thread::sleep_for(std::chrono::milliseconds(500));  // 等待并发读完成
        redis.del(key);
    }).detach();
}

// 更优方案：先更新DB再删缓存 + 订阅binlog异步删缓存
// Canal/Debezium监听MySQL binlog → 消费变更事件 → 删除对应缓存key
```

---

### 2. 缓存三大灾难

#### 2.1 缓存击穿（热Key过期）

```
  问题：热门Key过期瞬间，大量并发请求同时穿透到DB

  正常:  100万请求/秒 → Redis命中 → 正常
  过期:  100万请求/秒 → Redis miss → 全部打到DB → DB崩溃

  解决方案：互斥锁 + 逻辑过期
```

```cpp
// 方案1：互斥锁（只让一个请求回源DB）
std::optional<std::string> getWithMutex(const std::string& key) {
    // 1. 查缓存
    auto value = redis.get(key);
    if (value) return value;
    
    // 2. 获取分布式锁（只有一个请求能获取成功）
    std::string lock_key = "lock:" + key;
    bool locked = redis.set(lock_key, "1", SetParams::nx().ex(5));
    
    if (locked) {
        // 3. 我来加载DB数据
        auto db_value = db.query(key);
        redis.setex(key, 3600, db_value);  // 写回缓存
        redis.del(lock_key);               // 释放锁
        return db_value;
    } else {
        // 4. 其他请求等待一会再查缓存
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        return redis.get(key);  // 第二次查大概率命中
    }
}

// 方案2：逻辑过期（永不真正过期，后台异步刷新）
struct CacheEntry {
    std::string data;
    int64_t logical_expire;  // 逻辑过期时间
};

std::string getWithLogicalExpiry(const std::string& key) {
    auto entry = redis.get<CacheEntry>(key);  // 永不过期（TTL=-1）
    
    if (entry.logical_expire > now()) {
        return entry.data;  // 未逻辑过期，直接返回
    }
    
    // 逻辑过期：返回旧值 + 后台异步刷新
    asyncRefresh(key);  // 异步线程去DB加载新值
    return entry.data;  // 先返回旧数据（可接受短暂stale）
}
```

#### 2.2 缓存雪崩（大量Key同时过期）

```
  问题：大量Key在同一时间过期 → 瞬间大量请求打到DB

  原因：
  - 批量设置了相同的TTL（如全部3600秒）
  - Redis集群整体宕机

  解决方案：
  1. TTL加随机抖动
  2. 热key永不过期 + 后台刷新
  3. 多级缓存（本地缓存兜底）
  4. 限流降级（DB侧保护）
```

```cpp
// TTL随机化（防止同时过期）
void setWithRandomTTL(const std::string& key, const std::string& value,
                      int base_ttl_seconds) {
    // 在基础TTL上加随机0-300秒
    std::uniform_int_distribution<int> dist(0, 300);
    int ttl = base_ttl_seconds + dist(rng);
    redis.setex(key, ttl, value);
}
```

#### 2.3 缓存穿透（查询不存在的数据）

```
  问题：请求的数据在DB中也不存在 → 每次都穿透到DB

  攻击场景：恶意请求大量不存在的ID → 缓存永远miss → DB被打崩

  解决方案：
  1. 空值缓存（缓存NULL，TTL较短）
  2. 布隆过滤器（见Redis进阶文章）
  3. 请求校验（参数合法性检查）
```

```cpp
// 空值缓存
std::optional<std::string> getWithNullCache(const std::string& key) {
    auto value = redis.get(key);
    
    if (value == "NULL_PLACEHOLDER") {
        return std::nullopt;  // 已知不存在
    }
    if (value) return value;  // 正常命中
    
    // 查DB
    auto db_value = db.query(key);
    if (db_value) {
        redis.setex(key, 3600, *db_value);
        return db_value;
    } else {
        // 不存在也缓存（防止反复穿透）
        redis.setex(key, 60, "NULL_PLACEHOLDER");  // 短TTL
        return std::nullopt;
    }
}
```

---

### 3. 多级缓存架构

```
  多级缓存（L1本地 + L2分布式）：

  请求 → [L1 本地缓存] → 命中(~100ns) → 返回
              │ miss
              ▼
         [L2 Redis]    → 命中(~500μs) → 写回L1 → 返回
              │ miss
              ▼
         [Database]    → 查询(~5ms)  → 写回L2+L1 → 返回

  ┌──────────────────┬──────────────┬──────────────┬──────────────────┐
  │ 层级             │ 延迟         │ 容量         │ 一致性           │
  ├──────────────────┼──────────────┼──────────────┼──────────────────┤
  │ L1 (进程内)      │ ~100ns       │ 100MB        │ 弱（各实例独立）│
  │ Caffeine/Guava   │              │              │ TTL短(30s-5min) │
  ├──────────────────┼──────────────┼──────────────┼──────────────────┤
  │ L2 (Redis)       │ ~500μs      │ 10-100GB     │ 较强(集中式)    │
  ├──────────────────┼──────────────┼──────────────┼──────────────────┤
  │ L3 (Database)    │ ~5ms         │ 无限         │ 强(数据源)      │
  └──────────────────┴──────────────┴──────────────┴──────────────────┘

  L1一致性问题：
  - 各服务实例的L1缓存独立，更新时不会自动同步
  - 解决：Redis Pub/Sub广播失效通知 → 所有实例清除本地缓存
  - 或：L1使用极短TTL(30秒)，容忍短暂不一致
```

```cpp
// 多级缓存实现
template<typename T>
class MultiLevelCache {
    LocalCache<T> l1_;   // 进程内LRU缓存
    RedisClient& l2_;    // Redis
    Database& db_;       // 数据源

public:
    std::optional<T> get(const std::string& key) {
        // L1: 本地缓存
        auto v = l1_.get(key);
        if (v) return v;

        // L2: Redis
        auto redis_val = l2_.get<T>(key);
        if (redis_val) {
            l1_.put(key, *redis_val, std::chrono::seconds(30));  // 写回L1
            return redis_val;
        }

        // L3: Database
        auto db_val = db_.query<T>(key);
        if (db_val) {
            l2_.setex(key, 3600, *db_val);  // 写回L2
            l1_.put(key, *db_val, std::chrono::seconds(30));  // 写回L1
        }
        return db_val;
    }

    void invalidate(const std::string& key) {
        l1_.remove(key);
        l2_.del(key);
        // 广播给其他实例清除L1
        l2_.publish("cache_invalidation", key);
    }
};
```

---

### 4. 缓存预热与容量规划

```
  缓存预热策略：

  ┌──────────────────────────────────────────────────────────┐
  │ 冷启动问题：服务重启后缓存为空 → 所有请求打DB → DB过载  │
  │                                                          │
  │ 预热方案：                                               │
  │ 1. 启动时预加载热数据（从DB批量读取Top-N热key）          │
  │ 2. 灰度切流（新实例先接10%流量，缓存预热后再100%）      │
  │ 3. 备份恢复（Redis RDB快照恢复）                         │
  │ 4. 双集群切换（新集群预热好再切流量）                    │
  └──────────────────────────────────────────────────────────┘

  容量规划：
  - 缓存命中率目标: > 95%（低于90%需要扩容或优化）
  - 内存规划: 热数据量 × 1.5（预留headroom）
  - 实例数: 按QPS需求（Redis单实例~10万QPS）
  - 监控: 命中率、内存使用率、连接数、慢查询
```

---

### 5. 缓存设计检查清单

| 检查项 | 具体建议 |
|--------|---------|
| TTL必须设置 | 所有key必须有过期时间（防止内存无限增长）|
| TTL随机化 | base_ttl + random(0, 300s)（防雪崩）|
| 热key保护 | 互斥锁或逻辑过期（防击穿）|
| 空值缓存 | 不存在的数据也缓存60秒（防穿透）|
| 大Value拆分 | 单Value不超过1MB（大Value阻塞Redis）|
| 序列化选型 | Protobuf > JSON（省空间+快）|
| 监控告警 | 命中率<90%告警、内存>80%告警 |
| 降级方案 | Redis不可用时直接查DB（不panic）|

---

### 总结

分布式缓存的核心：

1. **Cache Aside是默认模式**：先更新DB再删缓存，简单可靠
2. **击穿用互斥锁**：热key过期时只让一个请求回源
3. **雪崩用TTL随机化**：避免大量key同时过期
4. **穿透用空值缓存+布隆过滤器**：拦截对不存在数据的请求
5. **多级缓存提升命中率**：L1本地(ns级) + L2 Redis(μs级)
6. **一致性是权衡**：大部分业务可接受秒级延迟一致性

缓存是"以空间换时间"的典型策略。用得好是性能加速器，用得不好是一致性地雷。关键是理解每种模式的trade-off，选择适合业务一致性要求的方案。
