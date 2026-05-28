---
title: "RESTful API设计规范：从理论到工程落地"
categories: [架构设计]
location: 西安
---

### 引言

API是后端服务的"用户界面"。一个设计糟糕的API，会让前端同事每天骂你；一个设计优雅的API，能减少80%的沟通成本和联调时间。

我见过太多"伪REST"——所有接口都是POST，URL类似`/api/doSomething`，返回值永远200加一个`code`字段。这不是REST，只是HTTP上的RPC。真正的RESTful设计有明确的规范和层次模型。

本文从Richardson成熟度模型讲起，系统介绍RESTful API的设计规范，覆盖URL设计、HTTP方法语义、分页排序、版本管理等核心话题，最后用C++实现一个标准的RESTful服务。

---

### 1. REST 成熟度模型

Leonard Richardson提出的REST成熟度模型，将API分为4个层次：

```
Richardson Maturity Model（REST 成熟度阶梯）：

  Level 3 ── 超媒体控制（HATEOAS）
    │         响应中包含状态转换链接，客户端无需硬编码URL
    │
  Level 2 ── HTTP 动词（最常用的实践水平）
    │         正确使用GET/POST/PUT/PATCH/DELETE + 状态码
    │
  Level 1 ── 资源（Resources）
    │         引入资源概念，每个资源有独立URI
    │
  Level 0 ── HTTP 隧道（RPC over HTTP）
              单一端点 + POST，HTTP只是传输层
```

大多数生产级API应达到 **Level 2**，Level 3（HATEOAS）仅在开放平台/公共API中有实际价值。

---

### 2. URL 设计规范

#### 2.1 核心原则

| 原则 | 正确 ✅ | 错误 ❌ | 原因 |
|------|---------|---------|------|
| 名词复数 | `/users` | `/user`, `/getUsers` | 资源是集合，动词在HTTP方法中表达 |
| 层级关系 | `/users/123/orders` | `/getUserOrders?id=123` | URL表达所属关系 |
| 小写连字符 | `/order-items` | `/orderItems`, `/order_items` | URL对大小写敏感，连字符更SEO友好 |
| 无动词 | `/users/123` + DELETE | `/deleteUser/123` | HTTP方法已表达动作 |
| 无扩展名 | `/users/123` | `/users/123.json` | 用Accept头协商格式 |

#### 2.2 资源建模实战

以电商系统为例的URL设计：

```
# 一级资源
GET    /products                  # 商品列表
POST   /products                  # 创建商品
GET    /products/{id}             # 商品详情
PUT    /products/{id}             # 全量更新商品
PATCH  /products/{id}             # 部分更新商品
DELETE /products/{id}             # 删除商品

# 二级资源（嵌套关系）
GET    /products/{id}/reviews     # 某商品的评价列表
POST   /products/{id}/reviews     # 为商品添加评价

# 用户资源
GET    /users/{id}/orders         # 用户的订单列表
GET    /users/{id}/orders/{oid}   # 用户某个订单详情

# 非CRUD操作：使用子资源或动作端点
POST   /orders/{id}/cancel        # 取消订单（状态机转换）
POST   /users/{id}/verify-email   # 发送验证邮件（触发动作）
```

#### 2.3 URL 深度建议

嵌套不超过2层。过深的嵌套使URL冗长且耦合：

```
# ❌ 过深嵌套
GET /companies/123/departments/456/employees/789/tasks/012

# ✅ 扁平化：用顶级资源 + 过滤参数
GET /tasks/012
GET /tasks?employee_id=789&department_id=456
```

---

### 3. HTTP 方法语义矩阵

| 方法 | 语义 | 幂等 | 安全 | 请求体 | 典型响应码 |
|------|------|------|------|--------|-----------|
| GET | 获取资源 | ✅ | ✅ | 无 | 200, 404 |
| POST | 创建资源/触发操作 | ❌ | ❌ | 有 | 201, 202, 400 |
| PUT | 全量替换资源 | ✅ | ❌ | 有 | 200, 204, 404 |
| PATCH | 部分更新资源 | ❌* | ❌ | 有 | 200, 204, 404 |
| DELETE | 删除资源 | ✅ | ❌ | 通常无 | 204, 404 |
| HEAD | 获取头信息 | ✅ | ✅ | 无 | 200, 404 |
| OPTIONS | 获取支持的方法 | ✅ | ✅ | 无 | 204 |

> *PATCH语义上可以设计为幂等（如JSON Merge Patch），但规范不要求。

**幂等性的工程意义**：网络超时时，幂等请求可以安全重试。PUT和DELETE天然幂等，POST需要额外机制（如幂等键）。

```
幂等键防重复提交：

  Client                              Server
    │  POST /orders                     │
    │  Idempotency-Key: abc-123         │
    │  Body: {product: "X", qty: 1}     │
    │  ────────────────────────────>    │
    │                                   │  处理中... 创建订单
    │  <──── 网络超时，无响应 ─────────  │
    │                                   │
    │  [客户端重试]                      │
    │  POST /orders                     │
    │  Idempotency-Key: abc-123         │  ← 相同key
    │  ────────────────────────────>    │
    │                                   │  检测到重复key
    │  <──── 200 + 原始结果 ──────────  │  ← 返回首次结果，不重复创建
```

---

### 4. 分页、过滤与排序

#### 4.1 分页方案对比

| 方案 | 实现 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|---------|
| Offset分页 | `?page=2&size=20` | 实现简单，支持跳页 | 深分页性能差，数据变动时漏/重复 | 管理后台 |
| Cursor分页 | `?cursor=eyJpZCI6MTIzfQ&size=20` | 性能稳定，不漏数据 | 不支持跳页 | 无限滚动/Feed流 |
| Keyset分页 | `?after_id=123&size=20` | 性能好，语义清晰 | 仅支持单一排序 | 时间线 |

#### 4.2 标准查询参数

```
# 分页
GET /products?page=1&per_page=20
GET /products?cursor=eyJpZCI6MTIzfQ&limit=20

# 过滤
GET /products?category=electronics&price_min=100&price_max=500
GET /products?status=active&created_after=2024-01-01

# 排序（字段前缀-表示降序）
GET /products?sort=price          # 价格升序
GET /products?sort=-created_at    # 创建时间降序
GET /products?sort=-price,name    # 多字段排序

# 字段选择（减少传输量）
GET /products?fields=id,name,price

# 搜索
GET /products?q=iPhone
```

#### 4.3 分页响应格式

```json
{
  "data": [...],
  "pagination": {
    "total": 1234,
    "page": 2,
    "per_page": 20,
    "total_pages": 62,
    "next_cursor": "eyJpZCI6MTQzfQ==",
    "links": {
      "self": "/products?page=2&per_page=20",
      "next": "/products?page=3&per_page=20",
      "prev": "/products?page=1&per_page=20",
      "first": "/products?page=1&per_page=20",
      "last": "/products?page=62&per_page=20"
    }
  }
}
```

---

### 5. HTTP 状态码规范

| 分类 | 常用码 | 含义 | 使用场景 |
|------|--------|------|---------|
| 2xx成功 | 200 | OK | GET/PUT/PATCH成功 |
| | 201 | Created | POST创建成功 |
| | 204 | No Content | DELETE成功/无返回体 |
| 3xx重定向 | 301 | 永久迁移 | API版本迁移 |
| | 304 | 未修改 | 配合ETag缓存 |
| 4xx客户端错误 | 400 | 请求体格式错误 | JSON解析失败/参数校验失败 |
| | 401 | 未认证 | Token过期/缺失 |
| | 403 | 无权限 | 已认证但权限不足 |
| | 404 | 资源不存在 | ID不存在 |
| | 409 | 冲突 | 并发修改/唯一约束冲突 |
| | 422 | 语义错误 | 格式正确但业务规则不满足 |
| | 429 | 限流 | 请求频率超限 |
| 5xx服务端错误 | 500 | 内部错误 | 未预期的服务端异常 |
| | 502 | 网关错误 | 上游服务不可达 |
| | 503 | 服务不可用 | 过载/维护中 |

**错误响应标准格式**（参考RFC 7807 Problem Details）：

```json
{
  "type": "https://api.example.com/errors/validation-failed",
  "title": "Validation Failed",
  "status": 422,
  "detail": "The 'email' field is not a valid email address",
  "instance": "/users/registration",
  "errors": [
    {
      "field": "email",
      "code": "invalid_format",
      "message": "Must be a valid email address"
    },
    {
      "field": "age",
      "code": "out_of_range",
      "message": "Must be between 1 and 150"
    }
  ],
  "trace_id": "abc-123-def-456"
}
```

---

### 6. 版本管理策略

| 策略 | 示例 | 优点 | 缺点 |
|------|------|------|------|
| URI路径 | `/v1/users`, `/v2/users` | 直观、缓存友好 | URL变动大 |
| 请求头 | `Accept: application/vnd.api+json;version=2` | URL不变 | 不够显式、调试困难 |
| 查询参数 | `/users?version=2` | 灵活 | 缓存问题 |

**推荐实践**：主版本号放URL路径（`/v1/`、`/v2/`），小版本通过向后兼容实现。

```
版本演进策略：

  /v1/users  ─── 长期维护（至少6个月废弃通知）
       │
       │  添加新字段、新端点 → 无需新版本（向后兼容）
       │  修改字段类型、删除字段 → 需要新版本
       │
  /v2/users  ─── Breaking changes
       │
       │  Response Header: Sunset: Sat, 01 Jan 2026 00:00:00 GMT
       │  （告知客户端v1即将废弃的日期）
```

---

### 7. 实战：C++ 实现 RESTful API

使用 [Crow](https://github.com/CrowCpp/Crow) 框架（轻量高性能，类似Python Flask）：

```cpp
#include "crow.h"
#include <unordered_map>
#include <mutex>
#include <atomic>

// 简单的内存存储（生产环境应接数据库）
struct Product {
    int64_t id;
    std::string name;
    double price;
    std::string category;
    std::string created_at;
};

class ProductStore {
    std::unordered_map<int64_t, Product> products_;
    std::mutex mtx_;
    std::atomic<int64_t> next_id_{1};
public:
    // 创建
    Product create(const std::string& name, double price, const std::string& category) {
        std::lock_guard lock(mtx_);
        int64_t id = next_id_++;
        Product p{id, name, price, category, "2026-05-29T10:00:00Z"};
        products_[id] = p;
        return p;
    }
    
    // 查询
    std::optional<Product> get(int64_t id) {
        std::lock_guard lock(mtx_);
        auto it = products_.find(id);
        if (it == products_.end()) return std::nullopt;
        return it->second;
    }
    
    // 列表（支持分页和过滤）
    std::vector<Product> list(int page, int per_page, const std::string& category = "") {
        std::lock_guard lock(mtx_);
        std::vector<Product> result;
        for (auto& [id, p] : products_) {
            if (!category.empty() && p.category != category) continue;
            result.push_back(p);
        }
        // 排序 + 分页
        std::sort(result.begin(), result.end(),
                  [](auto& a, auto& b) { return a.id < b.id; });
        int start = (page - 1) * per_page;
        int end = std::min(start + per_page, (int)result.size());
        if (start >= (int)result.size()) return {};
        return {result.begin() + start, result.begin() + end};
    }
    
    // 更新
    bool update(int64_t id, const crow::json::rvalue& body) {
        std::lock_guard lock(mtx_);
        auto it = products_.find(id);
        if (it == products_.end()) return false;
        if (body.has("name")) it->second.name = body["name"].s();
        if (body.has("price")) it->second.price = body["price"].d();
        if (body.has("category")) it->second.category = body["category"].s();
        return true;
    }
    
    // 删除
    bool remove(int64_t id) {
        std::lock_guard lock(mtx_);
        return products_.erase(id) > 0;
    }
    
    size_t count(const std::string& category = "") {
        std::lock_guard lock(mtx_);
        if (category.empty()) return products_.size();
        return std::count_if(products_.begin(), products_.end(),
            [&](auto& kv) { return kv.second.category == category; });
    }
};

int main() {
    crow::SimpleApp app;
    ProductStore store;

    // GET /v1/products — 列表（支持分页、过滤）
    CROW_ROUTE(app, "/v1/products").methods(crow::HTTPMethod::GET)
    ([&store](const crow::request& req) {
        int page = req.url_params.get("page") ?
                   std::stoi(req.url_params.get("page")) : 1;
        int per_page = req.url_params.get("per_page") ?
                       std::stoi(req.url_params.get("per_page")) : 20;
        std::string category = req.url_params.get("category") ?
                               req.url_params.get("category") : "";

        // 限制per_page范围
        per_page = std::clamp(per_page, 1, 100);

        auto products = store.list(page, per_page, category);
        size_t total = store.count(category);

        crow::json::wvalue response;
        crow::json::wvalue::list data;
        for (auto& p : products) {
            crow::json::wvalue item;
            item["id"] = p.id;
            item["name"] = p.name;
            item["price"] = p.price;
            item["category"] = p.category;
            item["created_at"] = p.created_at;
            data.push_back(std::move(item));
        }
        response["data"] = std::move(data);
        response["pagination"]["total"] = total;
        response["pagination"]["page"] = page;
        response["pagination"]["per_page"] = per_page;
        response["pagination"]["total_pages"] = (total + per_page - 1) / per_page;

        return crow::response(200, response);
    });

    // POST /v1/products — 创建
    CROW_ROUTE(app, "/v1/products").methods(crow::HTTPMethod::POST)
    ([&store](const crow::request& req) {
        auto body = crow::json::load(req.body);
        if (!body) {
            crow::json::wvalue err;
            err["type"] = "https://api.example.com/errors/invalid-json";
            err["title"] = "Invalid JSON";
            err["status"] = 400;
            return crow::response(400, err);
        }

        // 参数校验
        if (!body.has("name") || !body.has("price")) {
            crow::json::wvalue err;
            err["type"] = "https://api.example.com/errors/validation-failed";
            err["title"] = "Validation Failed";
            err["status"] = 422;
            err["detail"] = "Fields 'name' and 'price' are required";
            return crow::response(422, err);
        }

        auto product = store.create(
            body["name"].s(),
            body["price"].d(),
            body.has("category") ? body["category"].s() : "general"
        );

        crow::json::wvalue response;
        response["id"] = product.id;
        response["name"] = product.name;
        response["price"] = product.price;
        response["category"] = product.category;
        response["created_at"] = product.created_at;

        auto res = crow::response(201, response);
        res.add_header("Location", "/v1/products/" + std::to_string(product.id));
        return res;
    });

    // GET /v1/products/:id — 详情
    CROW_ROUTE(app, "/v1/products/<int>").methods(crow::HTTPMethod::GET)
    ([&store](int id) {
        auto product = store.get(id);
        if (!product) {
            crow::json::wvalue err;
            err["type"] = "https://api.example.com/errors/not-found";
            err["title"] = "Product Not Found";
            err["status"] = 404;
            return crow::response(404, err);
        }

        crow::json::wvalue response;
        response["id"] = product->id;
        response["name"] = product->name;
        response["price"] = product->price;
        response["category"] = product->category;
        response["created_at"] = product->created_at;
        return crow::response(200, response);
    });

    // PATCH /v1/products/:id — 部分更新
    CROW_ROUTE(app, "/v1/products/<int>").methods(crow::HTTPMethod::PATCH)
    ([&store](const crow::request& req, int id) {
        auto body = crow::json::load(req.body);
        if (!body) return crow::response(400);
        
        if (!store.update(id, body)) {
            return crow::response(404);
        }
        return crow::response(204);
    });

    // DELETE /v1/products/:id — 删除
    CROW_ROUTE(app, "/v1/products/<int>").methods(crow::HTTPMethod::DELETE)
    ([&store](int id) {
        if (!store.remove(id)) {
            return crow::response(404);
        }
        return crow::response(204);  // 成功删除，无返回体
    });

    app.port(8080).multithreaded().run();
}
```

---

### 8. 设计决策矩阵

面对具体场景时的选型建议：

| 场景 | 推荐方案 | 原因 |
|------|---------|------|
| 公开API（第三方接入）| REST Level 2 + OpenAPI文档 | 通用性强、工具链完善 |
| 微服务内部通信 | gRPC | 性能好、强类型、代码生成 |
| 实时数据推送 | WebSocket / SSE | REST不适合长连接 |
| 文件上传 | multipart/form-data | REST对大文件支持有限 |
| 复杂查询（多条件聚合）| GraphQL | REST需要大量定制端点 |
| 高吞吐低延迟 | gRPC + Protobuf | 二进制序列化、HTTP/2 |

---

### 总结

RESTful API设计的核心准则：

1. **资源为中心**：URL表达"什么"（名词），HTTP方法表达"怎么做"（动词）
2. **状态码语义清晰**：200/201/204/400/401/403/404/422/429/500，不要都返回200
3. **幂等性保障**：PUT/DELETE天然幂等，POST用幂等键防重复
4. **分页必须有**：永远不要返回无限大的列表
5. **错误响应标准化**：RFC 7807 Problem Details格式，含trace_id便于排查
6. **版本管理前置**：从第一天就用`/v1/`，向后兼容优先

好的API设计是"一次正确，终身受用"的投资。改一个API比改内部实现痛苦10倍——因为你还要协调所有客户端升级。
