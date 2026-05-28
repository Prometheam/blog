---
title: "设计模式详解：状态模式（State）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 状态模式
核心思想: 允许对象在其内部状态改变时改变其行为，对象看起来好像修改了它的类。状态模式将状态封装成独立的类，并将行为委托给当前状态对象。

---
  现实比喻

  自动售货机：
```

                      ┌──────────────────┐
                      │   自动售货机      │
                      └──────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
     ┌───────────┐     ┌───────────┐      ┌───────────┐
     │  空闲状态  │────→│  投币状态  │─────→│  售货状态  │
     │           │     │           │      │           │
     │ 投币→等待  │     │ 选货→出货 │       │ 出货→空闲 │
     └───────────┘     └───────────┘      └───────────┘
                              │
                              ▼
                       ┌───────────┐
                       │  缺货状态  │
                       │           │
                       │ 亮红灯提示 │
                       └───────────┘
```

  同一操作（如"投币"）在不同状态下行为不同

---
  代码示例
```cpp

  #include <iostream>
  #include <memory>

  // 前向声明
  class VendingMachine;

  // 状态接口
  class State {
  public:
      virtual ~State() = default;

      virtual void insertCoin(VendingMachine& machine) = 0;
      virtual void selectItem(VendingMachine& machine) = 0;
      virtual void dispense(VendingMachine& machine) = 0;
      virtual std::string name() const = 0;
  };

  // 上下文：售货机
  class VendingMachine {
      std::unique_ptr<State> m_state;
      int m_count = 2;  // 商品数量

  public:
      VendingMachine();

      void setState(std::unique_ptr<State> state) {
          m_state = std::move(state);
      }

      void insertCoin() {
          std::cout << "[操作] 投币" << std::endl;
          m_state->insertCoin(*this);
      }

      void selectItem() {
          std::cout << "[操作] 选择商品" << std::endl;
          m_state->selectItem(*this);
      }

      void dispense() {
          std::cout << "[操作] 出货" << std::endl;
          m_state->dispense(*this);
      }

      int getCount() const { return m_count; }
      void releaseItem() { --m_count; }

      std::string getStateName() const { return m_state->name(); }
  };

  // 具体状态：空闲（无币）
  class IdleState : public State {
  public:
      std::string name() const override { return "空闲状态"; }

      void insertCoin(VendingMachine& machine) override {
          std::cout << "  → 投币成功，等待选择商品" << std::endl;
          machine.setState(std::make_unique<HasCoinState>());
      }

      void selectItem(VendingMachine&) override {
          std::cout << "  → 请先投币！" << std::endl;
      }

      void dispense(VendingMachine&) override {
          std::cout << "  → 请先投币选购！" << std::endl;
      }
  };

  // 具体状态：已投币
  class HasCoinState : public State {
  public:
      std::string name() const override { return "已投币状态"; }

      void insertCoin(VendingMachine&) override {
          std::cout << "  → 已投币，请勿重复投币" << std::endl;
      }

      void selectItem(VendingMachine& machine) override {
          std::cout << "  → 商品已选中，准备出货" << std::endl;
          machine.setState(std::make_unique<SoldState>());
      }

      void dispense(VendingMachine&) override {
          std::cout << "  → 请先选择商品" << std::endl;
      }
  };

  // 具体状态：售出
  class SoldState : public State {
  public:
      std::string name() const override { return "出货状态"; }

      void insertCoin(VendingMachine&) override {
          std::cout << "  → 正在出货，请稍候" << std::endl;
      }

      void selectItem(VendingMachine&) override {
          std::cout << "  → 正在出货，请稍候" << std::endl;
      }

      void dispense(VendingMachine& machine) override {
          machine.releaseItem();
          std::cout << "  → 商品已出货！剩余: " << machine.getCount() << std::endl;

          if (machine.getCount() > 0) {
              machine.setState(std::make_unique<IdleState>());
          } else {
              std::cout << "  → 商品售罄！" << std::endl;
              machine.setState(std::make_unique<SoldOutState>());
          }
      }
  };

  // 具体状态：售罄
  class SoldOutState : public State {
  public:
      std::string name() const override { return "售罄状态"; }

      void insertCoin(VendingMachine&) override {
          std::cout << "  → 商品已售罄，无法购买" << std::endl;
      }

      void selectItem(VendingMachine&) override {
          std::cout << "  → 商品已售罄" << std::endl;
      }

      void dispense(VendingMachine&) override {
          std::cout << "  → 商品已售罄" << std::endl;
      }
  };

  // 构造函数（放在状态类定义之后）
  VendingMachine::VendingMachine()
      : m_state(std::make_unique<IdleState>()) {}

  // 使用
  int main() {
      VendingMachine machine;

      std::cout << "当前状态: " << machine.getStateName() << "\n" << std::endl;

      // 正常流程
      machine.insertCoin();
      std::cout << "状态 → " << machine.getStateName() << "\n" << std::endl;

      machine.selectItem();
      std::cout << "状态 → " << machine.getStateName() << "\n" << std::endl;

      machine.dispense();
      std::cout << "状态 → " << machine.getStateName() << "\n" << std::endl;

      // 再次购买
      machine.insertCoin();
      machine.selectItem();
      machine.dispense();

      std::cout << "\n状态 → " << machine.getStateName() << std::endl;
      machine.insertCoin();  // 售罄，拒绝投币
  }
```
```shell
  输出：
  当前状态: 空闲状态

  [操作] 投币
    → 投币成功，等待选择商品
  状态 → 已投币状态

  [操作] 选择商品
    → 商品已选中，准备出货
  状态 → 出货状态

  [操作] 出货
    → 商品已出货！剩余: 1
  状态 → 空闲状态

  ...（第二次购买后）
  状态 → 售罄状态

  [操作] 投币
    → 商品已售罄，无法购买
```
---
  结构示意图

```
  ┌─────────────────────────┐
  │      Context            │
  │    (VendingMachine)     │
  │  ─────────────────────  │
  │  - state: State         │──────────────┐
  │  + setState()           │              │
  │  + insertCoin() ────────│───委托───────│─┐
  │  + selectItem() ────────│───委托───────│─┤
  │  + dispense() ──────────│───委托───────│─┤
  └─────────────────────────┘              │ │
                                           │ │
                                           ▼ ▼
                                ┌────────────────────┐
                                │   <<interface>>    │
                                │      State         │
                                │────────────────────│
                                │ + insertCoin()     │
                                │ + selectItem()     │
                                │ + dispense()       │
                                └────────────────────┘
                                           △
                ┌────────────┬─────────────┼─────────────┐
                │            │             │             │
         ┌──────┴─────┐ ┌────┴────┐ ┌──────┴─────┐ ┌─────┴──────┐
         │ IdleState  │ │HasCoin  │ │ SoldState  │ │SoldOutState│
         │────────────│ │ State   │ │────────────│ │────────────│
         │insertCoin()│ │─────────│ │insertCoin()│ │insertCoin()│
         │selectItem()│ │...      │ │selectItem()│ │selectItem()│
         │dispense()  │ │         │ │dispense()  │ │dispense()  │
         └────────────┘ └─────────┘ └────────────┘ └────────────┘
                │                              │
                │      状态转换                │
                └──────────────────────────────┘
```

---
  与策略模式对比

  很多人容易混淆这两个模式：
```

  ┌───────────────────────────────────────────────────────────────┐
  │                    状态模式 vs 策略模式                         │
  ├────────────────────────┬──────────────────────────────────────┤
  │       状态模式          │             策略模式                  │
  ├────────────────────────┼──────────────────────────────────────┤
  │ 状态对象知道彼此        │ 策略之间互不知道                      │
  │ 状态自动切换            │ 客户端主动切换策略                    │
  │ "我该变成什么状态"      │ "给我换个算法"                        │
  │ 状态决定行为            │ 算法决定行为                          │
  │ 状态有限且固定          │ 策略可以无限扩展                      │
  └────────────────────────┴──────────────────────────────────────┘
```

  状态模式：状态A ──自己切换──→ 状态B ──自己切换──→ 状态C
  策略模式：Context ←──客户端选择──→ 策略A / 策略B / 策略C

---
  实际应用：TCP 连接状态
```cpp
  class TcpState {
  public:
      virtual ~TcpState() = default;
      virtual void open(TcpConnection& conn) = 0;
      virtual void close(TcpConnection& conn) = 0;
      virtual void send(TcpConnection& conn, const std::string& data) = 0;
  };

  class TcpConnection {
      std::unique_ptr<TcpState> m_state;
  public:
      // 状态转换由状态类内部决定
      void open()  { m_state->open(*this); }
      void close() { m_state->close(*this); }
      void send(const std::string& data) { m_state->send(*this, data); }
  };

  // 各状态行为不同
  class ClosedState : public TcpState {
      void open(TcpConnection& conn) override {
          // 发送SYN，转为 SYN_SENT
          conn.setState(std::make_unique<SynSentState>());
      }
      void close(TcpConnection&) override { /* 忽略 */ }
      void send(TcpConnection&, const std::string&) override { /* 错误 */ }
  };

  class EstablishedState : public TcpState {
      void open(TcpConnection&) override { /* 已连接 */ }
      void close(TcpConnection& conn) override {
          // 发送FIN，转为 FIN_WAIT
          conn.setState(std::make_unique<FinWaitState>());
      }
      void send(TcpConnection&, const std::string& data) override {
          // 正常发送数据
      }
  };

  ---
  消除大量 if-else

  改造前：
  ```cpp
  void handle(int state, int event) {
      if (state == IDLE) {
          if (event == COIN) {
              // ...
              state = HAS_COIN;
          } else if (event == SELECT) {
              // ...
          }
      } else if (state == HAS_COIN) {
          if (event == COIN) {
              // ...
          } else if (event == SELECT) {
              // ...
              state = SOLD;
          }
      } else if (state == SOLD) {
          // ...
      }
      // 大量嵌套条件...
  }
```

  改造后：每个状态是一个类，行为封装在状态类中，状态转换自然发生。

---
  适用场景

```
  ┌──────────────────────┬──────────────────────┐
  │         场景         │         示例         │
  ├──────────────────────┼──────────────────────┤
  │ 对象行为取决于状态   │ 订单状态、TCP连接    │
  ├──────────────────────┼──────────────────────┤
  │ 大量条件分支判断状态 │ 用状态类替代 if-else │
  ├──────────────────────┼──────────────────────┤
  │ 状态转换规则复杂     │ 游戏角色状态、工作流 │
  └──────────────────────┴──────────────────────┘
```

---
  优缺点

  优点：
  - 状态转换逻辑清晰，每个状态独立封装
  - 消除大量条件语句
  - 易于添加新状态

  缺点：
  - 状态多时类数量增加
  - 状态类之间有依赖（需要知道其他状态）

---
  总结：状态模式将状态和行为绑定，让对象在不同状态下表现出不同行为，状态转换由状态对象自己控制。


