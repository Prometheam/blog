---
layout: post_layout
title: "GCC中string实现探究"
date: 2026-07-20 12:00:00 +0800
location: 西安
excerpt_separator: "```"
---



#### 前置说明

ABI(Application Binary Interface，应用二进制接口)定义机器码层面的交互规则，数据布局、调用约定、符号名、库接口等。
API(Application Programming Interface)源代码层面的约定，函数名、函数类型、返回值等。

D_GLIBCXX_USE_CXX11_ABI是GCC 5 引入的宏，控制std::string 以及std::list的内部实现：-D_GLIBCXX_USE_CXX11_ABI=0使用旧版ABI，-D_GLIBCXX_USE_CXX11_ABI=1使用新版ABI



#### std::string的实现

新版本std::string 内部是SSO(Small String Optimization)实现，SSO的核心思路是：短字符串直接存在string对象本身的内存里，不单独分配堆内存。

**旧版（COW，_GLIBCXX_USE_CXX11_ABI=0）**

 ```
  // string 对象本身——只有 8 字节
   struct basic_string {
       struct _Alloc_hider : allocator_type {
           pointer _M_p;           // 8字节，指向字符数据（_Rep后面的位置）
       } _M_dataplus;
   };
   // sizeof = 8
 
   // _Rep 在堆上，_M_p 指向它后面的字符数据起始处
   struct _Rep_base {
       size_type       _M_length;      // 8字节
       size_type       _M_capacity;    // 8字节
       _Atomic_word    _M_refcount;    // 4字节，引用计数
       // 后面紧跟字符数据
   };
 
   // 内存布局（堆上的一整块）：
   // [_M_length][_M_capacity][_M_refcount][padding][字符数据...\0]
   //  _M_p 指向这里 ↑————————————↑
 ```



  工作机制：

  - 拷贝 string：只增加 _M_refcount，_M_p 指向同一块堆内存（浅拷贝）
  - 写入 string（修改内容）：先检查 _M_refcount == 1？如果是，就地改；如果不是，先重新分配一块新内存拷贝过去（COW——写时才真正拷贝）
  - 释放 string：_M_refcount--，减到 0 才真正释放堆内存
  - _M_p - 1 可以回溯到 _Rep 头部来获取长度、容量等信息（_M_p 指向 _Rep 尾部之后的位置）

  问题：
  - 多线程下 _M_refcount 的原子操作有开销
  - COW 行为在某些场景下违反 C++11 标准的要求（如 &s[0] 应该返回可写引用，但 COW 实现必须提前做 unshare）
  - size() 需要间接寻址（通过 _M_p 回溯找 _Rep），不是直接读成员

---
  **新版（SSO，_GLIBCXX_USE_CXX11_ABI=1）**

 ```
  struct basic_string {
       struct _Alloc_hider {
           pointer _M_p;               // 8字节，指向字符数据
       } _M_dataplus;
 
       size_type _M_string_length;     // 8字节，字符串长度，直接读
     
       enum { _S_local_capacity = 15 }; // 短字符串最大容量
     
       union {
           char        _M_local_buf[_S_local_capacity + 1]; // 16字节，SSO缓冲区
           size_type   _M_allocated_capacity;                // 8字节，堆缓冲区容量
       };
 
   };
   // sizeof = 8 + 8 + 16 = 32
 ```



  短字符串模式（长度 ≤ 15）：

  内存布局（对象本身 32 字节）：
```
  ┌──────────┬──────────┬──────────────────┐
  │ _M_p     │ _M_length│ _M_local_buf[16] │
  │ 8字节     │ 8字节     │ 16字节           │
  │ 指向local │ 5        │ "hello\0" + 10字节│
  │ buf起始   │          │ 空间             │
  └──────────┴──────────┴──────────────────┘
```



  - _M_p 指向 _M_local_buf 的地址（对象内部）
  - 字符数据直接存 _M_local_buf 里，零堆分配
  - _M_allocated_capacity 不使用（union 只生效一个成员）

  长字符串模式（长度 > 15）：

```
  对象本身（32字节）：
  ┌──────────┬──────────┬──────────────────┐
  │ _M_p     │ _M_length│ union            │
  │ 8字节    │ 8字节    │ 16字节           │
  │ 指向堆   │ 25510    │ _M_allocated_    │
  │ 缓冲区   │          │ capacity=65535   │
  └──────────┴──────────┴──────────────────┘

  堆缓冲区（单独分配）：
  ┌─────────────────────────────────────────┐
  │ 字符数据...\0                            │
  │ 65535字节                                │
  └─────────────────────────────────────────┘
```



  - _M_p 指向堆上分配的缓冲区
  - _M_allocated_capacity 记录堆缓冲区容量
  - _M_local_buf 这 16 字节被浪费（union 中只用了 _M_allocated_capacity）



#### std::list的实现

**旧版（_GLIBCXX_USE_CXX11_ABI=0）**

 ```
  // list 对象本身
   struct list {
       struct _List_impl {
           _List_node_base _M_node;   // 哨兵节点，16字节
       } _M_impl;
   };
   // sizeof = 16
 
   // 哨兵节点（也是每个链表节点的基类）
   struct _List_node_base {
       _List_node_base* _M_next;   // 8字节
       _List_node_base* _M_prev;   // 8字节
   };
   // sizeof = 16
 
   // 实际数据节点
   struct _List_node : _List_node_base {
       T _M_data;                  // 用户数据
   };
 
   // 内存布局：
   //  list对象(16字节)         链表节点1              链表节点2
   // ┌────────────────┐   ┌─────────────┬─────┐   ┌─────────────┬─────┐
   // │ _M_next        │──→│ _M_next     │ data │──→│ _M_next     │ data │
   // │ _M_prev        │   │ _M_prev     │      │   │ _M_prev     │      │
   // └────────────────┘←──│ _M_prev     │      │←──│ _M_prev     │      │
   //                      └─────────────┴─────┘   └─────────────┴─────┘
 ```



  - 哨兵节点的 _M_next 指向第一个数据节点，_M_prev 指向最后一个数据节点
  - 空链表时 _M_next 和 _M_prev 都指向哨兵自己（循环）
  - 不存储元素个数，size() 必须从头遍历到尾计数，O(n)

 ```
  // 旧版 size() 实现
   size_type size() const {
       size_type __result = 0;
       for (const_iterator __i = begin(); __i != end(); ++__i)
           ++__result;
       return __result;
   }
 ```



---
  **新版（_GLIBCXX_USE_CXX11_ABI=1）**

  ```
  // list 对象本身
    struct list {
        struct _List_impl {
            _List_node_header _M_node;   // 哨兵头节点，24字节
        } _M_impl;
    };
    // sizeof = 24
  
    // 哨兵头节点
    struct _List_node_header : _List_node_base {
        size_type _M_size;           // 8字节，新增！记录元素个数
    };
    // sizeof = 16 + 8 = 24
  
    // 哨兵节点的基类（没变）
    struct _List_node_base {
        _List_node_base* _M_next;   // 8字节
        _List_node_base* _M_prev;   // 8字节
    };
  
    // 实际数据节点（没变）
    struct _List_node : _List_node_base {
        T _M_data;
    };
  
    // 内存布局：
    //  list对象(24字节)         链表节点1              链表节点2
    // ┌────────────────┐   ┌─────────────┬─────┐   ┌─────────────┬─────┐
    // │ _M_next        │──→│ _M_next     │data │──→│ _M_next     │data │
    // │ _M_prev        │   │ _M_prev     │     │   │ _M_prev     │     │
    // │ _M_size = 2    │   │ _M_prev     │     │   │ _M_prev     │     │
    // └────────────────┘←──│ _M_prev     │     │←──│ _M_prev     │     │
    //                      └─────────────┴─────┘   └─────────────┴─────┘
  ```



  - 哨兵节点新增 _M_size 成员，直接记录元素个数
  - 每次 push_back / push_front / insert 时 _M_size++
  - 每次 erase / pop_back / pop_front 时 _M_size--
  - size() 直接返回 _M_size，O(1)

```
  // 新版 size() 实现
  size_type size() const {
      return _M_impl._M_node._M_size;
  }
```



---