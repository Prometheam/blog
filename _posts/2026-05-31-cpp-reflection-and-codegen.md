---
title: "C++反射与代码生成：从编译期内省到自动化序列化"
categories: [C++语言]
location: 西安
render_with_liquid: false
---

### 引言

C++没有原生反射——你无法在运行时获取一个类有哪些成员、叫什么名字、是什么类型。这导致序列化、ORM映射、RPC stub生成等场景需要大量手写重复代码。

但我们有替代方案：宏+模板的编译期反射、libclang解析源码生成代码、C++26即将到来的标准反射。本文讲解三种实现C++反射的方式，以及如何用它们自动生成序列化/反序列化代码。

---

### 1. 为什么需要反射

```
  没有反射时的痛苦：

  struct User {
      int id;
      std::string name;
      double salary;
      bool active;
  };

  // ❌ 手写JSON序列化（每加一个字段都要改）
  std::string toJson(const User& u) {
      return "{\"id\":" + std::to_string(u.id) +
             ",\"name\":\"" + u.name + "\"" +
             ",\"salary\":" + std::to_string(u.salary) +
             ",\"active\":" + (u.active ? "true" : "false") + "}";
  }

  // 50个struct × 每个10个字段 = 500行重复代码 😱
  // 而且每次加字段都可能忘记更新序列化函数

  有反射后：
  // ✅ 一行搞定
  std::string json = serialize<Json>(user);  // 自动遍历所有字段
```

---

### 2. 方案一：宏 + 编译期反射（当前最实用）

```cpp
#include <string>
#include <tuple>
#include <type_traits>

// 定义反射宏：注册结构体的字段信息
#define REFLECT(Type, ...)                                          \
    static constexpr auto reflect_members() {                       \
        return std::make_tuple(__VA_ARGS__);                        \
    }                                                               \
    static constexpr const char* reflect_name() { return #Type; }

#define FIELD(name) std::make_pair(#name, &Self::name)

// 使用：声明带反射的结构体
struct User {
    using Self = User;
    int id;
    std::string name;
    double salary;
    bool active;

    REFLECT(User,
        FIELD(id),
        FIELD(name),
        FIELD(salary),
        FIELD(active)
    )
};

// 通用序列化：遍历所有注册字段
template<typename T>
std::string toJson(const T& obj) {
    std::string json = "{";
    bool first = true;

    auto members = T::reflect_members();
    std::apply([&](auto&&... fields) {
        ((
            json += (first ? "" : ","),
            json += "\"" + std::string(fields.first) + "\":",
            json += fieldToJson(obj.*(fields.second)),
            first = false
        ), ...);
    }, members);

    json += "}";
    return json;
}

// 字段类型到JSON的转换
template<typename T>
std::string fieldToJson(const T& value) {
    if constexpr (std::is_same_v<T, std::string>) {
        return "\"" + value + "\"";
    } else if constexpr (std::is_same_v<T, bool>) {
        return value ? "true" : "false";
    } else if constexpr (std::is_arithmetic_v<T>) {
        return std::to_string(value);
    }
}

// 使用
User u{1, "张三", 8000.0, true};
std::string json = toJson(u);
// {"id":1,"name":"张三","salary":8000.000000,"active":true}
```

---

### 3. 方案二：libclang 解析源码生成代码

```
  代码生成流程：

  源文件(.h)                 生成器                      生成的文件
  ┌─────────────┐           ┌──────────────┐          ┌────────────────┐
  │ struct User {│  libclang │              │          │ // 自动生成     │
  │   int id;   │ ────────→ │ 解析AST      │ ───────→ │ void serialize │
  │   string name│          │ 提取字段信息  │          │ (User& u,...) {│
  │ };          │           │ 生成代码      │          │   write(u.id)  │
  └─────────────┘           └──────────────┘          │   write(u.name)│
                                                       └────────────────┘
```

```python
#!/usr/bin/env python3
# gen_serializer.py — 用libclang解析C++头文件，生成序列化代码

import clang.cindex as ci

def generate_serializer(header_path):
    index = ci.Index.create()
    tu = index.parse(header_path, args=['-std=c++20'])

    output = '#include "' + header_path + '"\n'
    output += '#include <nlohmann/json.hpp>\n\n'

    for cursor in tu.cursor.walk_preorder():
        if cursor.kind == ci.CursorKind.STRUCT_DECL and cursor.is_definition():
            struct_name = cursor.spelling
            fields = []

            for child in cursor.get_children():
                if child.kind == ci.CursorKind.FIELD_DECL:
                    fields.append((child.spelling, child.type.spelling))

            # 生成 to_json
            output += f'void to_json(nlohmann::json& j, const {struct_name}& obj) {{\n'
            output += f'    j = nlohmann::json{{\n'
            for name, _ in fields:
                output += f'        {{"{name}", obj.{name}}},\n'
            output += f'    }};\n}}\n\n'

            # 生成 from_json
            output += f'void from_json(const nlohmann::json& j, {struct_name}& obj) {{\n'
            for name, _ in fields:
                output += f'    j.at("{name}").get_to(obj.{name});\n'
            output += f'}}\n\n'

    return output

# CMake集成：构建时自动运行生成器
# add_custom_command(
#     OUTPUT ${CMAKE_BINARY_DIR}/generated_serializers.cpp
#     COMMAND python3 gen_serializer.py ${CMAKE_SOURCE_DIR}/models.h
#     DEPENDS ${CMAKE_SOURCE_DIR}/models.h
# )
```

---

### 4. 方案三：C++26 静态反射（未来标准）

```cpp
// C++26 反射提案 (P2996) — 预计2026年进入标准

#include <meta>  // 反射头文件

struct User {
    int id;
    std::string name;
    double salary;
};

// 编译期遍历所有成员
template<typename T>
std::string autoSerialize(const T& obj) {
    std::string json = "{";
    bool first = true;

    // consteval反射：编译期获取类型的所有成员
    template for (constexpr auto member : std::meta::members_of(^T)) {
        if constexpr (std::meta::is_data_member(member)) {
            if (!first) json += ",";
            json += "\"" + std::string(std::meta::name_of(member)) + "\":";
            json += toJsonValue(obj.[:member:]);  // 访问成员
            first = false;
        }
    }

    json += "}";
    return json;
}

// 使用：完全自动，无需任何注册宏
User u{1, "张三", 8000.0};
auto json = autoSerialize(u);  // 编译器自动生成遍历代码
```

---

### 5. 实际应用：自动生成RPC Stub

```cpp
// 通过反射信息自动生成RPC客户端

// 服务接口定义
struct IOrderService {
    using Self = IOrderService;

    virtual Order getOrder(int64_t id) = 0;
    virtual bool createOrder(const Order& order) = 0;
    virtual std::vector<Order> listOrders(int64_t user_id, int limit) = 0;

    // 注册方法信息
    REFLECT_METHODS(IOrderService,
        METHOD(getOrder, "getOrder"),
        METHOD(createOrder, "createOrder"),
        METHOD(listOrders, "listOrders")
    )
};

// 自动生成的RPC客户端代理
template<typename Interface>
class RpcClient : public Interface {
    std::string server_addr_;

public:
    RpcClient(const std::string& addr) : server_addr_(addr) {}

    // 通过反射自动生成每个方法的RPC调用
    // 序列化参数 → 网络发送 → 接收响应 → 反序列化返回值
    // 所有方法自动桥接到远程调用
};

// 使用：透明的远程调用
RpcClient<IOrderService> client("order-svc:50051");
auto order = client.getOrder(12345);  // 自动序列化参数、发送请求、反序列化响应
```

---

### 6. 方案对比

```
  ┌──────────────────┬──────────────┬──────────────┬──────────────────┐
  │ 方案             │ 侵入性       │ 性能         │ 灵活性           │
  ├──────────────────┼──────────────┼──────────────┼──────────────────┤
  │ 宏+模板          │ 中（需注册） │ 编译期展开   │ 受限于宏能力     │
  ├──────────────────┼──────────────┼──────────────┼──────────────────┤
  │ libclang代码生成 │ 无侵入       │ 构建时生成   │ 任意复杂         │
  ├──────────────────┼──────────────┼──────────────┼──────────────────┤
  │ C++26标准反射    │ 无侵入       │ 编译期       │ 完全灵活         │
  ├──────────────────┼──────────────┼──────────────┼──────────────────┤
  │ 运行时注册       │ 高           │ 运行时开销   │ 完全动态         │
  └──────────────────┴──────────────┴──────────────┴──────────────────┘

  推荐：
  - 当前项目(2024-2026): 宏+模板（简单直接）或 libclang生成（无侵入）
  - 2027+: C++26标准反射（编译器支持后）
```

---

### 总结

C++反射与代码生成的核心：

1. **宏+模板是当前最实用方案**：一次注册，编译期展开，零运行时开销
2. **libclang代码生成最灵活**：解析真实AST，可生成任意复杂代码
3. **C++26标准反射是终极方案**：无侵入、编译期、语言原生支持
4. **反射的核心价值**：消除重复代码（序列化/ORM/RPC/日志全部自动化）
5. **代码生成集成到CMake**：`add_custom_command`在构建时自动运行生成器
6. **运行时反射几乎不需要**：编译期/构建期方案足以覆盖99%需求

反射不是"花哨的技巧"，而是消灭样板代码的利器。50个struct的序列化从2500行手写代码变成0行——这就是反射的工程价值。
