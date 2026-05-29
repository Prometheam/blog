---
title: "C++20/23新特性实战：Concepts、Ranges、Modules与Coroutines"
categories: [C++语言]
location: 西安
render_with_liquid: false
---

### 引言

C++20是继C++11之后最大的语言更新——四大特性（Concepts、Ranges、Modules、Coroutines）彻底改变了C++的编写方式。C++23进一步完善了这些特性并引入了std::expected、std::print等实用工具。

我在项目中逐步引入C++20特性后，代码量减少了30%，编译错误信息从"200行模板报错"变成了"概念约束不满足"一行。这不是语法糖，而是生产力的质的飞跃。

本文用实战代码展示这些新特性如何解决真实问题，以及与C++17的对比。

---

### 1. Concepts：模板错误信息的终结者

#### 1.1 问题：C++17 模板错误

```cpp
// C++17: 传入不支持的类型时，错误信息是灾难
template<typename T>
T add(T a, T b) { return a + b; }

add(std::string("hello"), std::string("world"));  // OK
add(std::vector<int>{}, std::vector<int>{});       // 编译错误：20行看不懂的信息
```

#### 1.2 C++20 Concepts 解决

```cpp
#include <concepts>

// 定义概念：类型必须支持加法
template<typename T>
concept Addable = requires(T a, T b) {
    { a + b } -> std::convertible_to<T>;
};

// 约束模板参数
template<Addable T>
T add(T a, T b) { return a + b; }

// 或用简写形式
auto add(Addable auto a, Addable auto b) { return a + b; }

add(std::vector<int>{}, std::vector<int>{});
// 错误信息：清晰一行
// error: constraints not satisfied [Addable<std::vector<int>>]
```

#### 1.3 实用 Concepts 定义

```cpp
#include <concepts>
#include <type_traits>
#include <string>

// 可序列化概念
template<typename T>
concept Serializable = requires(T t, std::string& s) {
    { t.serialize() } -> std::convertible_to<std::string>;
    { T::deserialize(s) } -> std::same_as<T>;
};

// 可哈希概念
template<typename T>
concept Hashable = requires(T t) {
    { std::hash<T>{}(t) } -> std::convertible_to<size_t>;
};

// 容器概念
template<typename C>
concept Container = requires(C c) {
    typename C::value_type;
    typename C::iterator;
    { c.begin() } -> std::input_iterator;
    { c.end() } -> std::sentinel_for<decltype(c.begin())>;
    { c.size() } -> std::convertible_to<size_t>;
};

// 数值类型概念
template<typename T>
concept Numeric = std::integral<T> || std::floating_point<T>;

// 使用：只接受可序列化的类型
template<Serializable T>
void saveToFile(const T& obj, const std::string& path) {
    std::ofstream f(path);
    f << obj.serialize();
}

// 使用：只接受容器
template<Container C>
auto sum(const C& container) {
    typename C::value_type total{};
    for (const auto& elem : container) {
        total += elem;
    }
    return total;
}
```

#### 1.4 Concepts 约束排序（重载决议）

```cpp
// 多个concept形成约束层级
template<typename T>
concept Drawable = requires(T t) { t.draw(); };

template<typename T>
concept Resizable = Drawable<T> && requires(T t, int w, int h) {
    t.resize(w, h);
};

// 编译器自动选择最受约束的重载
void render(Drawable auto& obj) {
    obj.draw();  // 通用版本
}

void render(Resizable auto& obj) {
    obj.resize(800, 600);  // 更具体的版本（优先匹配）
    obj.draw();
}
```

---

### 2. Ranges：告别手动迭代器

#### 2.1 C++17 vs C++20 对比

```cpp
#include <ranges>
#include <algorithm>
#include <vector>
#include <string>

struct Employee {
    std::string name;
    int age;
    double salary;
    std::string department;
};

std::vector<Employee> employees = { /* ... */ };

// C++17: 冗长、需要临时变量
std::vector<Employee> result;
std::copy_if(employees.begin(), employees.end(), std::back_inserter(result),
    [](const Employee& e) { return e.department == "Engineering"; });
std::sort(result.begin(), result.end(),
    [](const Employee& a, const Employee& b) { return a.salary > b.salary; });
result.resize(std::min(result.size(), size_t(5)));
std::vector<std::string> names;
std::transform(result.begin(), result.end(), std::back_inserter(names),
    [](const Employee& e) { return e.name; });

// C++20 Ranges: 声明式、管道风格、惰性求值
auto names = employees
    | std::views::filter([](const Employee& e) { return e.department == "Engineering"; })
    | std::views::transform([](const Employee& e) -> std::pair<std::string, double> {
          return {e.name, e.salary};
      })
    // 注意：ranges不支持直接sort view，需要先收集到容器
    ;

// 更复杂的组合
auto top_earners = employees
    | std::views::filter([](auto& e) { return e.age > 30; })
    | std::views::transform([](auto& e) { return e.name; })
    | std::views::take(10);

for (auto& name : top_earners) {
    std::cout << name << "\n";
}
```

#### 2.2 实用 Range Adaptor

```cpp
// 常用 views（惰性，不产生临时容器）
auto v = vec
    | std::views::filter(pred)       // 过滤
    | std::views::transform(func)    // 映射
    | std::views::take(n)            // 取前n个
    | std::views::drop(n)            // 跳过前n个
    | std::views::reverse            // 反转
    | std::views::split(',')         // 按分隔符切割
    | std::views::join               // 扁平化嵌套
    | std::views::enumerate          // C++23: 带索引
    | std::views::zip(other)         // C++23: 配对
    | std::views::chunk(3)           // C++23: 分组
    ;

// 实际例子：解析CSV行
std::string line = "name,age,salary,department";
auto fields = line
    | std::views::split(',')
    | std::views::transform([](auto&& rng) {
          return std::string(rng.begin(), rng.end());
      });

// 生成数字序列
for (int i : std::views::iota(1, 100)
             | std::views::filter([](int n) { return n % 3 == 0; })
             | std::views::take(10)) {
    std::cout << i << " ";  // 3 6 9 12 15 18 21 24 27 30
}
```

---

### 3. Modules：终结头文件地狱

```
  C++17 头文件问题：

  ┌────────────────────────┬──────────────────────────────────────┐
  │ 问题                   │ Modules 解决方案                      │
  ├────────────────────────┼──────────────────────────────────────┤
  │ 重复解析（编译慢）     │ 模块只编译一次，导入是二进制接口     │
  ├────────────────────────┼──────────────────────────────────────┤
  │ 宏污染                 │ 模块不导出宏                          │
  ├────────────────────────┼──────────────────────────────────────┤
  │ 包含顺序敏感           │ 导入顺序无关                          │
  ├────────────────────────┼──────────────────────────────────────┤
  │ ODR 违反风险           │ 模块保证唯一定义                      │
  ├────────────────────────┼──────────────────────────────────────┤
  │ 编译时间长             │ 大项目编译速度提升 2-5 倍             │
  └────────────────────────┴──────────────────────────────────────┘
```

```cpp
// math.cppm — 模块定义
export module math;

// 只导出标记为export的内容
export namespace math {
    double pi = 3.14159265358979;

    double square(double x) { return x * x; }

    double circle_area(double radius) {
        return pi * square(radius);
    }
}

// 内部实现细节（不导出）
namespace math::detail {
    double helper_func() { return 42.0; }  // 外部不可见
}
```

```cpp
// main.cpp — 使用模块
import math;       // 替代 #include
import <iostream>; // 标准库也可以用import

int main() {
    std::cout << math::circle_area(5.0) << "\n";
    // math::detail::helper_func();  // 编译错误：不可见
    return 0;
}
```

---

### 4. Coroutines：无栈协程

```cpp
#include <coroutine>
#include <optional>
#include <iostream>

// Generator: 惰性序列生成器
template<typename T>
class Generator {
public:
    struct promise_type {
        T current_value;
        std::suspend_always yield_value(T value) {
            current_value = value;
            return {};
        }
        Generator get_return_object() {
            return Generator{std::coroutine_handle<promise_type>::from_promise(*this)};
        }
        std::suspend_always initial_suspend() { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        void return_void() {}
        void unhandled_exception() { std::terminate(); }
    };

    // Iterator支持（for-range循环）
    struct iterator {
        std::coroutine_handle<promise_type> handle;
        bool done;

        iterator& operator++() {
            handle.resume();
            done = handle.done();
            return *this;
        }
        T operator*() const { return handle.promise().current_value; }
        bool operator!=(const iterator&) const { return !done; }
    };

    iterator begin() {
        handle_.resume();
        return {handle_, handle_.done()};
    }
    iterator end() { return {handle_, true}; }

    ~Generator() { if (handle_) handle_.destroy(); }

private:
    Generator(std::coroutine_handle<promise_type> h) : handle_(h) {}
    std::coroutine_handle<promise_type> handle_;
};

// 使用：Fibonacci生成器
Generator<uint64_t> fibonacci() {
    uint64_t a = 0, b = 1;
    while (true) {
        co_yield a;
        auto next = a + b;
        a = b;
        b = next;
    }
}

// 使用：文件逐行读取（惰性）
Generator<std::string> readLines(const std::string& filename) {
    std::ifstream file(filename);
    std::string line;
    while (std::getline(file, line)) {
        co_yield line;
    }
}

int main() {
    // 前20个Fibonacci数
    for (auto n : fibonacci() | std::views::take(20)) {
        std::cout << n << " ";
    }

    // 逐行处理大文件（不全部加载到内存）
    for (auto& line : readLines("huge_log.txt") | std::views::take(100)) {
        processLine(line);
    }
}
```

---

### 5. C++23 实用新增

```cpp
// std::expected (替代异常或错误码)
#include <expected>

std::expected<int, std::string> divide(int a, int b) {
    if (b == 0) return std::unexpected("Division by zero");
    return a / b;
}

auto result = divide(10, 0);
if (result) {
    std::cout << *result;
} else {
    std::cerr << result.error();
}

// Monadic操作链
auto final = divide(100, 5)
    .and_then([](int v) -> std::expected<int, std::string> {
        return v * 2;
    })
    .transform([](int v) { return v + 1; });

// std::print (替代iostream和printf)
#include <print>
std::print("Hello, {}! You are {} years old.\n", name, age);
std::println("Pi = {:.5f}", 3.14159);  // 自动换行

// std::views::enumerate (带索引遍历)
std::vector<std::string> names = {"Alice", "Bob", "Charlie"};
for (auto [idx, name] : names | std::views::enumerate) {
    std::println("[{}] {}", idx, name);
}

// std::views::zip (配对两个范围)
std::vector keys = {1, 2, 3};
std::vector values = {"one", "two", "three"};
for (auto [k, v] : std::views::zip(keys, values)) {
    std::println("{} -> {}", k, v);
}

// std::flat_map / std::flat_set (连续内存的关联容器)
#include <flat_map>
std::flat_map<int, std::string> fm;  // 底层是sorted vector，缓存友好
```

---

### 6. 新特性采纳建议

```
  ┌────────────────────────┬──────────────┬────────────────────────────────┐
  │ 特性                   │ 推荐程度     │ 注意事项                        │
  ├────────────────────────┼──────────────┼────────────────────────────────┤
  │ Concepts               │ ✅ 立即采用  │ 所有新模板代码都应使用           │
  ├────────────────────────┼──────────────┼────────────────────────────────┤
  │ Ranges                 │ ✅ 立即采用  │ 新代码优先用ranges替代algorithm  │
  ├────────────────────────┼──────────────┼────────────────────────────────┤
  │ std::format/print      │ ✅ 立即采用  │ 替代iostream和sprintf           │
  ├────────────────────────┼──────────────┼────────────────────────────────┤
  │ std::expected          │ ✅ 立即采用  │ 替代异常或自定义Result类型       │
  ├────────────────────────┼──────────────┼────────────────────────────────┤
  │ Coroutines             │ 🟡 谨慎采用  │ 需要boost.asio或自写promise_type │
  ├────────────────────────┼──────────────┼────────────────────────────────┤
  │ Modules                │ 🟡 观望      │ 工具链支持尚不成熟(CMake/IDE)   │
  ├────────────────────────┼──────────────┼────────────────────────────────┤
  │ std::jthread           │ ✅ 立即采用  │ 自动join，替代std::thread       │
  ├────────────────────────┼──────────────┼────────────────────────────────┤
  │ Three-way comparison   │ ✅ 立即采用  │ <=> 简化比较运算符              │
  └────────────────────────┴──────────────┴────────────────────────────────┘
```

---

### 总结

C++20/23带来的核心改变：

1. **Concepts**：模板约束终于有了一等公民语法，错误信息从天书变成人话
2. **Ranges**：声明式数据处理管道，告别begin()/end()迭代器噪音
3. **Modules**：头文件的终结者，编译速度提升2-5倍（工具链成熟后）
4. **Coroutines**：原生异步编程支持，Generator和async/await模式
5. **std::expected**：类型安全的错误处理，monadic操作链优雅组合
6. **std::format/print**：终于有了正常的格式化输出

建议：新项目直接用C++20标准（`-std=c++20`），优先采用Concepts和Ranges——它们的ROI最高，学习成本最低，代码质量提升最明显。
