---
title: "设计模式详解：策略模式（Strategy）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 策略模式
核心思想: 定义一系列算法，把它们封装起来，并使它们可以互相替换。策略模式让算法独立于使用它的客户端而变化。

  现实比喻

  出行方式选择：

  目的地: 机场
```
  ┌─────────────────────────────────────┐
  │  出行策略                            │
  │  ┌─────────┐ ┌─────────┐ ┌────────┐│
  │  │ 坐地铁  │ │ 打车    │ │ 开车   ││
  │  │ 便宜    │ │ 方便    │ │ 灵活   ││
  │  │ 1小时   │ │ 40分钟  │ │ 30分钟 ││
  │  └─────────┘ └─────────┘ └────────┘│
  │                                     │
  │  → 根据时间/预算/心情选择不同策略     │
  └─────────────────────────────────────┘
```

  目的地不变，但出行方式（策略）可以随时切换。

---
  代码示例
```cpp
  // 策略接口
  class SortStrategy {
  public:
      virtual ~SortStrategy() = default;
      virtual void sort(std::vector<int>& data) = 0;
      virtual std::string name() const = 0;
  };

  // 具体策略A：快速排序
  class QuickSort : public SortStrategy {
  public:
      void sort(std::vector<int>& data) override {
          std::cout << "使用快速排序..." << std::endl;
          std::sort(data.begin(), data.end());
      }

      std::string name() const override { return "快速排序"; }
  };

  // 具体策略B：冒泡排序
  class BubbleSort : public SortStrategy {
  public:
      void sort(std::vector<int>& data) override {
          std::cout << "使用冒泡排序..." << std::endl;
          for (size_t i = 0; i < data.size(); ++i) {
              for (size_t j = 0; j < data.size() - i - 1; ++j) {
                  if (data[j] > data[j + 1]) {
                      std::swap(data[j], data[j + 1]);
                  }
              }
          }
      }

      std::string name() const override { return "冒泡排序"; }
  };

  // 具体策略C：STL排序
  class StdSort : public SortStrategy {
  public:
      void sort(std::vector<int>& data) override {
          std::cout << "使用STL排序..." << std::endl;
          std::sort(data.begin(), data.end());
      }

      std::string name() const override { return "STL排序"; }
  };

  // 上下文：使用策略的类
  class Sorter {
      std::unique_ptr<SortStrategy> m_strategy;
      std::vector<int> m_data;

  public:
      Sorter(std::vector<int> data) : m_data(std::move(data)) {}

      // 运行时切换策略
      void setStrategy(std::unique_ptr<SortStrategy> strategy) {
          m_strategy = std::move(strategy);
      }

      void doSort() {
          if (m_strategy) {
              std::cout << "当前策略: " << m_strategy->name() << std::endl;
              m_strategy->sort(m_data);
          }
      }

      void printData() const {
          for (int n : m_data) std::cout << n << " ";
          std::cout << std::endl;
      }
  };

  // 使用
  int main() {
      std::vector<int> data{5, 2, 8, 1, 9, 3};
      Sorter sorter(data);

      // 策略1：快速排序
      sorter.setStrategy(std::make_unique<QuickSort>());
      sorter.doSort();
      sorter.printData();

      // 策略2：冒泡排序（运行时切换）
      sorter.setStrategy(std::make_unique<BubbleSort>());
      sorter.doSort();

      // 策略3：根据条件选择
      size_t size = data.size();
      if (size < 10) {
          sorter.setStrategy(std::make_unique<BubbleSort>());
      } else {
          sorter.setStrategy(std::make_unique<QuickSort>());
      }
      sorter.doSort();
  }
```
---
  更实用的例子：支付系统
```cpp

  // 支付策略接口
  class PaymentStrategy {
  public:
      virtual ~PaymentStrategy() = default;
      virtual void pay(double amount) = 0;
  };

  // 具体策略
  class AlipayPayment : public PaymentStrategy {
  public:
      void pay(double amount) override {
          std::cout << "支付宝支付: " << amount << " 元" << std::endl;
      }
  };

  class WechatPayment : public PaymentStrategy {
  public:
      void pay(double amount) override {
          std::cout << "微信支付: " << amount << " 元" << std::endl;
      }
  };

  class CreditCardPayment : public PaymentStrategy {
      std::string m_cardNumber;
  public:
      CreditCardPayment(const std::string& card) : m_cardNumber(card) {}

      void pay(double amount) override {
          std::cout << "信用卡(" << m_cardNumber << ")支付: " << amount << " 元" << std::endl;
      }
  };

  // 购物车
  class ShoppingCart {
      std::vector<std::pair<std::string, double>> m_items;

  public:
      void addItem(const std::string& name, double price) {
          m_items.emplace_back(name, price);
      }

      double getTotal() const {
          double total = 0;
          for (const auto& item : m_items) {
              total += item.second;
          }
          return total;
      }

      void checkout(PaymentStrategy& payment) {
          double amount = getTotal();
          payment.pay(amount);
      }
  };

  // 使用
  int main() {
      ShoppingCart cart;
      cart.addItem("手机", 2999);
      cart.addItem("耳机", 199);

      // 用户选择支付方式
      int choice = 1;  // 假设用户选择支付宝

      if (choice == 1) {
          AlipayPayment alipay;
          cart.checkout(alipay);
      } else if (choice == 2) {
          WechatPayment wechat;
          cart.checkout(wechat);
      } else {
          CreditCardPayment creditCard("6222****1234");
          cart.checkout(creditCard);
      }
  }
```

---
  结构示意图

```
          ┌─────────────────┐
          │    Context      │
          │  (Sorter)       │
          │  ─────────────  │
          │  - strategy     │──────────┐
          │  + setStrategy()│          │
          │  + doSort()     │          ▼
          └─────────────────┘   ┌──────────────┐
                                │ <<interface>>│
                                │  Strategy    │
                                │──────────────│
                                │ + sort()     │
                                └──────────────┘
                                       △
                     ┌─────────────────┼─────────────────┐
                     │                 │                 │
              ┌──────┴──────┐   ┌──────┴──────┐   ┌──────┴──────┐
              │ QuickSort   │   │ BubbleSort  │   │ StdSort     │
              │─────────────│   │─────────────│   │─────────────│
              │ + sort()    │   │ + sort()    │   │ + sort()    │
              └─────────────┘   └─────────────┘   └─────────────┘
```

---
  与模板方法模式对比

```
  ┌────────────────────────────────────────────────────────────┐
  │                      模板方法 vs 策略                       │
  ├────────────────────┬───────────────────────────────────────┤
  │     模板方法        │              策略模式                  │
  ├────────────────────┼───────────────────────────────────────┤
  │ 继承关系            │ 组合关系                              │
  │ 父类控制流程        │ 客户端选择策略                        │
  │ 算法骨架固定        │ 整个算法可替换                        │
  │ 编译时确定          │ 运行时切换                            │
  │ "怎么做我说了算"    │ "你选哪个我不管"                      │
  └────────────────────┴───────────────────────────────────────┘
```

  模板方法: 父类 ────继承────> 子类A、子类B
  策略模式:  Context ─组合─> Strategy <──实现── 具体策略A、B、C

---
  适用场景

```
  ┌──────────────────────┬──────────────────────┐
  │         场景         │         示例         │
  ├──────────────────────┼──────────────────────┤
  │ 多种方式完成同一任务 │ 排序、压缩、加密算法 │
  ├──────────────────────┼──────────────────────┤
  │ 需要运行时切换行为   │ 支付方式、出行方式   │
  ├──────────────────────┼──────────────────────┤
  │ 避免大量条件语句     │ 替代 if-else 分支    │
  ├──────────────────────┼──────────────────────┤
  │ 算法独立于客户端     │ 策略变化不影响使用方 │
  └──────────────────────┴──────────────────────┘
```

---
  消除 if-else 示例
```cpp
  //改造前：
  void process(const std::string& type, int data) {
      if (type == "A") {
          // 处理A
      } else if (type == "B") {
          // 处理B
      } else if (type == "C") {
          // 处理C
      }
  }

  //改造后：
  // 策略工厂
  class StrategyFactory {
      static std::map<std::string, std::function<std::unique_ptr<Strategy>()>> s_creators;
  public:
      static void registerStrategy(const std::string& type,
                                    std::function<std::unique_ptr<Strategy>()> creator) {
          s_creators[type] = creator;
      }

      static std::unique_ptr<Strategy> create(const std::string& type) {
          return s_creators[type]();
      }
  };

  void process(const std::string& type, int data) {
      auto strategy = StrategyFactory::create(type);
      strategy->execute(data);
  }
```
---
  优缺点

  优点：
  - 算法可自由切换
  - 避免多层条件语句
  - 易于扩展新策略（符合开闭原则）

  缺点：
  - 客户端必须知道所有策略
  - 策略过多时类数量增加

---
  总结：策略模式本质是用组合替代继承，将变化的部分抽象出来，使系统更灵活。


