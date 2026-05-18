---
layout: post_layout
title: "C++new和delete实现原理解析"
date: 2026-01-09 14:51:58 +0800
categories: [C++语言]
location: 西安
excerpt_separator: "```"
---

##### 1、new的底层实现：

new运算符通常分为两部分：分配内存和调用构造函数。对于内置类型，new只负责分配内存。对于自定义类型，new先分配内存，然后调用构造函数。

```
T* p = new T(args);

//底层等价于：
// 1. 分配内存
void* mem = operator new(sizeof(T));  // 调用全局operator new

// 2. 构造对象
T* p = static_cast<T*>(mem);
p->T::T(args);  // 调用构造函数（实际上编译器会特殊处理）
```

内存分配部分通常通过调用operator new函数来完成。operator new函数是C++运行时库提供的，它封装了底层的内存分配机制。在大多数实现中，operator new最终会调用C标准库的malloc函数，或者直接使用系统调用（如Linux下的brk或mmap）来从操作系统申请内存。

```
void* operator new(size_t size) {
    if (size == 0) size = 1;  // 处理零大小分配
    void* p;
    while ((p = malloc(size)) == 0) {  // 循环尝试分配
        if (_callnewh(size) == 0) {    // 调用new handler
            throw std::bad_alloc();    // 分配失败抛出异常
        }
    }
    return p;
}

// 不抛出异常的版本
void* operator new(size_t size, const std::nothrow_t&) noexcept {
    void* p = nullptr;
    try {
        p = operator new(size);  // 调用普通版本
    } catch (...) {
        // 捕获异常但不抛出
    }
    return p;
}
```

如果内存分配失败，operator new会抛出std::bad\_alloc异常（除非使用了nothrow版本的new）。

对于自定义类型，new运算符会在分配内存后，在内存上调用构造函数。如果构造函数抛出异常，分配的内存会被释放（通过调用operator delete），然后异常继续传播。

因此，new运算符的伪代码大致如下：

```
void* operator new(size_t size) {
    void* p = malloc(size); // 或者使用更底层的系统调用
    if (p == nullptr) {
        throw std::bad_alloc();
    }
    return p;
}

template<typename T>
T* new() {
    void* memory = operator new(sizeof(T));
    T* object = static_cast<T*>(memory);
    object->T(); // 调用构造函数，但这在C++中不能直接这样写，只是示意
    return object;
}
```

实际上，new运算符和operator new是不同的。我们通常所说的new是new运算符，而operator new是内存分配函数，可以被重载。

##### 2.delete的底层实现：

delete运算符也分为两部分：调用析构函数和释放内存。对于内置类型，delete只释放内存。对于自定义类型，delete先调用析构函数，然后释放内存。

```
delete p;

//底层等价于
if (p != nullptr) {
    p->~T();              // 1. 调用析构函数
    operator delete(p);   // 2. 释放内存
}
```

释放内存部分通过调用operator delete函数来完成。operator delete函数也是C++运行时库提供的，它封装了底层的内存释放机制。在大多数实现中，operator delete最终会调用C标准库的free函数，或者直接使用系统调用（如Linux下的munmap）来释放内存给操作系统。

因此，delete运算符的伪代码大致如下：

```
void operator delete(void* p) {
    free(p); // 或者使用更底层的系统调用
}

template<typename T>
void delete(T* object) {
    if (object != nullptr) {
        object->~T(); // 调用析构函数
        operator delete(object);
    }
}
```

##### 3、注意事项：

* new和delete是运算符，而operator new和operator delete是函数，它们可以被重载。
* 全局的operator new和operator delete由C++运行时库提供，但用户可以在全局或类级别提供自己的版本。
  ```
  //重载类特定的operator new和operator delete，以自定义内存管理。
  #include <iostream>
  #include <cstdlib>

  class MyClass {
  public:
      MyClass() { std::cout << "MyClass constructor" << std::endl; }
      ~MyClass() { std::cout << "MyClass destructor" << std::endl; }

      void* operator new(size_t size) {
          std::cout << "MyClass::operator new, size = " << size << std::endl;
          void* p = std::malloc(size);
          if (!p) throw std::bad_alloc();
          return p;
      }

      void operator delete(void* p) {
          std::cout << "MyClass::operator delete" << std::endl;
          std::free(p);
      }
  };

  int main() {
      MyClass* obj = new MyClass();
      delete obj;
      return 0;
  }
  ```
* 对于数组，有new[]和delete[]，它们会分别调用构造函数和析构函数对数组中的每个元素进行操作，并且分配和释放内存时可能会多分配一些空间来存储数组大小等信息，以便在delete[]时知道要调用多少次析构函数。具体实现取决于编译器。
  ```
  T* p = new T[n];

  //底层实现
  // 分配额外空间存储数组大小
  size_t total_size = sizeof(size_t) + n * sizeof(T);
  void* mem = operator new(total_size);

  // 在内存开始处存储数组元素数量
  *(size_t*)mem = n;

  // 调整指针到第一个元素位置
  T* p = (T*)((size_t*)mem + 1);

  // 对每个元素调用构造函数
  for (size_t i = 0; i < n; ++i) {
      new (p + i) T();  // placement new
  }

  delete[] p;
  //底层实现
  if (p != nullptr) {
      // 1. 获取数组大小（通常存储在p之前）
      size_t* size_ptr = (size_t*)p - 1;
      size_t n = *size_ptr;

      // 2. 逆序调用每个元素的析构函数
      for (size_t i = n; i > 0; --i) {
          p[i-1].~T();
      }

      // 3. 释放整个内存块（包括存储size的部分）
      operator delete(size_ptr);
  }
  ```

##### 4、底层系统调用：

在Linux系统中，malloc和free通常是使用brk或mmap系统调用来管理内存的。对于大块内存，通常使用mmap，而对于小块内存，则使用brk来扩展堆，并在堆上实现一个内存分配器来管理这些内存块。
