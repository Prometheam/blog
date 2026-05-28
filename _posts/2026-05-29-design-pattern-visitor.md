---
title: "设计模式详解：访问者模式（Visitor）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 访问者模式
核心思想: 将数据结构与作用于结构上的操作分离，使得可以在不修改数据结构的前提下，定义新的操作。

---
  现实比喻

  想象一个超市购物场景：
  - 数据结构 = 商品（水果、电器、服装）
  - 访问者 = 收银员、库存管理员、促销员

  商品本身不知道怎么被处理，而是"接受"不同的人来处理自己：
  - 收银员 → 计算价格
  - 库存管理员 → 统计数量
  - 促销员 → 生成折扣信息

---
  代码示例

  ```cpp
  // 前向声明
  class Apple;
  class Book;
  class Computer;

  // 访问者接口
  class Visitor {
  public:
      virtual ~Visitor() = default;
      virtual void visit(Apple& apple) = 0;
      virtual void visit(Book& book) = 0;
      virtual void visit(Computer& computer) = 0;
  };

  // 元素基类
  class Item {
  public:
      virtual ~Item() = default;
      virtual void accept(Visitor& visitor) = 0;
      virtual double getPrice() const = 0;
  };

  // 具体元素
  class Apple : public Item {
      double m_price = 5.0;
  public:
      void accept(Visitor& visitor) override { visitor.visit(*this); }
      double getPrice() const override { return m_price; }
  };

  class Book : public Item {
      double m_price = 30.0;
  public:
      void accept(Visitor& visitor) override { visitor.visit(*this); }
      double getPrice() const override { return m_price; }
  };

  class Computer : public Item {
      double m_price = 5000.0;
  public:
      void accept(Visitor& visitor) override { visitor.visit(*this); }
      double getPrice() const override { return m_price; }
  };

  // 具体访问者1：购物车（计算总价）
  class ShoppingCartVisitor : public Visitor {
      double m_total = 0;
  public:
      void visit(Apple& item) override { m_total += item.getPrice(); }
      void visit(Book& item) override { m_total += item.getPrice(); }
      void visit(Computer& item) override { m_total += item.getPrice(); }
      double getTotal() const { return m_total; }
  };

  // 具体访问者2：折扣计算（不同商品不同折扣）
  class DiscountVisitor : public Visitor {
      double m_discount = 0;
  public:
      void visit(Apple&) override { m_discount += 0; }        // 水果无折扣
      void visit(Book&) override { m_discount += 3.0; }       // 书籍减3元
      void visit(Computer&) override { m_discount += 200.0; } // 电脑减200元
      double getDiscount() const { return m_discount; }
  };

  // 使用
  int main() {
      std::vector<std::unique_ptr<Item>> items;
      items.push_back(std::make_unique<Apple>());
      items.push_back(std::make_unique<Book>());
      items.push_back(std::make_unique<Computer>());

      ShoppingCartVisitor cart;
      DiscountVisitor discount;

      for (auto& item : items) {
          item->accept(cart);      // 计算总价
          item->accept(discount);  // 计算折扣
      }

      std::cout << "总价: " << cart.getTotal() << std::endl;
      std::cout << "折扣: " << discount.getDiscount() << std::endl;
  }
  ```

---
  关键机制：双分派

  item->accept(visitor)  →  visitor.visit(*this)
       ↓                              ↓
     虚函数分发              再次虚函数分发

  两次虚函数调用确定了：
  1. 元素的具体类型
  2. 访问者的具体类型

  这就是为什么 visit() 可以针对不同元素类型做不同处理。

---
  适用场景

```
  ┌───────────────┬────────────────────────────────┐
  │     场景      │              说明              │
  ├───────────────┼────────────────────────────────┤
  │ 数据结构稳定  │ 元素类型很少变化               │
  ├───────────────┼────────────────────────────────┤
  │ 操作频繁变化  │ 经常需要新增不同的处理方式     │
  ├───────────────┼────────────────────────────────┤
  │ 编译器/解释器 │ AST 节点（语法树）+ 不同分析器 │
  ├───────────────┼────────────────────────────────┤
  │ 文档处理      │ 不同格式导出（PDF/HTML/Word）  │
  └───────────────┴────────────────────────────────┘
```

---
  优缺点

  优点：
  - 新增操作只需添加新访问者，无需修改数据结构
  - 相关操作集中在一个访问者类中，便于维护

  缺点：
  - 新增元素类型困难（所有访问者都要改）
  - 破坏了封装（访问者需要访问元素内部）

---
  与其他模式对比

```
  ┌──────────┬──────────────────────────────────────────────────┐
  │   模式   │                     核心区别                     │
  ├──────────┼──────────────────────────────────────────────────┤
  │ 策略模式 │ 操作对象自身的某个行为，而访问者操作整个数据结构 │
  ├──────────┼──────────────────────────────────────────────────┤
  │ 命令模式 │ 封装单个请求，访问者是批量处理结构中所有元素     │
  └──────────┴──────────────────────────────────────────────────┘
```

  简单来说：数据结构稳定、操作多变 → 用访问者模式。
