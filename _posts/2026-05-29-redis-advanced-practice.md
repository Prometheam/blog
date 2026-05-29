---
title: "Redis进阶实战：分布式锁、延迟队列、布隆过滤器与Stream"
categories: [数据库]
location: 西安
render_with_liquid: false
---

### 引言

Redis不只是缓存。很多人把Redis当"快一点的HashMap"用，但它的数据结构和原子操作能力远超想象：分布式锁、延迟任务队列、布隆过滤器、消息流——这些"高级用法"在生产系统中解决了大量架构难题。

我们的系统用Redis实现了：秒杀库存的原子扣减、订单超时自动取消、防缓存穿透的布隆过滤器、实时通知的消息队列。这一篇把这些进阶用法系统整理，每个都配完整的C++实现。

---

### 1. 分布式锁：从基础到生产级

#### 1.1 基本实现

```
  分布式锁核心操作：

  加锁: SET lock_key unique_value NX EX 10
        │          │              │  │
        │          │              │  └── 10秒自动过期（防死锁）
        │          │              └───── NX: 只在key不存在时才设置
        │          └──────────────────── 唯一标识（用于安全释放）
        └─────────────────────────────── 锁的名字

  解锁: 必须用Lua脚本（原子性检查+删除）
        if redis.call("get", key) == unique_value then
            return redis.call("del", key)
        end
```

#### 1.2 C++ 实现

```cpp
#include <hiredis/hiredis.h>
#include <string>
#include <chrono>
#include <random>
#include <thread>

class RedisDistributedLock {
public:
    RedisDistributedLock(redisContext* ctx, const std::string& name,
                         std::chrono::milliseconds ttl = std::chrono::milliseconds(10000))
        : ctx_(ctx), lock_name_("lock:" + name), ttl_ms_(ttl.count()) {
        // 生成唯一标识（防止误删其他客户端的锁）
        token_ = generateToken();
    }

    // 尝试加锁
    bool tryLock() {
        auto* reply = static_cast<redisReply*>(redisCommand(ctx_,
            "SET %s %s NX PX %lld",
            lock_name_.c_str(), token_.c_str(), ttl_ms_));

        if (!reply) return false;
        bool success = (reply->type == REDIS_REPLY_STATUS && 
                       std::string(reply->str) == "OK");
        freeReplyObject(reply);
        return success;
    }

    // 阻塞式加锁（带超时）
    bool lock(std::chrono::milliseconds timeout = std::chrono::milliseconds(5000)) {
        auto deadline = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < deadline) {
            if (tryLock()) return true;
            std::this_thread::sleep_for(std::chrono::milliseconds(50));  // 重试间隔
        }
        return false;  // 超时未获取到锁
    }

    // 释放锁（Lua脚本保证原子性）
    bool unlock() {
        const char* lua_script = R"(
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        )";

        auto* reply = static_cast<redisReply*>(redisCommand(ctx_,
            "EVAL %s 1 %s %s",
            lua_script, lock_name_.c_str(), token_.c_str()));

        if (!reply) return false;
        bool success = (reply->type == REDIS_REPLY_INTEGER && reply->integer == 1);
        freeReplyObject(reply);
        return success;
    }

    // RAII守卫
    class Guard {
    public:
        Guard(RedisDistributedLock& lock, bool acquired)
            : lock_(lock), acquired_(acquired) {}
        ~Guard() { if (acquired_) lock_.unlock(); }
        explicit operator bool() const { return acquired_; }
    private:
        RedisDistributedLock& lock_;
        bool acquired_;
    };

    Guard guard() { return Guard(*this, lock()); }

private:
    std::string generateToken() {
        std::random_device rd;
        std::mt19937 gen(rd());
        std::uniform_int_distribution<uint64_t> dist;
        return std::to_string(dist(gen));
    }

    redisContext* ctx_;
    std::string lock_name_;
    std::string token_;
    long long ttl_ms_;
};

// 使用示例
void processOrder(redisContext* redis, int64_t order_id) {
    RedisDistributedLock lock(redis, "order:" + std::to_string(order_id));

    auto guard = lock.guard();
    if (!guard) {
        throw std::runtime_error("获取分布式锁超时");
    }

    // 持有锁期间的操作
    deductInventory(order_id);
    createPayment(order_id);
    // guard析构时自动释放锁
}
```

#### 1.3 看门狗续期（防锁过期）

```cpp
// 问题：业务执行时间>锁TTL → 锁自动过期 → 其他客户端获取 → 并发！
// 解决：看门狗线程定期续期

class WatchdogLock : public RedisDistributedLock {
    std::thread watchdog_;
    std::atomic<bool> holding_{false};

public:
    bool lock(std::chrono::milliseconds timeout) {
        if (!RedisDistributedLock::lock(timeout)) return false;
        holding_ = true;
        startWatchdog();
        return true;
    }

    bool unlock() {
        holding_ = false;
        if (watchdog_.joinable()) watchdog_.join();
        return RedisDistributedLock::unlock();
    }

private:
    void startWatchdog() {
        watchdog_ = std::thread([this] {
            while (holding_) {
                std::this_thread::sleep_for(std::chrono::milliseconds(ttl_ms_ / 3));
                if (!holding_) break;
                // 续期：重新设置过期时间
                redisCommand(ctx_, "PEXPIRE %s %lld", lock_name_.c_str(), ttl_ms_);
            }
        });
    }
};
```

---

### 2. 延迟队列：订单超时自动取消

#### 2.1 基于 Sorted Set 实现

```
  延迟队列原理（ZSet）：

  ZADD delay_queue <执行时间戳> <任务ID>

  score = 任务应该执行的时间戳（Unix毫秒）
  member = 任务标识

  消费者：每秒查询 score < now() 的任务

  时间轴:
  ──────────────────────────────────────────────────────>
  T=0      T=30min              T=now
  订单创建  score=T+30min       消费者发现score<now → 执行取消
```

```cpp
class DelayQueue {
public:
    DelayQueue(redisContext* ctx, const std::string& queue_name)
        : ctx_(ctx), queue_name_(queue_name) {}

    // 添加延迟任务
    void addTask(const std::string& task_id, std::chrono::milliseconds delay) {
        auto execute_at = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count() + delay.count();

        redisCommand(ctx_, "ZADD %s %lld %s",
                     queue_name_.c_str(), execute_at, task_id.c_str());
    }

    // 消费到期任务（原子操作：查询+删除）
    std::vector<std::string> consumeReady(int batch_size = 10) {
        // Lua脚本保证原子性：取出并删除到期任务
        const char* lua = R"(
            local now = tonumber(ARGV[1])
            local limit = tonumber(ARGV[2])
            local tasks = redis.call('ZRANGEBYSCORE', KEYS[1], 0, now, 'LIMIT', 0, limit)
            if #tasks > 0 then
                redis.call('ZREM', KEYS[1], unpack(tasks))
            end
            return tasks
        )";

        auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();

        auto* reply = static_cast<redisReply*>(redisCommand(ctx_,
            "EVAL %s 1 %s %lld %d",
            lua, queue_name_.c_str(), now_ms, batch_size));

        std::vector<std::string> tasks;
        if (reply && reply->type == REDIS_REPLY_ARRAY) {
            for (size_t i = 0; i < reply->elements; i++) {
                tasks.emplace_back(reply->element[i]->str, reply->element[i]->len);
            }
        }
        if (reply) freeReplyObject(reply);
        return tasks;
    }

    // 取消任务（如用户主动支付了，取消超时取消）
    bool cancelTask(const std::string& task_id) {
        auto* reply = static_cast<redisReply*>(redisCommand(ctx_,
            "ZREM %s %s", queue_name_.c_str(), task_id.c_str()));
        bool removed = reply && reply->integer > 0;
        if (reply) freeReplyObject(reply);
        return removed;
    }

private:
    redisContext* ctx_;
    std::string queue_name_;
};

// 使用：订单30分钟未支付自动取消
void onOrderCreated(int64_t order_id) {
    delay_queue.addTask("cancel_order:" + std::to_string(order_id),
                        std::chrono::minutes(30));
}

void onOrderPaid(int64_t order_id) {
    // 支付成功，取消超时任务
    delay_queue.cancelTask("cancel_order:" + std::to_string(order_id));
}

// 消费者线程（持续运行）
void delayQueueConsumer() {
    while (running) {
        auto tasks = delay_queue.consumeReady();
        for (auto& task : tasks) {
            if (task.starts_with("cancel_order:")) {
                auto order_id = std::stoll(task.substr(13));
                cancelOrder(order_id);
            }
        }
        if (tasks.empty()) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    }
}
```

---

### 3. 布隆过滤器：防缓存穿透

```
  缓存穿透问题：

  请求不存在的数据 → 缓存未命中 → 查DB → DB也没有 → 每次都穿透到DB
  攻击者：大量请求不存在的ID → DB被打崩

  布隆过滤器解决：

  请求 → 布隆过滤器 → "可能存在" → 查缓存/DB
                    → "一定不存在" → 直接返回空（不查DB）

  ┌────────────────────────────────────────────────────────────┐
  │  布隆过滤器特性：                                           │
  │  - 判断"不存在" → 100%准确                                  │
  │  - 判断"存在" → 可能误判（假阳性率可控，如0.1%）             │
  │  - 空间极省：1亿个元素只需约120MB（误判率0.1%）              │
  │  - 不支持删除（标准布隆，Cuckoo Filter支持）                 │
  └────────────────────────────────────────────────────────────┘
```

#### Redis Bloom Filter（需加载 RedisBloom 模块）

```cpp
class BloomFilter {
public:
    BloomFilter(redisContext* ctx, const std::string& name,
                size_t expected_items = 1000000, double error_rate = 0.001)
        : ctx_(ctx), name_(name) {
        // 创建布隆过滤器（如果不存在）
        redisCommand(ctx_, "BF.RESERVE %s %f %zu",
                     name_.c_str(), error_rate, expected_items);
    }

    // 添加元素
    bool add(const std::string& item) {
        auto* reply = static_cast<redisReply*>(
            redisCommand(ctx_, "BF.ADD %s %s", name_.c_str(), item.c_str()));
        bool is_new = reply && reply->integer == 1;
        if (reply) freeReplyObject(reply);
        return is_new;
    }

    // 检查元素是否存在
    bool mightExist(const std::string& item) {
        auto* reply = static_cast<redisReply*>(
            redisCommand(ctx_, "BF.EXISTS %s %s", name_.c_str(), item.c_str()));
        bool exists = reply && reply->integer == 1;
        if (reply) freeReplyObject(reply);
        return exists;
    }

    // 批量添加
    void batchAdd(const std::vector<std::string>& items) {
        for (auto& item : items) {
            redisAppendCommand(ctx_, "BF.ADD %s %s", name_.c_str(), item.c_str());
        }
        for (size_t i = 0; i < items.size(); i++) {
            redisReply* reply;
            redisGetReply(ctx_, (void**)&reply);
            if (reply) freeReplyObject(reply);
        }
    }

private:
    redisContext* ctx_;
    std::string name_;
};

// 使用：防止缓存穿透
std::optional<User> getUserWithBloom(int64_t user_id) {
    std::string key = "user:" + std::to_string(user_id);

    // 1. 布隆过滤器预判
    if (!bloom_filter.mightExist(key)) {
        return std::nullopt;  // 一定不存在，直接返回
    }

    // 2. 查缓存
    auto cached = redis.get(key);
    if (cached) return deserialize(*cached);

    // 3. 查DB
    auto user = db.findUser(user_id);
    if (user) {
        redis.setex(key, 3600, serialize(*user));  // 缓存1小时
    } else {
        redis.setex(key, 60, "NULL");  // 空值缓存60秒（防穿透）
    }
    return user;
}

// 系统启动时加载所有用户ID到布隆过滤器
void initBloomFilter() {
    auto all_ids = db.query("SELECT id FROM users");
    for (auto& id : all_ids) {
        bloom_filter.add("user:" + std::to_string(id));
    }
}
```

---

### 4. Redis Stream：轻量级消息队列

```
  Stream vs Pub/Sub vs List：

  ┌──────────┬───────────────┬────────────────┬──────────────────┐
  │   特性   │   Pub/Sub     │   List(队列)   │    Stream        │
  ├──────────┼───────────────┼────────────────┼──────────────────┤
  │ 持久化   │ ❌ 不持久化   │ ✅ 持久化      │ ✅ 持久化        │
  ├──────────┼───────────────┼────────────────┼──────────────────┤
  │ 消费者组 │ ❌            │ ❌             │ ✅ 原生支持      │
  ├──────────┼───────────────┼────────────────┼──────────────────┤
  │ ACK机制  │ ❌            │ ❌             │ ✅ 消息确认      │
  ├──────────┼───────────────┼────────────────┼──────────────────┤
  │ 重复消费 │ 广播给所有    │ 一个消费者取走 │ 消费者组内分配   │
  ├──────────┼───────────────┼────────────────┼──────────────────┤
  │ 历史消息 │ ❌ 错过即丢失 │ ❌ 取走即删    │ ✅ 可重新消费    │
  ├──────────┼───────────────┼────────────────┼──────────────────┤
  │ 适用     │ 实时通知      │ 简单任务队列   │ 可靠消息队列     │
  └──────────┴───────────────┴────────────────┴──────────────────┘
```

```cpp
class RedisStream {
public:
    RedisStream(redisContext* ctx, const std::string& stream_name)
        : ctx_(ctx), stream_(stream_name) {}

    // 发送消息
    std::string publish(const std::unordered_map<std::string, std::string>& fields) {
        std::string cmd = "XADD " + stream_ + " *";
        for (auto& [k, v] : fields) {
            cmd += " " + k + " " + v;
        }
        auto* reply = static_cast<redisReply*>(
            redisCommand(ctx_, cmd.c_str()));
        std::string id = reply ? reply->str : "";
        if (reply) freeReplyObject(reply);
        return id;  // 返回消息ID如 "1716980400000-0"
    }

    // 创建消费者组
    void createGroup(const std::string& group, const std::string& start_id = "$") {
        redisCommand(ctx_, "XGROUP CREATE %s %s %s MKSTREAM",
                     stream_.c_str(), group.c_str(), start_id.c_str());
    }

    // 消费消息（消费者组模式）
    struct Message {
        std::string id;
        std::unordered_map<std::string, std::string> fields;
    };

    std::vector<Message> consume(const std::string& group,
                                  const std::string& consumer,
                                  int count = 10,
                                  int block_ms = 2000) {
        auto* reply = static_cast<redisReply*>(redisCommand(ctx_,
            "XREADGROUP GROUP %s %s COUNT %d BLOCK %d STREAMS %s >",
            group.c_str(), consumer.c_str(), count, block_ms, stream_.c_str()));

        std::vector<Message> messages;
        if (reply && reply->type == REDIS_REPLY_ARRAY && reply->elements > 0) {
            auto* stream_reply = reply->element[0]->element[1];
            for (size_t i = 0; i < stream_reply->elements; i++) {
                auto* msg = stream_reply->element[i];
                Message m;
                m.id = msg->element[0]->str;
                auto* fields = msg->element[1];
                for (size_t j = 0; j < fields->elements; j += 2) {
                    m.fields[fields->element[j]->str] = fields->element[j+1]->str;
                }
                messages.push_back(std::move(m));
            }
        }
        if (reply) freeReplyObject(reply);
        return messages;
    }

    // 确认消息已处理
    void ack(const std::string& group, const std::string& msg_id) {
        redisCommand(ctx_, "XACK %s %s %s",
                     stream_.c_str(), group.c_str(), msg_id.c_str());
    }

private:
    redisContext* ctx_;
    std::string stream_;
};

// 生产者
void publishOrderEvent(RedisStream& stream, const Order& order) {
    stream.publish({
        {"event", "order_created"},
        {"order_id", std::to_string(order.id)},
        {"user_id", std::to_string(order.user_id)},
        {"amount", std::to_string(order.amount)}
    });
}

// 消费者（通知服务）
void notificationConsumer(RedisStream& stream) {
    stream.createGroup("notification-group", "0");

    while (running) {
        auto messages = stream.consume("notification-group", "consumer-1");
        for (auto& msg : messages) {
            if (msg.fields["event"] == "order_created") {
                sendNotification(msg.fields["user_id"], "订单已创建");
            }
            stream.ack("notification-group", msg.id);
        }
    }
}
```

---

### 5. 实用模式汇总

| 场景 | Redis方案 | 数据结构 | 关键命令 |
|------|-----------|---------|---------|
| 分布式锁 | SET NX EX + Lua释放 | String | SET, EVAL |
| 延迟队列 | ZSet score=执行时间 | Sorted Set | ZADD, ZRANGEBYSCORE |
| 限流器 | 滑动窗口/令牌桶 | ZSet/String | ZADD, ZCOUNT, INCR |
| 布隆过滤器 | BF.ADD/BF.EXISTS | Module | BF.* |
| 排行榜 | ZSet score=分数 | Sorted Set | ZADD, ZREVRANGE |
| 消息队列 | Stream+消费者组 | Stream | XADD, XREADGROUP |
| 计数器 | INCR原子递增 | String | INCR, INCRBY |
| 分布式ID | INCR或Lua脚本 | String | INCR |
| 会话存储 | Hash存用户状态 | Hash | HSET, HGETALL, EXPIRE |
| 地理位置 | GEO类型 | GEO | GEOADD, GEORADIUS |

---

### 6. 生产注意事项

| 注意事项 | 具体建议 |
|---------|---------|
| 大key | 单个value不超过1MB，Hash/Set元素不超过5000 |
| 热key | 拆分或本地缓存，防止单分片过热 |
| 过期策略 | 所有key必须设置TTL，防止内存无限增长 |
| 持久化 | AOF appendfsync=everysec（平衡性能和可靠性） |
| 内存淘汰 | 配置maxmemory-policy为allkeys-lru |
| 连接池 | 使用连接池（不要每次操作新建连接） |
| Pipeline | 批量操作用Pipeline减少RTT |
| Lua脚本 | 复杂原子操作用Lua，避免多次网络往返 |

---

### 总结

Redis进阶用法的核心：

1. **分布式锁**：SET NX EX + Lua释放 + 看门狗续期，是生产标配
2. **延迟队列**：ZSet天然有序，score存执行时间，轮询消费到期任务
3. **布隆过滤器**：空间换时间，1亿数据只需120MB，防缓存穿透利器
4. **Stream消息队列**：Redis 5.0+原生支持消费者组、ACK、持久化，轻量级Kafka
5. **Lua脚本是原子性保障**：多步操作必须用Lua脚本封装，防止并发问题

Redis的强大在于它的数据结构足够丰富，且所有操作都是原子的。掌握这些进阶用法，很多原本需要引入重量级中间件的场景，用Redis就能优雅解决。
