---
title: "设计模式详解：中介者模式（Mediator）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 中介者模式
 核心思想: 用一个中介对象封装一系列对象的交互，中介者使各对象不需要显式相互引用，从而降低耦合，而且可以独立改变它们之间的交互。

---
  现实比喻

  空中交通管制：

                      ┌────────────────────┐
                      │    塔台(中介者)     │
                      │  AirTrafficControl │
                      └──────────┬─────────┘
                                 │
           ┌─────────────────────┼─────────────────────┐
           │                     │                     │
           ▼                     ▼                     ▼
     ┌───────────┐         ┌───────────┐         ┌───────────┐
     │  飞机A    │         │  飞机B    │         │  飞机C    │
     │           │         │           │         │           │
     │ 不直接联系│         │ 不直接联系│         │ 不直接联系│
     │ 其他飞机  │         │ 其他飞机  │         │ 其他飞机  │
     └───────────┘         └───────────┘         └───────────┘

  没有塔台：每架飞机要和其他所有飞机通信 → 混乱
  有塔台：飞机只和塔台通信，塔台协调所有飞机 → 有序

---
  问题场景

  没有中介者：对象间网状依赖

       A ←──────→ B
       ↑↖    ↗↑↖ ↗
       │  ↗  │  ↗ │
       │↗    ↓↙   ↓
       C ←──────→ D

  每增加一个对象，需要和其他所有对象建立连接
  关系复杂，难以维护

  使用中介者：星形结构

              A
              │
         D ───┼─── B
              │
              C

  所有对象只和中介者通信
  对象之间互不知道对方

---
  代码示例：聊天室
```cpp
  #include <iostream>
  #include <string>
  #include <memory>
  #include <vector>

  // 前向声明
  class User;

  // 中介者接口
  class ChatMediator {
  public:
      virtual ~ChatMediator() = default;
      virtual void sendMessage(const std::string& message, User* sender) = 0;
      virtual void addUser(User* user) = 0;
  };

  // 同事类：用户
  class User {
  protected:
      ChatMediator* m_mediator;
      std::string m_name;

  public:
      User(ChatMediator* mediator, const std::string& name)
          : m_mediator(mediator), m_name(name) {}

      virtual ~User() = default;

      virtual void send(const std::string& message) {
          std::cout << "\n[" << m_name << " 发送消息]: " << message << std::endl;
          m_mediator->sendMessage(message, this);
      }

      virtual void receive(const std::string& message, const std::string& senderName) {
          std::cout << "  → [" << m_name << "] 收到来自 [" << senderName
                    << "] 的消息: " << message << std::endl;
      }

      std::string getName() const { return m_name; }
  };

  // 具体中介者：聊天室
  class ChatRoom : public ChatMediator {
      std::vector<User*> m_users;

  public:
      void addUser(User* user) override {
          m_users.push_back(user);
          std::cout << "👤 " << user->getName() << " 加入聊天室" << std::endl;
      }

      void sendMessage(const std::string& message, User* sender) override {
          for (User* user : m_users) {
              if (user != sender) {  // 不发给自己
                  user->receive(message, sender->getName());
              }
          }
      }
  };

  // 具体同事类：普通用户
  class RegularUser : public User {
  public:
      using User::User;
  };

  // 具体同事类：管理员（有额外功能）
  class AdminUser : public User {
  public:
      using User::User;

      void send(const std::string& message) override {
          std::cout << "\n👮 [管理员 " << m_name << " 发送公告]: "
                    << message << std::endl;
          m_mediator->sendMessage("📢 " + message, this);
      }

      void receive(const std::string& message, const std::string& senderName) override {
          std::cout << "  → [管理员 " << m_name << "] 收到来自 [" << senderName
                    << "]: " << message << std::endl;
      }
  };

  // 使用
  int main() {
      ChatRoom chatRoom;

      // 添加用户
      auto alice = std::make_unique<RegularUser>(&chatRoom, "Alice");
      auto bob = std::make_unique<RegularUser>(&chatRoom, "Bob");
      auto charlie = std::make_unique<RegularUser>(&chatRoom, "Charlie");
      auto admin = std::make_unique<AdminUser>(&chatRoom, "管理员张三");

      chatRoom.addUser(alice.get());
      chatRoom.addUser(bob.get());
      chatRoom.addUser(charlie.get());
      chatRoom.addUser(admin.get());

      // 用户发消息
      alice->send("大家好！");

      // 管理员发公告
      admin->send("请注意，聊天室规则已更新");

      return 0;
  }
```
  输出：
```shell
  👤 Alice 加入聊天室
  👤 Bob 加入聊天室
  👤 Charlie 加入聊天室
  👤 管理员张三 加入聊天室

  [Alice 发送消息]: 大家好！
    → [Bob] 收到来自 [Alice] 的消息: 大家好！
    → [Charlie] 收到来自 [Alice] 的消息: 大家好！
    → [管理员张三] 收到来自 [Alice] 的消息: 大家好！

  👮 [管理员 管理员张三 发送公告]: 请注意，聊天室规则已更新
    → [Alice] 收到来自 [管理员张三] 的消息: 📢 请注意，聊天室规则已更新
    → [Bob] 收到来自 [管理员张三] 的消息: 📢 请注意，聊天室规则已更新
    → [Charlie] 收到来自 [管理员张三] 的消息: 📢 请注意，聊天室规则已更新
```
---
  结构示意图

 ```
 ┌─────────────────────────────────────────────────────────────┐
  │                        Client                               │
  └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                   <<interface>>                             │
  │                    Mediator                                 │
  │  ─────────────────────────────────────────────────────────  │
  │  + colleagueChanged(colleague)                              │
  └─────────────────────────────────────────────────────────────┘
                                △
                                │
                      ┌─────────┴─────────┐
                      │  ConcreteMediator │
                      │  (ChatRoom)       │
                      │  ─────────────────│
                      │  - colleagues[]   │
                      │  + send()         │
                      └───────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │ Colleague    │  │ Colleague    │  │ Colleague    │
     │ (User)       │  │ (User)       │  │ (User)       │
     │──────────────│  │──────────────│  │──────────────│
     │ - mediator   │  │ - mediator   │  │ - mediator   │
     │ + send()     │  │ + send()     │  │ + send()     │
     │ + receive()  │  │ + receive()  │  │ + receive()  │
     └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
            │                 │                 │
            └─────────────────┴─────────────────┘
                       只通过中介者交互
```

---
  更复杂示例：GUI 组件交互
```cpp
  #include <iostream>
  #include <string>

  // 前向声明
  class Button;
  class TextBox;
  class ListBox;

  // 中介者
  class DialogMediator {
  public:
      virtual ~DialogMediator() = default;
      virtual void onButtonClicked() = 0;
      virtual void onSelectionChanged() = 0;
      virtual void onTextChanged() = 0;
  };

  // 组件基类
  class UIComponent {
  protected:
      DialogMediator* m_mediator;
      bool m_enabled = true;

  public:
      void setMediator(DialogMediator* mediator) { m_mediator = mediator; }
      void setEnabled(bool enabled) { m_enabled = enabled; }
      bool isEnabled() const { return m_enabled; }
  };

  // 具体组件：按钮
  class Button : public UIComponent {
      std::string m_text;
  public:
      Button(const std::string& text) : m_text(text) {}

      void click() {
          if (m_enabled) {
              std::cout << "🖱️ 按钮点击: " << m_text << std::endl;
              m_mediator->onButtonClicked();
          }
      }

      void setText(const std::string& text) { m_text = text; }
  };

  // 具体组件：文本框
  class TextBox : public UIComponent {
      std::string m_text;
  public:
      void setText(const std::string& text) {
          m_text = text;
          std::cout << "📝 文本框内容: " << m_text << std::endl;
      }

      std::string getText() const { return m_text; }

      void type(const std::string& text) {
          m_text += text;
          m_mediator->onTextChanged();
      }
  };

  // 具体组件：列表框
  class ListBox : public UIComponent {
      std::vector<std::string> m_items;
      int m_selectedIndex = -1;

  public:
      void addItem(const std::string& item) { m_items.push_back(item); }

      void select(int index) {
          m_selectedIndex = index;
          std::cout << "📋 选择: " << m_items[index] << std::endl;
          m_mediator->onSelectionChanged();
      }

      std::string getSelected() const {
          if (m_selectedIndex >= 0 && m_selectedIndex < (int)m_items.size()) {
              return m_items[m_selectedIndex];
          }
          return "";
      }
  };

  // 具体中介者：登录对话框
  class LoginDialog : public DialogMediator {
      Button* m_loginBtn;
      Button* m_cancelBtn;
      TextBox* m_usernameBox;
      TextBox* m_passwordBox;
      ListBox* m_userList;

  public:
      void setComponents(Button* login, Button* cancel,
                         TextBox* username, TextBox* password,
                         ListBox* userList) {
          m_loginBtn = login;
          m_cancelBtn = cancel;
          m_usernameBox = username;
          m_passwordBox = password;
          m_userList = userList;

          m_loginBtn->setMediator(this);
          m_cancelBtn->setMediator(this);
          m_usernameBox->setMediator(this);
          m_passwordBox->setMediator(this);
          m_userList->setMediator(this);

          // 初始状态：登录按钮禁用
          m_loginBtn->setEnabled(false);
      }

      void onButtonClicked() override {
          // 登录按钮点击
          if (m_usernameBox->isEnabled() && m_passwordBox->isEnabled()) {
              std::cout << "✅ 登录成功！" << std::endl;
          }
      }

      void onSelectionChanged() override {
          // 选择用户后，自动填充用户名
          std::string selected = m_userList->getSelected();
          if (!selected.empty()) {
              m_usernameBox->setText(selected);
              validateForm();
          }
      }

      void onTextChanged() override {
          validateForm();
      }

  private:
      void validateForm() {
          // 简单验证：用户名和密码都不为空时启用登录按钮
          bool valid = !m_usernameBox->getText().empty() &&
                       !m_passwordBox->getText().empty();
          m_loginBtn->setEnabled(valid);

          if (valid) {
              std::cout << "🔓 登录按钮已启用" << std::endl;
          } else {
              std::cout << "🔒 登录按钮已禁用" << std::endl;
          }
      }
  };

  // 使用
  int main() {
      LoginDialog dialog;

      Button loginBtn("登录");
      Button cancelBtn("取消");
      TextBox usernameBox;
      TextBox passwordBox;
      ListBox userList;

      userList.addItem("admin");
      userList.addItem("user1");
      userList.addItem("guest");

      dialog.setComponents(&loginBtn, &cancelBtn,
                           &usernameBox, &passwordBox, &userList);

      // 用户操作流程
      std::cout << "=== 场景1: 从列表选择用户 ===" << std::endl;
      userList.select(0);  // 选择 admin

      std::cout << "\n=== 场景2: 手动输入 ===" << std::endl;
      usernameBox.setText("testuser");
      passwordBox.setText("123");
      loginBtn.click();  // 登录

      return 0;
  }
```
  输出：
  ```shell
  === 场景1: 从列表选择用户 ===
  📋 选择: admin
  📝 文本框内容: admin
  🔒 登录按钮已禁用

  === 场景2: 手动输入 ===
  📝 文本框内容: testuser
  🔒 登录按钮已禁用
  📝 文本框内容: 123
  🔓 登录按钮已启用
  🖱️ 按钮点击: 登录
  ✅ 登录成功！
  ```
---
  与其他模式对比

```
  ┌────────────────────────────────────────────────────────────────┐
  │                   中介者 vs 其他模式                            │
  ├─────────────────┬──────────────────────────────────────────────┤
  │    中介者模式    │ 对象通过中介者间接通信，解耦对象间关系        │
  ├─────────────────┼──────────────────────────────────────────────┤
  │    观察者模式    │ 一对多通知，被观察者和观察者直接关联          │
  ├─────────────────┼──────────────────────────────────────────────┤
  │    外观模式      │ 简化接口，单向调用（客户端→子系统）           │
  ├─────────────────┼──────────────────────────────────────────────┤
  │    代理模式      │ 控制对象访问，代理和被代理者是一对一          │
  └─────────────────┴──────────────────────────────────────────────┘
```

  中介者：协调多对象间的交互（双向、多对多）
  外观：提供简化入口（单向、客户端调用）

---
  适用场景

```
  ┌────────────────┬────────────────────────────────────────┐
  │      场景      │                  说明                  │
  ├────────────────┼────────────────────────────────────────┤
  │ 对象间引用复杂 │ 网状结构变成星形结构                   │
  ├────────────────┼────────────────────────────────────────┤
  │ GUI 组件交互   │ 表单、对话框中组件联动                 │
  ├────────────────┼────────────────────────────────────────┤
  │ 聊天系统       │ 用户通过聊天室通信                     │
  ├────────────────┼────────────────────────────────────────┤
  │ MVC 架构       │ Controller 作为 Model 和 View 的中介者 │
  └────────────────┴────────────────────────────────────────┘
```

---
  优缺点

  优点：
  - 降低对象间耦合，符合迪米特法则
  - 集中控制交互逻辑，便于维护
  - 对象可独立复用

  缺点：
  - 中介者变得复杂庞大（上帝对象）
  - 调试困难（交互在中介者中）

---
  总结：中介者模式将多对多交互变成一对多，对象只认识中介者，不认识其他对象。适用于对象间关系复杂、需要解耦的场景。


