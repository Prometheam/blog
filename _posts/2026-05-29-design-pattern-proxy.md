---
title: "设计模式详解：代理模式（Proxy）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 代理模式

一、核心思想

  为其他对象提供代理，控制对原对象的访问。

  客户端 → 代理对象 → 真实对象
             ↓
          控制访问（延迟加载、权限检查、缓存、日志等）

  代理和真实对象实现相同接口，客户端无法区分二者。

---
  二、模式结构

```
  ┌─────────────────────────────────────────────────────────┐
  │                    Subject (抽象主题)                    │
  │  ┌─────────────────────────────────────────────────┐   │
  │  │ + request()   // 公共接口                         │   │
  │  └─────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────┘
                      ▲                   ▲
                      │                   │
          ┌───────────┴───┐       ┌───────┴───────────┐
          │    Proxy      │       │   RealSubject     │
          │    (代理)     │──────▶│    (真实对象)      │
          │               │ 引用   │                   │
          │ + request()   │       │ + request()       │
          │ {             │       │ {                 │
          │   前置处理     │       │   真实业务逻辑     │
          │   real.request│       │ }                 │
          │   后置处理     │       │                   │
          │ }             │       │                   │
          └───────────────┘       └───────────────────┘
```

---
  三、代理类型

```
  ┌──────────────┬────────────────────────────────┬─────────────────────┐
  │     类型     │            用途                │        示例          │
  ├──────────────┼────────────────────────────────┼─────────────────────┤
  │ 远程代理     │ 隐藏远程对象的网络通信细节     │ RPC Stub、gRPC客户端│
  ├──────────────┼────────────────────────────────┼─────────────────────┤
  │ 虚拟代理     │ 延迟创建开销大的对象           │ 图片懒加载、大文件   │
  ├──────────────┼────────────────────────────────┼─────────────────────┤
  │ 保护代理     │ 控制访问权限                   │ 权限检查、RBAC       │
  ├──────────────┼────────────────────────────────┼─────────────────────┤
  │ 智能引用     │ 额外操作（引用计数、日志）     │ shared_ptr、日志代理 │
  ├──────────────┼────────────────────────────────┼─────────────────────┤
  │ 缓存代理     │ 缓存请求结果                   │ HTTP缓存、查询缓存   │
  └──────────────┴────────────────────────────────┴─────────────────────┘
```

---
  四、标准实现

```cpp
#include <memory>
#include <string>
#include <iostream>

// 抽象主题
class Image {
public:
    virtual ~Image() = default;
    virtual void display() = 0;
    virtual int width() const = 0;
    virtual int height() const = 0;
};

// 真实对象（开销大：加载高清图片）
class HighResImage : public Image {
    std::string filename_;
    std::vector<uint8_t> data_;  // 可能几十MB
    int width_, height_;

public:
    explicit HighResImage(const std::string& filename) : filename_(filename) {
        loadFromDisk();  // 耗时操作
    }

    void display() override {
        std::cout << "显示高清图片: " << filename_
                  << " (" << width_ << "x" << height_ << ")\n";
    }

    int width() const override { return width_; }
    int height() const override { return height_; }

private:
    void loadFromDisk() {
        std::cout << "加载图片: " << filename_ << " (耗时2秒)...\n";
        // 模拟加载大文件
        width_ = 3840; height_ = 2160;
    }
};

// 虚拟代理：延迟加载
class ImageProxy : public Image {
    std::string filename_;
    mutable std::unique_ptr<HighResImage> realImage_;  // 按需创建

public:
    explicit ImageProxy(const std::string& filename) : filename_(filename) {
        // 不立即加载，创建代理几乎零成本
    }

    void display() override {
        ensureLoaded();
        realImage_->display();
    }

    int width() const override {
        ensureLoaded();
        return realImage_->width();
    }

    int height() const override {
        ensureLoaded();
        return realImage_->height();
    }

private:
    void ensureLoaded() const {
        if (!realImage_) {
            realImage_ = std::make_unique<HighResImage>(filename_);
        }
    }
};

// 使用：创建100个代理几乎不占资源，实际只在display时加载
std::vector<std::unique_ptr<Image>> gallery;
for (int i = 0; i < 100; i++) {
    gallery.push_back(std::make_unique<ImageProxy>("photo_" + std::to_string(i) + ".jpg"));
}
// 只有用户滚动到可见区域时才触发加载
gallery[5]->display();  // 此时才真正加载第6张图
```

---
  五、保护代理：权限控制

```cpp
class Document {
public:
    virtual ~Document() = default;
    virtual std::string read() = 0;
    virtual void write(const std::string& content) = 0;
    virtual void remove() = 0;
};

class RealDocument : public Document {
    std::string content_;
    std::string filename_;
public:
    explicit RealDocument(const std::string& filename) : filename_(filename) {
        // 从存储加载
    }
    std::string read() override { return content_; }
    void write(const std::string& content) override { content_ = content; }
    void remove() override { /* 删除文件 */ }
};

// 保护代理：基于角色控制访问
class SecureDocumentProxy : public Document {
    std::unique_ptr<RealDocument> doc_;
    std::string currentUser_;
    std::string userRole_;

public:
    SecureDocumentProxy(const std::string& filename,
                       const std::string& user,
                       const std::string& role)
        : doc_(std::make_unique<RealDocument>(filename)),
          currentUser_(user), userRole_(role) {}

    std::string read() override {
        if (userRole_ == "guest") {
            throw std::runtime_error("权限不足: guest无法读取");
        }
        logAccess("read");
        return doc_->read();
    }

    void write(const std::string& content) override {
        if (userRole_ != "admin" && userRole_ != "editor") {
            throw std::runtime_error("权限不足: 需要editor或admin角色");
        }
        logAccess("write");
        doc_->write(content);
    }

    void remove() override {
        if (userRole_ != "admin") {
            throw std::runtime_error("权限不足: 仅admin可删除");
        }
        logAccess("delete");
        doc_->remove();
    }

private:
    void logAccess(const std::string& action) {
        std::cout << "[审计] " << currentUser_ << " 执行 " << action << "\n";
    }
};
```

---
  六、缓存代理

```cpp
#include <unordered_map>
#include <chrono>
#include <optional>

class DatabaseQuery {
public:
    virtual ~DatabaseQuery() = default;
    virtual std::string execute(const std::string& sql) = 0;
};

class RealDatabase : public DatabaseQuery {
public:
    std::string execute(const std::string& sql) override {
        // 真实数据库查询（可能耗时100ms+）
        std::cout << "执行SQL: " << sql << "\n";
        return "result_data";
    }
};

// 缓存代理：对相同查询缓存结果
class CachingProxy : public DatabaseQuery {
    std::unique_ptr<RealDatabase> db_;

    struct CacheEntry {
        std::string result;
        std::chrono::steady_clock::time_point expire_time;
    };
    std::unordered_map<std::string, CacheEntry> cache_;
    std::chrono::seconds ttl_;

public:
    explicit CachingProxy(std::chrono::seconds ttl = std::chrono::seconds(60))
        : db_(std::make_unique<RealDatabase>()), ttl_(ttl) {}

    std::string execute(const std::string& sql) override {
        // 只缓存SELECT查询
        if (sql.substr(0, 6) != "SELECT") {
            invalidateRelated(sql);
            return db_->execute(sql);
        }

        auto now = std::chrono::steady_clock::now();
        auto it = cache_.find(sql);

        if (it != cache_.end() && it->second.expire_time > now) {
            std::cout << "[CACHE HIT] " << sql << "\n";
            return it->second.result;
        }

        std::cout << "[CACHE MISS] " << sql << "\n";
        auto result = db_->execute(sql);
        cache_[sql] = {result, now + ttl_};
        return result;
    }

private:
    void invalidateRelated(const std::string& sql) {
        // INSERT/UPDATE/DELETE时清除相关缓存
        cache_.clear();  // 简单实现：全部清除
    }
};
```

---
  七、智能指针就是代理模式

```
  std::shared_ptr 是一个经典的智能引用代理：

  ┌─────────────────────────────────────────────────────────┐
  │  shared_ptr<T> 代理了裸指针 T* 的访问                    │
  │                                                         │
  │  额外功能：                                             │
  │  1. 引用计数（多个shared_ptr共享同一对象）               │
  │  2. 自动析构（引用计数归零时delete）                     │
  │  3. 线程安全的引用计数操作                              │
  │  4. 自定义删除器（控制释放方式）                         │
  │                                                         │
  │  接口透明：                                             │
  │  ptr->method()   // 等同于 rawPtr->method()             │
  │  *ptr            // 等同于 *rawPtr                       │
  └─────────────────────────────────────────────────────────┘
```

---
  八、vs 装饰器模式

```
  ┌──────────────────┬─────────────────────────┬──────────────────────┐
  │      维度        │        代理模式          │      装饰器模式       │
  ├──────────────────┼─────────────────────────┼──────────────────────┤
  │ 目的             │ 控制对象的访问           │ 增强对象的功能        │
  ├──────────────────┼─────────────────────────┼──────────────────────┤
  │ 对象创建         │ 代理通常自己创建真实对象 │ 装饰器接收已有对象    │
  ├──────────────────┼─────────────────────────┼──────────────────────┤
  │ 层数             │ 通常一层代理             │ 可以多层嵌套装饰      │
  ├──────────────────┼─────────────────────────┼──────────────────────┤
  │ 接口             │ 代理和真实对象接口相同   │ 装饰器可以扩展接口    │
  ├──────────────────┼─────────────────────────┼──────────────────────┤
  │ 生命周期         │ 代理管理真实对象生命周期 │ 装饰器不管被装饰对象  │
  └──────────────────┴─────────────────────────┴──────────────────────┘

  简单判断：
  - "我要控制是否/何时访问真实对象" → 代理
  - "我要给对象添加新行为" → 装饰器
```

---
  九、何时使用

  ✅ 适用场景：
  - 延迟初始化（虚拟代理）：对象创建成本高，但不一定会用到
  - 访问控制（保护代理）：需要根据权限限制访问
  - 缓存（缓存代理）：相同请求频繁发生
  - 远程对象（远程代理）：隐藏网络通信复杂性
  - 日志/审计（日志代理）：记录所有访问行为

  ❌ 不适用场景：
  - 对象创建成本低，无需延迟
  - 不需要任何访问控制逻辑
  - 代理层增加的间接性降低了代码可读性

---
  十、设计要点

  1. 代理和真实对象必须实现相同接口（客户端透明）
  2. 代理通常持有真实对象的引用/指针
  3. 虚拟代理：真实对象延迟到第一次使用时才创建
  4. 缓存代理：注意缓存失效策略（TTL/LRU）
  5. 可以组合多种代理：缓存代理 → 权限代理 → 真实对象
