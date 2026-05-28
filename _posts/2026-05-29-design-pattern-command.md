---
title: "设计模式详解：命令模式（Command）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 命令模式
 核心思想: 将请求封装为对象，从而让你可以用不同的请求对客户进行参数化、对请求排队或记录请求日志，以及支持撤销操作。

  命令模式将"请求"变成一个对象，解耦请求发送者和接收者。

---
  现实比喻

  餐厅点餐：

  ┌─────────────────────────────────────────────────────────────┐
  │                        餐厅场景                              │
  ├─────────────────────────────────────────────────────────────┤
  │                                                             │
  │   顾客 ──────→ 服务员 ──────→ 订单 ──────→ 厨师            │
  │                        │                        │           │
  │                        │                        │           │
  │                    (调用者)    (命令对象)    (接收者)        │
  │                                                             │
  │   顾客不直接找厨师，而是通过服务员递交订单                    │
  │   服务员不知道怎么做菜，只负责传递订单                       │
  │   订单记录了要做什么菜                                       │
  │   厨师根据订单做菜                                           │
  │                                                             │
  │   订单可以：排队、撤销、记录日志                              │
  └─────────────────────────────────────────────────────────────┘

---
  四个核心角色

  ┌────────────────┐
  │    Command     │  ← 命令接口：声明执行方法
  └────────────────┘
          △
          │
  ┌───────┴───────┐
  │ConcreteCommand│  ← 具体命令：绑定接收者，实现执行
  └───────────────┘
          │
          │ 持有
          ▼
  ┌────────────────┐
  │    Receiver    │  ← 接收者：实际执行工作的对象
  └────────────────┘

  ┌────────────────┐
  │    Invoker     │  ← 调用者：持有命令，调用执行
  └────────────────┘

---
  代码示例：智能家居遥控器
```cpp
  #include <iostream>
  #include <memory>
  #include <vector>
  #include <stack>
  #include <string>

  // 接收者：电灯
  class Light {
      std::string m_location;
      bool m_on = false;

  public:
      Light(const std::string& location) : m_location(location) {}

      void on() {
          m_on = true;
          std::cout << "💡 " << m_location << " 的灯已打开" << std::endl;
      }

      void off() {
          m_on = false;
          std::cout << "⚫ " << m_location << " 的灯已关闭" << std::endl;
      }

      bool isOn() const { return m_on; }
  };

  // 接收者：空调
  class AirConditioner {
      int m_temperature = 26;

  public:
      void setTemperature(int temp) {
          m_temperature = temp;
          std::cout << "❄️ 空调温度设置为 " << temp << "°C" << std::endl;
      }

      void off() {
          std::cout << "❄️ 空调已关闭" << std::endl;
      }

      int getTemperature() const { return m_temperature; }
  };

  // 命令接口
  class Command {
  public:
      virtual ~Command() = default;
      virtual void execute() = 0;
      virtual void undo() = 0;
      virtual std::string getDescription() const = 0;
  };

  // 具体命令：开灯
  class LightOnCommand : public Command {
      Light* m_light;

  public:
      LightOnCommand(Light* light) : m_light(light) {}

      void execute() override { m_light->on(); }
      void undo() override { m_light->off(); }
      std::string getDescription() const override { return "开灯"; }
  };

  // 具体命令：关灯
  class LightOffCommand : public Command {
      Light* m_light;

  public:
      LightOffCommand(Light* light) : m_light(light) {}

      void execute() override { m_light->off(); }
      void undo() override { m_light->on(); }
      std::string getDescription() const override { return "关灯"; }
  };

  // 具体命令：设置空调温度
  class SetTemperatureCommand : public Command {
      AirConditioner* m_ac;
      int m_newTemp;
      int m_oldTemp;

  public:
      SetTemperatureCommand(AirConditioner* ac, int temp)
          : m_ac(ac), m_newTemp(temp), m_oldTemp(ac->getTemperature()) {}

      void execute() override {
          m_oldTemp = m_ac->getTemperature();
          m_ac->setTemperature(m_newTemp);
      }

      void undo() override {
          m_ac->setTemperature(m_oldTemp);
      }

      std::string getDescription() const override {
          return "设置空调温度 " + std::to_string(m_newTemp) + "°C";
      }
  };

  // 空命令（用于初始化）
  class NoCommand : public Command {
  public:
      void execute() override {}
      void undo() override {}
      std::string getDescription() const override { return "无操作"; }
  };

  // 调用者：遥控器
  class RemoteControl {
      std::vector<std::unique_ptr<Command>> m_onCommands;
      std::vector<std::unique_ptr<Command>> m_offCommands;
      std::stack<Command*> m_undoStack;  // 撤销栈
      int m_slotCount;

  public:
      RemoteControl(int slots = 3) : m_slotCount(slots) {
          // 初始化为空命令
          for (int i = 0; i < slots; ++i) {
              m_onCommands.push_back(std::make_unique<NoCommand>());
              m_offCommands.push_back(std::make_unique<NoCommand>());
          }
      }

      void setCommand(int slot, std::unique_ptr<Command> onCmd, std::unique_ptr<Command> offCmd) {
          m_onCommands[slot] = std::move(onCmd);
          m_offCommands[slot] = std::move(offCmd);
      }

      void onButtonPressed(int slot) {
          std::cout << "\n[按下按钮 " << slot << " - 开]" << std::endl;
          m_onCommands[slot]->execute();
          m_undoStack.push(m_onCommands[slot].get());
      }

      void offButtonPressed(int slot) {
          std::cout << "\n[按下按钮 " << slot << " - 关]" << std::endl;
          m_offCommands[slot]->execute();
          m_undoStack.push(m_offCommands[slot].get());
      }

      void undoButtonPressed() {
          std::cout << "\n[按下撤销按钮]" << std::endl;
          if (!m_undoStack.empty()) {
              m_undoStack.top()->undo();
              m_undoStack.pop();
          } else {
              std::cout << "没有可撤销的操作" << std::endl;
          }
      }

      void showStatus() const {
          std::cout << "\n=== 遥控器状态 ===" << std::endl;
          for (int i = 0; i < m_slotCount; ++i) {
              std::cout << "按钮" << i << ": "
                        << m_onCommands[i]->getDescription() << " / "
                        << m_offCommands[i]->getDescription() << std::endl;
          }
          std::cout << "==================" << std::endl;
      }
  };

  // 使用
  int main() {
      RemoteControl remote(3);

      // 创建设备
      Light livingRoomLight("客厅");
      Light bedroomLight("卧室");
      AirConditioner ac;

      // 设置命令
      remote.setCommand(0,
          std::make_unique<LightOnCommand>(&livingRoomLight),
          std::make_unique<LightOffCommand>(&livingRoomLight));

      remote.setCommand(1,
          std::make_unique<LightOnCommand>(&bedroomLight),
          std::make_unique<LightOffCommand>(&bedroomLight));

      remote.setCommand(2,
          std::make_unique<SetTemperatureCommand>(&ac, 22),
          std::make_unique<SetTemperatureCommand>(&ac, 26));

      remote.showStatus();

      // 操作
      remote.onButtonPressed(0);  // 开客厅灯
      remote.onButtonPressed(1);  // 开卧室灯
      remote.onButtonPressed(2);  // 设置空调22度

      remote.undoButtonPressed();  // 撤销：空调恢复26度
      remote.undoButtonPressed();  // 撤销：关卧室灯

      remote.offButtonPressed(0);  // 关客厅灯

      return 0;
  }
```
  输出：
  ```shell
  === 遥控器状态 ===
  按钮0: 开灯 / 关灯
  按钮1: 开灯 / 关灯
  按钮2: 设置空调温度 22°C / 设置空调温度 26°C
  ==================

  [按下按钮 0 - 开]
  💡 客厅 的灯已打开

  [按下按钮 1 - 开]
  💡 卧室 的灯已打开

  [按下按钮 2 - 开]
  ❄️ 空调温度设置为 22°C

  [按下撤销按钮]
  ❄️ 空调温度设置为 26°C

  [按下撤销按钮]
  ⚫ 卧室 的灯已关闭

  [按下按钮 0 - 关]
  ⚫ 客厅 的灯已关闭
  ```
---
  结构示意图

  ┌─────────────────────────────────────────────────────────────┐
  │                        Client                               │
  │    创建具体命令，设置接收者，将命令交给调用者                  │
  └─────────────────────────────────────────────────────────────┘
          │
          │ 配置
          ▼
  ┌───────────────────┐              ┌───────────────────┐
  │     Invoker       │              │   <<interface>>   │
  │    (调用者)        │──────────────│     Command       │
  │───────────────────│   持有命令    │───────────────────│
  │ - commands[]      │              │ + execute()       │
  │ + setCommand()    │              │ + undo()          │
  │ + executeCommand()│              └───────────────────┘
  └───────────────────┘                       △
                                              │
                                 ┌────────────┴────────────┐
                                 │                         │
                        ┌────────┴────────┐       ┌────────┴────────┐
                        │ ConcreteCommand │       │ ConcreteCommand │
                        │─────────────────│       │─────────────────│
                        │ - receiver      │       │ - receiver      │
                        │ + execute()     │       │ + execute()     │
                        │ + undo()        │       │ + undo()        │
                        └────────┬────────┘       └────────┬────────┘
                                 │                         │
                                 │ 持有                     │ 持有
                                 ▼                         ▼
                        ┌────────────────┐       ┌────────────────┐
                        │    Receiver    │       │    Receiver    │
                        │────────────────│       │────────────────│
                        │ + action()     │       │ + action()     │
                        └────────────────┘       └────────────────┘

---
  宏命令（组合命令）
```cpp
  #include <vector>

  // 宏命令：一次执行多个命令
  class MacroCommand : public Command {
      std::vector<std::unique_ptr<Command>> m_commands;
      std::string m_name;

  public:
      MacroCommand(const std::string& name) : m_name(name) {}

      void addCommand(std::unique_ptr<Command> cmd) {
          m_commands.push_back(std::move(cmd));
      }

      void execute() override {
          std::cout << "📦 执行宏命令: " << m_name << std::endl;
          for (auto& cmd : m_commands) {
              cmd->execute();
          }
      }

      void undo() override {
          std::cout << "📦 撤销宏命令: " << m_name << std::endl;
          // 逆序撤销
          for (auto it = m_commands.rbegin(); it != m_commands.rend(); ++it) {
              (*it)->undo();
          }
      }

      std::string getDescription() const override {
          return "宏命令: " + m_name;
      }
  };

  // 使用
  int main() {
      Light livingLight("客厅");
      Light bedroomLight("卧室");
      AirConditioner ac;

      // 创建"回家模式"宏命令
      auto partyMode = std::make_unique<MacroCommand>("回家模式");
      partyMode->addCommand(std::make_unique<LightOnCommand>(&livingLight));
      partyMode->addCommand(std::make_unique<LightOnCommand>(&bedroomLight));
      partyMode->addCommand(std::make_unique<SetTemperatureCommand>(&ac, 24));

      std::cout << "=== 执行回家模式 ===" << std::endl;
      partyMode->execute();

      std::cout << "\n=== 撤销回家模式 ===" << std::endl;
      partyMode->undo();

      return 0;
  }
```
  输出：
  ```shell
  === 执行回家模式 ===
  📦 执行宏命令: 回家模式
  💡 客厅 的灯已打开
  💡 卧室 的灯已打开
  ❄️ 空调温度设置为 24°C

  === 撤销回家模式 ===
  📦 撤销宏命令: 回家模式
  ❄️ 空调温度设置为 26°C
  ⚫ 卧室 的灯已关闭
  ⚫ 客厅 的灯已关闭
  ```
---
  命令队列与日志
```cpp
  #include <queue>
  #include <fstream>

  // 命令队列（支持异步执行、批处理）
  class CommandQueue {
      std::queue<std::unique_ptr<Command>> m_queue;

  public:
      void addCommand(std::unique_ptr<Command> cmd) {
          m_queue.push(std::move(cmd));
      }

      void executeAll() {
          while (!m_queue.empty()) {
              m_queue.front()->execute();
              m_queue.pop();
          }
      }

      size_t size() const { return m_queue.size(); }
  };

  // 命令日志（持久化）
  class CommandLogger {
      std::ofstream m_logFile;

  public:
      CommandLogger(const std::string& filename)
          : m_logFile(filename, std::ios::app) {}

      void logCommand(const Command& cmd) {
          m_logFile << cmd.getDescription() << std::endl;
      }
  };
```
---
  与其他模式对比

  ┌────────────────────────────────────────────────────────────────┐
  │                    命令模式 vs 其他模式                         │
  ├──────────────────┬─────────────────────────────────────────────┤
  │     命令模式      │ 封装"请求"为对象，支持撤销、队列            │
  ├──────────────────┼─────────────────────────────────────────────┤
  │     策略模式      │ 封装"算法"为对象，运行时切换算法            │
  ├──────────────────┼─────────────────────────────────────────────┤
  │     状态模式      │ 封装"状态"为对象，状态决定行为              │
  ├──────────────────┼─────────────────────────────────────────────┤
  │     责任链模式    │ 多个处理器依次处理请求                      │
  └──────────────────┴─────────────────────────────────────────────┘

  命令模式关注：请求本身（做什么）
  策略模式关注：算法实现（怎么做）

---
  适用场景

  ┌───────────┬──────────────────────┐
  │   场景    │         说明         │
  ├───────────┼──────────────────────┤
  │ 撤销/重做 │ 编辑器、IDE 操作     │
  ├───────────┼──────────────────────┤
  │ 宏命令    │ 批量执行一系列操作   │
  ├───────────┼──────────────────────┤
  │ 任务队列  │ 异步执行、延迟执行   │
  ├───────────┼──────────────────────┤
  │ 日志记录  │ 事务日志、操作审计   │
  ├───────────┼──────────────────────┤
  │ GUI 按钮  │ 按钮点击执行不同命令 │
  └───────────┴──────────────────────┘

---
  优缺点

  优点：
  - 解耦请求发送者和接收者
  - 支持撤销和重做
  - 支持命令队列和日志
  - 易于添加新命令

  缺点：
  - 命令多时类数量增加
  - 简单操作显得过度设计

---
  总结：命令模式将请求封装成对象，让请求可以被存储、传递、撤销。核心价值是解耦调用者和执行者，让"做什么"和"谁来做"分离。


