---
layout: post_layout
title: "C++代码优化之noexcept"
date: 2017-07-10 21:30:00 +0800
categories: [C++语言]
location: 西安
excerpt_separator: "```"
---
&ensp;&ensp;&ensp;&ensp;`noexcept` 是 C++11 引入的关键字，用于指定函数是否会抛出异常。它的主要作用是:

1. **性能优化**：编译器可能为 `noexcept` 函数生成更高效的代码（如省略异常处理逻辑）。
2. **移动语义**：标准库（如 `std::vector`）在扩容时，若元素类型的移动操作是 `noexcept`，会优先使用移动而非复制。
3. **契约声明**：明确告知调用者函数不会抛出异常，简化错误处理。


- **作为说明符（Specifier）**：声明函数不会抛出异常

  ```
  void func() noexcept {
      // 如果此处抛出异常，程序会调用 std::terminate()
  }
  ```

  - **条件性 `noexcept`**（C++11 起）：

    ```
    void bar() noexcept(true);  // 等价于 noexcept
    void baz() noexcept(false); // 可能抛出异常
    ```

  - **模板中的条件 `noexcept`**：

    ```
    template<typename T>
    void swap(T& a, T& b) noexcept(noexcept(a.swap(b))) {
        a.swap(b); // 仅当 a.swap(b) 不抛异常时，整个函数才是 noexcept
    }
    ```

    

- **作为运算符（Operator）**：检查表达式是否声明为 `noexcept`，返回 `bool`。

  ```
  bool is_noexcept = noexcept(func());  // 检查 func() 是否声明为 noexcept
  ```
