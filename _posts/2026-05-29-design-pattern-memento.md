---
title: "设计模式详解：备忘录模式（Memento）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 备忘录模式
 核心思想: 在不破坏封装的前提下，捕获对象的内部状态，并在对象之外保存这个状态，以便后续将对象恢复到原先保存的状态。

---
  现实比喻

  游戏存档：
```
  ┌─────────────────────────────────────────────────────────┐
  │                     游戏进度                             │
  ├─────────────────────────────────────────────────────────┤
  │  存档1 - 第3关  血量:100  金币:500                       │
  │  存档2 - 第5关  血量:60   金币:1200                      │
  │  存档3 - 第8关  血量:80   金币:3000                      │
  └─────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌───────────────────────────┐
              │  玩家选择"读取存档2"        │
              │  → 恢复到第5关的状态        │
              └───────────────────────────┘

  游戏角色不知道存档怎么存储
  存档不知道游戏角色的其他逻辑
  双方解耦，通过备忘录中转
```

---
  三个核心角色

```
  ┌────────────────┐     ┌────────────────┐     ┌────────────────┐
  │   Originator   │     │    Memento     │     │   Caretaker    │
  │   (发起人)      │────→│   (备忘录)      │←────│   (管理者)      │
  │                │     │                │     │                │
  │ 创建/恢复备忘录 │     │ 存储内部状态    │     │ 保存备忘录      │
  │ 游戏角色       │     │ 存档数据        │     │ 存档管理器      │
  └────────────────┘     └────────────────┘     └────────────────┘
```

---
  代码示例：游戏存档
```cpp
  #include <iostream>
  #include <string>
  #include <memory>
  #include <vector>

  // 备忘录：存储游戏角色的状态
  class GameMemento {
      int m_level;
      int m_hp;
      int m_coin;
      std::string m_name;  // 存档名称

      // 只有发起人（GameRole）可以访问
      friend class GameRole;

      GameMemento(int level, int hp, int coin, const std::string& name)
          : m_level(level), m_hp(hp), m_coin(coin), m_name(name) {}

  public:
      std::string getName() const { return m_name; }

      // 供显示使用（只读）
      std::string getInfo() const {
          return "第" + std::to_string(m_level) + "关 " +
                 "血量:" + std::to_string(m_hp) + " " +
                 "金币:" + std::to_string(m_coin);
      }
  };

  // 发起人：游戏角色
  class GameRole {
      int m_level = 1;
      int m_hp = 100;
      int m_coin = 0;

  public:
      void play() {
          m_level++;
          m_hp -= 10;
          m_coin += 100;
          std::cout << "玩游戏... 当前: " << getStatus() << std::endl;
      }

      void attacked() {
          m_hp -= 30;
          std::cout << "被攻击！当前: " << getStatus() << std::endl;
      }

      std::string getStatus() const {
          return "第" + std::to_string(m_level) + "关 " +
                 "血量:" + std::to_string(m_hp) + " " +
                 "金币:" + std::to_string(m_coin);
      }

      // 创建备忘录
      std::unique_ptr<GameMemento> save(const std::string& saveName) {
          std::cout << "💾 创建存档: " << saveName << std::endl;
          return std::make_unique<GameMemento>(m_level, m_hp, m_coin, saveName);
      }

      // 从备忘录恢复
      void restore(const GameMemento& memento) {
          m_level = memento.m_level;
          m_hp = memento.m_hp;
          m_coin = memento.m_coin;
          std::cout << "📂 读取存档: " << memento.getName() << std::endl;
      }
  };

  // 管理者：存档管理器
  class SaveManager {
      std::vector<std::unique_ptr<GameMemento>> m_saves;

  public:
      void addSave(std::unique_ptr<GameMemento> memento) {
          m_saves.push_back(std::move(memento));
      }

      GameMemento* getSave(int index) {
          if (index >= 0 && index < static_cast<int>(m_saves.size())) {
              return m_saves[index].get();
          }
          return nullptr;
      }

      void listSaves() const {
          std::cout << "\n=== 存档列表 ===" << std::endl;
          for (size_t i = 0; i < m_saves.size(); ++i) {
              std::cout << i << ". " << m_saves[i]->getName()
                        << " - " << m_saves[i]->getInfo() << std::endl;
          }
          std::cout << "===============\n" << std::endl;
      }

      size_t getCount() const { return m_saves.size(); }
  };

  // 使用
  int main() {
      GameRole role;
      SaveManager saveManager;

      std::cout << "初始状态: " << role.getStatus() << "\n" << std::endl;

      // 创建存档1
      saveManager.addSave(role.save("初始存档"));

      // 玩游戏
      role.play();
      role.play();
      role.attacked();

      // 创建存档2
      saveManager.addSave(role.save("打Boss前"));

      // 继续玩，结果被击败
      role.attacked();
      role.attacked();
      std::cout << "💀 游戏结束！当前: " << role.getStatus() << std::endl;

      // 列出所有存档
      saveManager.listSaves();

      // 选择读取存档2
      std::cout << ">>> 选择读取存档1（打Boss前）" << std::endl;
      role.restore(*saveManager.getSave(1));
      std::cout << "恢复后: " << role.getStatus() << std::endl;

      return 0;
  }
```
  输出：
```shell
  初始状态: 第1关 血量:100 金币:0

  💾 创建存档: 初始存档
  玩游戏... 当前: 第2关 血量:90 金币:100
  玩游戏... 当前: 第3关 血量:80 金币:200
  被攻击！当前: 第3关 血量:50 金币:200
  💾 创建存档: 打Boss前
  被攻击！当前: 第3关 血量:20 金币:200
  被攻击！当前: 第3关 血量:-10 金币:200
  💀 游戏结束！当前: 第3关 血量:-10 金币:200

  === 存档列表 ===
  0. 初始存档 - 第1关 血量:100 金币:0
  1. 打Boss前 - 第3关 血量:50 金币:200
  ===============

  >>> 选择读取存档1（打Boss前）
  📂 读取存档: 打Boss前
  恢复后: 第3关 血量:50 金币:200
```
---
  结构示意图

```
  ┌─────────────────────────────────────────────────────────────┐
  │                        Client                               │
  │  (调用 Originator 创建/恢复备忘录，交给 Caretaker 管理)       │
  └─────────────────────────────────────────────────────────────┘
          │
          │ 使用
          ▼
  ┌───────────────────┐         ┌───────────────────┐
  │    Originator     │ create  │     Memento       │
  │    (发起人)        │────────►│    (备忘录)        │
  │───────────────────│         │───────────────────│
  │ - state           │         │ - state           │
  │───────────────────│         │───────────────────│
  │ + save()          │◄────────│ (状态存储)         │
  │ + restore()       │ restore │                   │
  └───────────────────┘         └───────────────────┘
                                          ▲
                                          │ 保存
                                 ┌────────┴────────┐
                                 │    Caretaker    │
                                 │    (管理者)      │
                                 │─────────────────│
                                 │ - mementos[]    │
                                 │ + addMemento()  │
                                 │ + getMemento()  │
                                 └─────────────────┘
```

  管理者只负责保存备忘录，不修改其内容
  备忘录只存储状态，不关心被谁使用
  发起人可以访问备忘录内部状态

---
  双接口设计（更严格的封装）

  使用接口隔离，让 Caretaker 只能持有，不能访问内容：
```cpp
  // 窄接口：给 Caretaker 使用
  class IMemento {
  public:
      virtual ~IMemento() = default;
      virtual std::string getName() const = 0;
  };

  // 宽接口：给 Originator 使用（内部类或友元）
  class Memento : public IMemento {
      int m_state;
      std::string m_name;

      friend class Originator;

      Memento(int state, const std::string& name)
          : m_state(state), m_name(name) {}

      int getState() const { return m_state; }

  public:
      std::string getName() const override { return m_name; }
  };

  // Caretaker 只能访问 IMemento 接口
  class Caretaker {
      std::vector<std::unique_ptr<IMemento>> m_mementos;

  public:
      void addMemento(std::unique_ptr<IMemento> m) {
          m_mementos.push_back(std::move(m));
      }

      IMemento* getMemento(size_t index) {
          return m_mementos[index].get();
      }
  };

  // Originator 可以访问 Memento 的内部
  class Originator {
      int m_state = 0;

  public:
      std::unique_ptr<Memento> save() {
          return std::make_unique<Memento>(m_state, "save_" + std::to_string(m_state));
      }

      void restore(const Memento& m) {
          m_state = m.getState();
      }
  };
```
---
  实际应用：文本编辑器撤销
```cpp
  #include <stack>

  // 备忘录
  class TextMemento {
      std::string m_content;
      friend class TextEditor;

      TextMemento(const std::string& content) : m_content(content) {}

  public:
      // 供外部查看
      std::string getPreview() const {
          return m_content.substr(0, 20) + "...";
      }
  };

  // 发起人：文本编辑器
  class TextEditor {
      std::string m_content;

  public:
      void type(const std::string& text) {
          m_content += text;
          std::cout << "输入: " << text << std::endl;
      }

      void show() const {
          std::cout << "当前内容: " << m_content << std::endl;
      }

      // 保存状态
      std::unique_ptr<TextMemento> save() {
          return std::make_unique<TextMemento>(m_content);
      }

      // 恢复状态
      void restore(const TextMemento& memento) {
          m_content = memento.m_content;
      }
  };

  // 管理者：撤销历史
  class UndoHistory {
      std::stack<std::unique_ptr<TextMemento>> m_history;

  public:
      void push(std::unique_ptr<TextMemento> memento) {
          m_history.push(std::move(memento));
      }

      std::unique_ptr<TextMemento> pop() {
          if (m_history.empty()) return nullptr;
          auto top = std::move(m_history.top());
          m_history.pop();
          return top;
      }

      bool canUndo() const { return !m_history.empty(); }
  };

  // 使用
  int main() {
      TextEditor editor;
      UndoHistory undoHistory;

      editor.type("Hello");
      undoHistory.push(editor.save());

      editor.type(" World");
      undoHistory.push(editor.save());

      editor.type("!");
      editor.show();  // Hello World!

      // 撤销
      std::cout << "\n--- 撤销 ---" << std::endl;
      undoHistory.pop();  // 弹出当前状态
      auto prevState = undoHistory.pop();
      if (prevState) {
          editor.restore(*prevState);
          editor.show();  // Hello
      }

      return 0;
  }
```
---
  与命令模式配合

  备忘录常与命令模式结合实现撤销功能：
```cpp
  class Command {
  public:
      virtual ~Command() = default;
      virtual void execute() = 0;
      virtual void undo() = 0;
  };

  class TextCommand : public Command {
      TextEditor& m_editor;
      std::string m_text;
      std::unique_ptr<TextMemento> m_backup;

  public:
      TextCommand(TextEditor& editor, const std::string& text)
          : m_editor(editor), m_text(text) {}

      void execute() override {
          m_backup = m_editor.save();  // 执行前保存
          m_editor.type(m_text);
      }

      void undo() override {
          if (m_backup) {
              m_editor.restore(*m_backup);
          }
      }
  };
```
---
  适用场景

```
  ┌───────────┬────────────────────┐
  │   场景    │        说明        │
  ├───────────┼────────────────────┤
  │ 撤销/重做 │ 编辑器、IDE        │
  ├───────────┼────────────────────┤
  │ 游戏存档  │ 保存/读取进度      │
  ├───────────┼────────────────────┤
  │ 事务回滚  │ 数据库操作失败恢复 │
  ├───────────┼────────────────────┤
  │ 历史记录  │ 浏览器前进/后退    │
  └───────────┴────────────────────┘
```

---
  优缺点

  优点：
  - 不破坏封装，状态细节对其他对象隐藏
  - 简化发起人职责，状态管理交给备忘录

  缺点：
  - 状态多时内存消耗大
  - 管理大量备忘录增加复杂性

---
  总结：备忘录模式就是**"后悔药"——保存过去的状态，需要时回退。核心是分离状态存储和状态所有者**，保持封装性。


