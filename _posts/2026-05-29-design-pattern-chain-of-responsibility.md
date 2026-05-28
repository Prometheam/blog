---
title: "设计模式详解：责任链模式（Chain of Responsibility）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 责任链模式

一、核心思想

  将请求沿着处理者链传递，直到有一个处理者处理它为止。避免请求发送者与接收者耦合。

  传统方式：发送者必须知道"谁能处理这个请求"，用 if-else 硬编码判断
  责任链：发送者只需将请求丢给链头，链上每个节点自行决定处理还是传递

  现实类比：
  - 审批流程：员工 → 组长 → 经理 → 总监 → CEO
  - HTTP中间件：请求 → 日志 → 认证 → 限流 → 路由 → 处理器
  - 异常处理：try-catch 链就是一种责任链

---
  二、模式结构

```
  ┌─────────────────────────────────────────────────────────────┐
  │                        Client                                │
  │                     (请求发送者)                              │
  └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                    Handler (抽象处理者)                       │
  │  ┌─────────────────────────────────────────────────────┐   │
  │  │ - successor: Handler*   // 下一个处理者               │   │
  │  │ + setNext(handler): Handler&  // 设置后继(链式)       │   │
  │  │ + handle(request): bool       // 处理请求             │   │
  │  └─────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────┘
                      ▲           ▲           ▲
                      │           │           │
          ┌───────────┴───┐   ┌───┴───┐   ┌───┴───────────┐
          │ ConcreteHandler│   │Concrete│   │ConcreteHandler│
          │       A        │   │HandlerB│   │       C       │
          │                │   │        │   │               │
          │ 能处理 → 处理  │   │能处理→ │   │能处理 → 处理  │
          │ 不能 → 传递    │   │不能→传递│   │不能 → 传递    │
          └────────────────┘   └────────┘   └───────────────┘

  请求传递流程：
  Client → HandlerA → HandlerB → HandlerC → (未处理/默认处理)
```

---
  三、两种责任链风格

```
  ┌──────────────────┬────────────────────────────┬─────────────────────┐
  │     风格         │          行为              │       适用场景       │
  ├──────────────────┼────────────────────────────┼─────────────────────┤
  │ 纯责任链         │ 要么处理，要么传递          │ 审批流程、异常处理   │
  │ (Pure Chain)     │ 一个请求只被一个节点处理    │                     │
  ├──────────────────┼────────────────────────────┼─────────────────────┤
  │ 不纯责任链       │ 每个节点都可以处理一部分    │ HTTP中间件、拦截器   │
  │ (Impure Chain)   │ 然后继续传递               │ 管道/过滤器          │
  └──────────────────┴────────────────────────────┴─────────────────────┘
```

---
  四、标准实现：审批流程

```cpp
#include <memory>
#include <string>
#include <iostream>

// 请求
struct PurchaseRequest {
    std::string description;
    double amount;
    std::string requester;
};

// 抽象处理者
class Approver {
public:
    virtual ~Approver() = default;

    // 链式设置后继（返回引用，支持链式调用）
    Approver& setNext(std::shared_ptr<Approver> next) {
        next_ = std::move(next);
        return *next_;
    }

    void handle(const PurchaseRequest& req) {
        if (canHandle(req)) {
            approve(req);
        } else if (next_) {
            std::cout << name() << " 无权限，转交上级\n";
            next_->handle(req);
        } else {
            std::cout << "请求被拒绝：无人有权限审批 " << req.amount << " 元\n";
        }
    }

protected:
    virtual bool canHandle(const PurchaseRequest& req) = 0;
    virtual void approve(const PurchaseRequest& req) = 0;
    virtual std::string name() const = 0;

private:
    std::shared_ptr<Approver> next_;
};

// 组长：<= 1000 元
class TeamLead : public Approver {
protected:
    bool canHandle(const PurchaseRequest& req) override { return req.amount <= 1000; }
    void approve(const PurchaseRequest& req) override {
        std::cout << "组长审批通过: " << req.description << " (" << req.amount << "元)\n";
    }
    std::string name() const override { return "组长"; }
};

// 经理：<= 10000 元
class Manager : public Approver {
protected:
    bool canHandle(const PurchaseRequest& req) override { return req.amount <= 10000; }
    void approve(const PurchaseRequest& req) override {
        std::cout << "经理审批通过: " << req.description << " (" << req.amount << "元)\n";
    }
    std::string name() const override { return "经理"; }
};

// 总监：<= 100000 元
class Director : public Approver {
protected:
    bool canHandle(const PurchaseRequest& req) override { return req.amount <= 100000; }
    void approve(const PurchaseRequest& req) override {
        std::cout << "总监审批通过: " << req.description << " (" << req.amount << "元)\n";
    }
    std::string name() const override { return "总监"; }
};

// CEO：无限额
class CEO : public Approver {
protected:
    bool canHandle(const PurchaseRequest& req) override { return true; }
    void approve(const PurchaseRequest& req) override {
        std::cout << "CEO审批通过: " << req.description << " (" << req.amount << "元)\n";
    }
    std::string name() const override { return "CEO"; }
};

// 使用
int main() {
    auto teamLead = std::make_shared<TeamLead>();
    auto manager = std::make_shared<Manager>();
    auto director = std::make_shared<Director>();
    auto ceo = std::make_shared<CEO>();

    // 构建责任链
    teamLead->setNext(manager);
    manager->setNext(director);
    director->setNext(ceo);

    // 提交请求
    teamLead->handle({"办公用品", 500, "张三"});      // 组长审批
    teamLead->handle({"服务器", 8000, "李四"});       // 经理审批
    teamLead->handle({"项目外包", 50000, "王五"});    // 总监审批
    teamLead->handle({"收购公司", 5000000, "赵六"});  // CEO审批
    return 0;
}
```

---
  五、不纯责任链：HTTP 中间件模式

  每个中间件处理一部分逻辑，然后继续传递（类似管道）：

```cpp
#include <functional>
#include <vector>
#include <string>
#include <iostream>

// HTTP 请求/响应
struct HttpRequest {
    std::string method;
    std::string path;
    std::unordered_map<std::string, std::string> headers;
    std::string body;
    std::string user_id;  // 中间件可以填充
};

struct HttpResponse {
    int status = 200;
    std::string body;
};

// 中间件类型：接收 request + next 函数
using NextFn = std::function<HttpResponse(HttpRequest&)>;
using Middleware = std::function<HttpResponse(HttpRequest&, NextFn)>;

// 中间件管道
class MiddlewarePipeline {
    std::vector<Middleware> middlewares_;
    std::function<HttpResponse(HttpRequest&)> handler_;  // 最终处理器

public:
    void use(Middleware mw) {
        middlewares_.push_back(std::move(mw));
    }

    void setHandler(std::function<HttpResponse(HttpRequest&)> handler) {
        handler_ = std::move(handler);
    }

    HttpResponse execute(HttpRequest& req) {
        // 构建调用链（从内到外）
        NextFn next = handler_;
        for (int i = middlewares_.size() - 1; i >= 0; i--) {
            auto mw = middlewares_[i];
            next = [mw, next](HttpRequest& r) { return mw(r, next); };
        }
        return next(req);
    }
};

// 日志中间件
Middleware loggingMiddleware = [](HttpRequest& req, NextFn next) -> HttpResponse {
    std::cout << "[LOG] " << req.method << " " << req.path << "\n";
    auto start = std::chrono::steady_clock::now();

    auto resp = next(req);  // 继续传递

    auto elapsed = std::chrono::steady_clock::now() - start;
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count();
    std::cout << "[LOG] Response: " << resp.status << " (" << ms << "ms)\n";
    return resp;
};

// 认证中间件
Middleware authMiddleware = [](HttpRequest& req, NextFn next) -> HttpResponse {
    auto it = req.headers.find("Authorization");
    if (it == req.headers.end()) {
        return {401, "Unauthorized"};  // 不继续传递，直接返回
    }
    req.user_id = parseToken(it->second);
    return next(req);  // 验证通过，继续传递
};

// 限流中间件
Middleware rateLimitMiddleware = [](HttpRequest& req, NextFn next) -> HttpResponse {
    if (isRateLimited(req.user_id)) {
        return {429, "Too Many Requests"};
    }
    return next(req);
};

// 组装
int main() {
    MiddlewarePipeline pipeline;
    pipeline.use(loggingMiddleware);
    pipeline.use(authMiddleware);
    pipeline.use(rateLimitMiddleware);
    pipeline.setHandler([](HttpRequest& req) -> HttpResponse {
        return {200, "Hello, " + req.user_id};
    });

    HttpRequest req{"GET", "/api/users", {{"Authorization", "Bearer xxx"}}, ""};
    auto resp = pipeline.execute(req);
    return 0;
}
```

---
  六、vs 其他模式

```
  ┌────────────────┬──────────────────────────────────────────────────┐
  │    对比模式    │              区别                                 │
  ├────────────────┼──────────────────────────────────────────────────┤
  │ 观察者        │ 观察者所有人都收到通知；责任链一人处理后即停止     │
  ├────────────────┼──────────────────────────────────────────────────┤
  │ 装饰器        │ 装饰器层层包装增强功能；责任链选择性处理并传递     │
  ├────────────────┼──────────────────────────────────────────────────┤
  │ 命令          │ 命令封装请求；责任链决定谁来执行                   │
  ├────────────────┼──────────────────────────────────────────────────┤
  │ 策略          │ 策略是客户端选择算法；责任链是链自行决定            │
  └────────────────┴──────────────────────────────────────────────────┘
```

---
  七、实际应用

```
  1. Web框架中间件（Express/Gin/ASP.NET）
     请求 → 日志 → CORS → Auth → Validation → Handler → 响应

  2. Java Servlet Filter链
     FilterChain.doFilter() 就是典型责任链

  3. GUI事件冒泡
     按钮 → 面板 → 窗口 → 应用（事件向上传播直到被处理）

  4. 异常处理
     try { } catch(IOException) { } catch(Exception) { }
     从具体到通用，第一个匹配的catch处理

  5. 日志级别过滤
     DEBUG handler → INFO handler → WARN handler → ERROR handler
```

---
  八、何时使用

  ✅ 适用场景：
  - 多个对象可以处理同一请求，但处理者在运行时才确定
  - 想要在不指定接收者的情况下发送请求
  - 处理者集合需要动态变化（运行时增删节点）
  - 请求需要经过多个处理步骤（中间件/管道）

  ❌ 不适用场景：
  - 每个请求都必须被处理（责任链可能"落空"）
  - 需要保证性能（链过长会有遍历开销）
  - 处理逻辑简单且固定（直接 if-else 更清晰）

---
  九、设计要点

  1. 链的构建应该在客户端或配置中完成，处理者不应知道链的全貌
  2. 提供一个默认处理（链尾），防止请求无人处理
  3. 不纯责任链（中间件模式）在现代Web框架中更常见
  4. 注意链过长带来的性能问题和调试困难
  5. 可以结合命令模式：请求对象化，在链中传递命令对象
