---
title: "设计模式详解：迭代器模式（Iterator）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 迭代器模式
核心思想: 提供一种方法顺序访问聚合对象中的元素，而又不暴露该对象的内部表示。迭代器将遍历逻辑从聚合对象中分离出来，使得遍历方式可以独立变化。

---
  现实比喻

  MP3 播放器：

  ┌─────────────────────────────────────┐
  │           🎵 播放列表                │
  │  ┌─────────────────────────────┐   │
  │  │ 1. 歌曲A.mp3                 │   │
  │  │ 2. 歌曲B.mp3                 │   │
  │  │ 3. 歌曲C.mp3                 │   │
  │  │ 4. 歌曲D.mp3                 │   │
  │  └─────────────────────────────┘   │
  │                                     │
  │  ◀◀  ▶  ▶▶    ← 迭代器控制遍历      │
  │  上一首 当前 下一首                  │
  └─────────────────────────────────────┘

  用户不关心歌曲怎么存储（数组？链表？数据库？）
  只需要"下一首"、"上一首"的功能

---
  代码示例：自定义迭代器
```cpp
  #include <iostream>
  #include <vector>
  #include <string>

  // 迭代器接口
  template<typename T>
  class Iterator {
  public:
      virtual ~Iterator() = default;
      virtual bool hasNext() = 0;
      virtual T next() = 0;
      virtual void reset() = 0;
  };

  // 聚合接口
  template<typename T>
  class Aggregate {
  public:
      virtual ~Aggregate() = default;
      virtual Iterator<T>* createIterator() = 0;
  };

  // 具体聚合：书籍集合
  class BookCollection : public Aggregate<std::string> {
      std::vector<std::string> m_books;

  public:
      void addBook(const std::string& book) {
          m_books.push_back(book);
      }

      size_t getCount() const { return m_books.size(); }

      const std::string& getBook(size_t index) const {
          return m_books[index];
      }

      // 创建迭代器
      Iterator<std::string>* createIterator() override;
  };

  // 具体迭代器：书籍迭代器
  class BookIterator : public Iterator<std::string> {
      const BookCollection& m_collection;
      size_t m_index = 0;

  public:
      BookIterator(const BookCollection& collection)
          : m_collection(collection) {}

      bool hasNext() override {
          return m_index < m_collection.getCount();
      }

      std::string next() override {
          return m_collection.getBook(m_index++);
      }

      void reset() override {
          m_index = 0;
      }
  };

  // 实现 createIterator（放在类定义后）
  Iterator<std::string>* BookCollection::createIterator() {
      return new BookIterator(*this);
  }

  // 使用
  int main() {
      BookCollection library;
      library.addBook("《C++ Primer》");
      library.addBook("《设计模式》");
      library.addBook("《Effective C++》");
      library.addBook("《深入理解计算机系统》");

      // 使用迭代器遍历
      Iterator<std::string>* iter = library.createIterator();

      std::cout << "=== 遍历书籍 ===" << std::endl;
      while (iter->hasNext()) {
          std::cout << "📚 " << iter->next() << std::endl;
      }

      // 重置后再次遍历
      std::cout << "\n=== 重新遍历 ===" << std::endl;
      iter->reset();
      while (iter->hasNext()) {
          std::cout << "📖 " << iter->next() << std::endl;
      }

      delete iter;
      return 0;
  }
```
  输出：
```shell
  === 遍历书籍 ===
  📚 《C++ Primer》
  📚 《设计模式》
  📚 《Effective C++》
  📚 《深入理解计算机系统》

  === 重新遍历 ===
  📖 《C++ Primer》
  📖 《设计模式》
  📖 《Effective C++》
  📖 《深入理解计算机系统》
```
---
  支持多种遍历方式
```cpp
  // 正向迭代器
  class ForwardIterator : public Iterator<std::string> {
      const BookCollection& m_collection;
      size_t m_index = 0;

  public:
      ForwardIterator(const BookCollection& c) : m_collection(c) {}
      bool hasNext() override { return m_index < m_collection.getCount(); }
      std::string next() override { return m_collection.getBook(m_index++); }
      void reset() override { m_index = 0; }
  };

  // 反向迭代器
  class ReverseIterator : public Iterator<std::string> {
      const BookCollection& m_collection;
      int m_index;

  public:
      ReverseIterator(const BookCollection& c)
          : m_collection(c), m_index(static_cast<int>(c.getCount()) - 1) {}

      bool hasNext() override { return m_index >= 0; }
      std::string next() override { return m_collection.getBook(m_index--); }
      void reset() override { m_index = static_cast<int>(m_collection.getCount()) - 1; }
  };

  // 跳跃迭代器（每隔 N 个）
  class SkipIterator : public Iterator<std::string> {
      const BookCollection& m_collection;
      size_t m_index = 0;
      size_t m_step;

  public:
      SkipIterator(const BookCollection& c, size_t step)
          : m_collection(c), m_step(step) {}

      bool hasNext() override { return m_index < m_collection.getCount(); }
      std::string next() override {
          std::string result = m_collection.getBook(m_index);
          m_index += m_step;
          return result;
      }
      void reset() override { m_index = 0; }
  };

  // 使用
  int main() {
      BookCollection library;
      for (int i = 1; i <= 6; ++i) {
          library.addBook("Book" + std::to_string(i));
      }

      std::cout << "正向遍历:" << std::endl;
      ForwardIterator forward(library);
      while (forward.hasNext()) std::cout << forward.next() << " ";

      std::cout << "\n\n反向遍历:" << std::endl;
      ReverseIterator reverse(library);
      while (reverse.hasNext()) std::cout << reverse.next() << " ";

      std::cout << "\n\n跳跃遍历(步长=2):" << std::endl;
      SkipIterator skip(library, 2);
      while (skip.hasNext()) std::cout << skip.next() << " ";

      return 0;
  }
​```cpp
  输出：
​```shell
  正向遍历:
  Book1 Book2 Book3 Book4 Book5 Book6

  反向遍历:
  Book6 Book5 Book4 Book3 Book2 Book1

  跳跃遍历(步长=2):
  Book1 Book3 Book5
```
---
  C++ STL 迭代器

  C++ 标准库已经实现了迭代器模式：
```cpp
  #include <iostream>
  #include <vector>
  #include <list>
  #include <map>
  #include <algorithm>

  int main() {
      // vector 迭代器
      std::vector<int> vec = {1, 2, 3, 4, 5};

      std::cout << "vector 遍历: ";
      for (std::vector<int>::iterator it = vec.begin(); it != vec.end(); ++it) {
          std::cout << *it << " ";
      }

      // C++11 范围 for（内部使用迭代器）
      std::cout << "\n范围 for: ";
      for (int n : vec) {
          std::cout << n << " ";
      }

      // 反向迭代器
      std::cout << "\n反向遍历: ";
      for (auto it = vec.rbegin(); it != vec.rend(); ++it) {
          std::cout << *it << " ";
      }

      // 算法配合迭代器
      std::cout << "\n查找元素: ";
      auto it = std::find(vec.begin(), vec.end(), 3);
      if (it != vec.end()) {
          std::cout << "找到 3，位置: " << std::distance(vec.begin(), it);
      }

      // 不同容器，相同遍历方式
      std::list<int> lst = {1, 2, 3};
      std::cout << "\n\nlist 遍历: ";
      for (auto it = lst.begin(); it != lst.end(); ++it) {
          std::cout << *it << " ";
      }
{% raw %}
      // map 迭代器
      std::map<std::string, int> scores = {{"Alice", 90}, {"Bob", 85}};
      std::cout << "\n\nmap 遍历:\n";
      for (auto it = scores.begin(); it != scores.end(); ++it) {
          std::cout << "  " << it->first << ": " << it->second << "\n";
      }
{% endraw %}
      return 0;
  }
```
---
  结构示意图

  ┌─────────────────────────────────────────────────────────────┐
  │                        Client                               │
  │  for (auto it = agg.createIterator(); it.hasNext();) {      │
  │      it.next();                                             │
  │  }                                                          │
  └─────────────────────────────────────────────────────────────┘
          │                                      │
          │ 创建迭代器                            │ 使用迭代器
          ▼                                      ▼
  ┌───────────────────┐              ┌───────────────────┐
  │   <<interface>>   │              │   <<interface>>   │
  │    Aggregate      │──────────────│     Iterator      │
  │───────────────────│   创建       │───────────────────│
  │+createIterator()  │              │+hasNext()         │
  └───────────────────┘              │+next()            │
           △                         │+reset()           │
           │                         └───────────────────┘
           │                                   △
  ┌────────┴────────┐                         │
  │ ConcreteAggregate│                ┌────────┴────────┐
  │─────────────────│                │ ConcreteIterator │
  │- items[]        │                │─────────────────│
  │+createIterator()│                │- collection     │
  │+getItem(index)  │                │- index          │
  │+getCount()      │                │+hasNext()       │
  └─────────────────┘                │+next()          │
          │                          │+reset()         │
          └──────────────────────────┴─────────────────┘
                      聚合提供数据访问

---
  实现简化版：支持范围 for

  让自定义容器支持 C++11 范围 for 循环：
```cpp
  #include <iostream>

  template<typename T>
  class MyArray {
      T* m_data;
      size_t m_size;

  public:
      MyArray(std::initializer_list<T> init)
          : m_size(init.size()), m_data(new T[init.size()]) {
          std::copy(init.begin(), init.end(), m_data);
      }

      ~MyArray() { delete[] m_data; }

      // 提供迭代器方法即可支持范围 for
      T* begin() { return m_data; }
      T* end() { return m_data + m_size; }

      const T* begin() const { return m_data; }
      const T* end() const { return m_data + m_size; }

      size_t size() const { return m_size; }
  };

  int main() {
      MyArray<int> arr = {10, 20, 30, 40, 50};

      // 范围 for 自动使用 begin()/end()
      std::cout << "范围 for: ";
      for (int n : arr) {
          std::cout << n << " ";
      }

      // STL 算法也能使用
      std::cout << "\n\n查找:\n";
      int* found = std::find(arr.begin(), arr.end(), 30);
      if (found != arr.end()) {
          std::cout << "找到: " << *found << std::endl;
      }

      return 0;
  }
```
---
  STL 迭代器分类

  ┌─────────────────────────────────────────────────────────────┐
  │                    STL 迭代器层级                            │
  ├─────────────────────────────────────────────────────────────┤
  │                                                             │
  │   Input Iterator        只读，单向，只能读一次               │
  │        ↑                                                    │
  │   Forward Iterator      只读，单向，可多次读                 │
  │        ↑                                                    │
  │   Bidirectional Iterator 读写，双向                         │
  │        ↑                (list, set, map)                    │
  │   Random Access Iterator 读写，随机访问                      │
  │                        (vector, deque, array)               │
  │                                                             │
  │   Output Iterator       只写，单向                          │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘

  能力递增：Input < Forward < Bidirectional < RandomAccess

---
  与其他模式配合
```cpp
  // 迭代器 + 组合模式：遍历树形结构
  template<typename T>
  class TreeNode {
      T m_data;
      std::vector<TreeNode*> m_children;

  public:
      // 深度优先迭代器
      class DfsIterator {
          std::vector<TreeNode*> m_stack;
      public:
          DfsIterator(TreeNode* root) { if (root) m_stack.push_back(root); }

          bool hasNext() { return !m_stack.empty(); }

          TreeNode* next() {
              TreeNode* node = m_stack.back();
              m_stack.pop_back();
              // 子节点逆序入栈（保证从左到右遍历）
              for (int i = node->m_children.size() - 1; i >= 0; --i) {
                  m_stack.push_back(node->m_children[i]);
              }
              return node;
          }
      };
  };
```
---
  适用场景

  ┌──────────────┬──────────────────────┐
  │     场景     │         说明         │
  ├──────────────┼──────────────────────┤
  │ 遍历聚合对象 │ 不暴露内部结构       │
  ├──────────────┼──────────────────────┤
  │ 多种遍历方式 │ 正序、反序、跳跃等   │
  ├──────────────┼──────────────────────┤
  │ 统一遍历接口 │ 不同容器相同遍历方式 │
  ├──────────────┼──────────────────────┤
  │ 需要延迟遍历 │ 按需获取下一个元素   │
  └──────────────┴──────────────────────┘

---
  优缺点

  优点：
  - 分离遍历逻辑，符合单一职责
  - 支持多种遍历方式
  - 简化聚合类接口
  - 同一聚合可有多个迭代器

  缺点：
  - 增加类数量
  - 简单遍历显得过度设计

---
  总结：迭代器模式在 C++ 中已标准化（STL 迭代器），核心思想是分离遍历逻辑与数据结构，让客户端以统一方式遍历不同容器，无需关心内部实现。


