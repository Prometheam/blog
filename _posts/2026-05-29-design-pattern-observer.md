---
title: "设计模式详解：观察者模式（Observer）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 观察者模式
 核心思想: 定义对象间一对多的依赖关系，当一个对象（被观察者）状态改变时，所有依赖它的对象（观察者）都会收到通知并自动更新。

---
  现实比喻

```
  微信公众号/订阅：

                      ┌──────────────────┐
                      │   微信公众号      │  ← 被观察者
                      │   (Subject)      │
                      └────────┬─────────┘
                               │ 发布新文章
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
     ┌───────────┐       ┌───────────┐       ┌───────────┐
     │  用户A    │       │  用户B    │       │  用户C    │
     │ (Observer)│       │ (Observer)│       │ (Observer)│
     │  收到推送  │       │  收到推送  │       │  收到推送  │
     └───────────┘       └───────────┘       └───────────┘

  公众号不关心谁订阅了它，只负责发布
  用户随时可以订阅/取消订阅
```

---
  代码示例
```cpp
  #include <iostream>
  #include <vector>
  #include <memory>
  #include <string>

  // 观察者接口
  class Observer {
  public:
      virtual ~Observer() = default;
      virtual void update(const std::string& message) = 0;
  };

  // 被观察者（主题）
  class Subject {
      std::vector<Observer*> m_observers;
      std::string m_state;

  public:
      void attach(Observer* observer) {
          m_observers.push_back(observer);
          std::cout << "  [观察者注册] 当前观察者数量: "
                    << m_observers.size() << std::endl;
      }

      void detach(Observer* observer) {
          auto it = std::find(m_observers.begin(), m_observers.end(), observer);
          if (it != m_observers.end()) {
              m_observers.erase(it);
          }
      }

      void notify() {
          std::cout << "\n=== 通知所有观察者 ===" << std::endl;
          for (Observer* observer : m_observers) {
              observer->update(m_state);
          }
      }

      void setState(const std::string& state) {
          m_state = state;
          std::cout << "\n[主题] 状态变更: " << m_state << std::endl;
          notify();
      }

      std::string getState() const { return m_state; }
  };

  // 具体观察者：手机用户
  class PhoneUser : public Observer {
      std::string m_name;

  public:
      PhoneUser(const std::string& name) : m_name(name) {}

      void update(const std::string& message) override {
          std::cout << "  📱 " << m_name << " 收到推送: "
                    << message << std::endl;
      }
  };

  // 具体观察者：邮箱用户
  class EmailUser : public Observer {
      std::string m_email;

  public:
      EmailUser(const std::string& email) : m_email(email) {}

      void update(const std::string& message) override {
          std::cout << "  📧 " << m_email << " 收到邮件: "
                    << message << std::endl;
      }
  };

  // 使用
  int main() {
      Subject newsChannel;

      PhoneUser user1("张三");
      PhoneUser user2("李四");
      EmailUser user3("wangwu@mail.com");

      // 订阅
      newsChannel.attach(&user1);
      newsChannel.attach(&user2);
      newsChannel.attach(&user3);

      // 发布消息
      newsChannel.setState("突发：AI技术重大突破！");

      // 取消订阅
      std::cout << "\n--- 李四取消订阅 ---" << std::endl;
      newsChannel.detach(&user2);

      // 再次发布
      newsChannel.setState("今日天气：晴转多云");

      return 0;
  }
```
```shell
  输出：
  [观察者注册] 当前观察者数量: 1
  [观察者注册] 当前观察者数量: 2
  [观察者注册] 当前观察者数量: 3

  [主题] 状态变更: 突发：AI技术重大突破！
  === 通知所有观察者 ===
    📱 张三 收到推送: 突发：AI技术重大突破！
    📱 李四 收到推送: 突发：AI技术重大突破！
    📧 wangwu@mail.com 收到邮件: 突发：AI技术重大突破！

  --- 李四取消订阅 ---

  [主题] 状态变更: 今日天气：晴转多云
  === 通知所有观察者 ===
    📱 张三 收到推送: 今日天气：晴转多云
    📧 wangwu@mail.com 收到邮件: 今日天气：晴转多云
```

---
  VQRS 中的实际应用

  项目中的诊断结果通知使用了观察者模式：
```cpp
  // 被观察者（简化版）
  class CSubject {
      std::list<CObserver*> m_listObserver;

  public:
      void Attach(CObserver* pObserver) {
          m_listObserver.push_back(pObserver);
      }

      void Detach(CObserver* pObserver) {
          m_listObserver.remove(pObserver);
      }

      void Notify(int nMessageType, void* pMsg) {
          for (auto* observer : m_listObserver) {
              observer->Update(nMessageType, pMsg);
          }
      }
  };

  // 观察者接口
  class CObserver {
  public:
      virtual ~CObserver() = default;
      virtual void Update(int nMessageType, void* pMsg) = 0;
  };

  // 具体观察者：分析任务
  class CAnalyzeTask : public CObserver {
  public:
      void Update(int nMessageType, void* pMsg) override {
          // 处理帧数据、算法结果等
          switch (nMessageType) {
              case MSG_FRAME_DATA:
                  processFrame((FrameData*)pMsg);
                  break;
              case MSG_ALGORITHM_RESULT:
                  handleResult((AlgorithmResult*)pMsg);
                  break;
          }
      }
  };
````
  应用场景：解码模块完成帧解码后，通知所有分析任务处理帧数据。

---
  推模型 vs 拉模型
```

  ┌─────────────────────────────────────────────────────────────┐
  │                       推模型 vs 拉模型                        │
  ├──────────────────────┬──────────────────────────────────────┤
  │       推模型          │             拉模型                    │
  ├──────────────────────┼──────────────────────────────────────┤
  │ 主题主动推送数据      │ 主题只通知，观察者主动获取            │
  │ update(data)         │ update() → subject.getState()       │
  │ 观察者被动接收        │ 观察者按需获取                        │
  │ 主题知道观察者需要什么│ 主题不知道观察者需要什么              │
  └──────────────────────┴──────────────────────────────────────┘
```

  拉模型示例：
  ```cpp
  class Observer {
  public:
      virtual void update(Subject* subject) = 0;  // 只传主题引用
  };

  class ConcreteObserver : public Observer {
      void update(Subject* subject) override {
          // 观察者自己决定获取什么数据
          std::string data = subject->getState();
          int count = subject->getCount();
          // ...
      }
  };
  ```
---
  结构示意图

```
  ┌─────────────────────────┐          ┌─────────────────────────┐
  │      <<interface>>      │          │       Subject           │
  │       Observer          │◄─────────│     (被观察者)           │
  │─────────────────────────│  注册    │─────────────────────────│
  │ + update()              │          │ - observers: Observer[] │
  └─────────────────────────┘          │ + attach()              │
            △                          │ + detach()              │
            │                          │ + notify()              │
            │                          │ + setState()            │
            │                          └─────────────────────────┘
     ┌──────┴──────┐                              │
     │             │                              │ notify()
  ┌──┴───────┐  ┌──┴───────┐                     │
  │Concrete  │  │Concrete  │                     │
  │ObserverA │  │ObserverB │                     │
  │──────────│  │──────────│                     │
  │+update() │  │+update() │◄────────────────────┘
  └──────────┘  └──────────┘       循环调用 update()
```

---
  C++ 现代实现：函数式观察者

  使用 std::function 更灵活：
```cpp
  #include <functional>
  #include <map>

  class Signal {
      int m_nextId = 0;
      std::map<int, std::function<void(int)>> m_slots;

  public:
      // 连接（返回连接ID用于断开）
      int connect(std::function<void(int)> slot) {
          m_slots[m_nextId] = slot;
          return m_nextId++;
      }

      // 断开连接
      void disconnect(int id) {
          m_slots.erase(id);
      }

      // 发射信号
      void emit(int value) {
          for (auto& [id, slot] : m_slots) {
              slot(value);
          }
      }
  };

  // 使用
  int main() {
      Signal temperatureChanged;

      // 连接多个观察者（lambda）
      int id1 = temperatureChanged.connect([](int temp) {
          std::cout << "显示器1: 温度 " << temp << "°C" << std::endl;
      });

      temperatureChanged.connect([](int temp) {
          std::cout << "显示器2: 温度 " << temp << std::endl;
      });

      temperatureChanged.emit(25);  // 通知所有观察者

      temperatureChanged.disconnect(id1);  // 断开第一个
      temperatureChanged.emit(30);
  }
```
---
  Qt 信号槽机制

  Qt 的信号槽是观察者模式的强化版：
```cpp
  // Qt 风格
  class TemperatureSensor : public QObject {
      Q_OBJECT
  signals:
      void temperatureChanged(int temp);  // 信号（被观察者）
  };

  class Display : public QObject {
      Q_OBJECT
  public slots:
      void onTemperatureChanged(int temp) {  // 槽（观察者）
          std::cout << "温度: " << temp << std::endl;
      }
  };

  // 连接
  QObject::connect(sensor, &TemperatureSensor::temperatureChanged,
                   display, &Display::onTemperatureChanged);

  // 发射信号
  emit sensor->temperatureChanged(25);
```
---
  与发布-订阅模式的区别

```
  ┌────────────────────────────────────────────────────────────────┐
  │                   观察者 vs 发布-订阅                           │
  ├────────────────────┬───────────────────────────────────────────┤
  │      观察者        │            发布-订阅                       │
  ├────────────────────┼───────────────────────────────────────────┤
  │ 直接通信           │ 通过消息代理/事件通道通信                  │
  │ Subject ──→ Observer│ Publisher ──→ Broker ──→ Subscriber      │
  │ 同步调用           │ 异步通信                                   │
  │ 耦合度较高         │ 完全解耦                                   │
  │ 简单场景           │ 分布式系统、消息队列                       │
  └────────────────────┴───────────────────────────────────────────┘
```

  观察者模式:
    Subject ←──直接──→ Observer

  发布-订阅模式:
    Publisher ──→ [Message Broker] ──→ Subscriber
                       (RabbitMQ/Kafka)

  VQRS 中 RabbitMqAdapter 就是发布-订阅模式的应用。

---
  适用场景

```
  ┌──────────────┬───────────────────────────┐
  │     场景     │           示例            │
  ├──────────────┼───────────────────────────┤
  │ 事件处理系统 │ GUI 事件、按钮点击        │
  ├──────────────┼───────────────────────────┤
  │ 消息通知     │ 公众号、邮件订阅          │
  ├──────────────┼───────────────────────────┤
  │ 数据绑定     │ MVC 模式中的 Model → View │
  ├──────────────┼───────────────────────────┤
  │ 状态监控     │ 传感器数据、日志系统      │
  └──────────────┴───────────────────────────┘
```

---
  优缺点

  优点：
  - 被观察者和观察者解耦，可独立变化
  - 动态增删观察者，符合开闭原则
  - 广播通信，一对多通知

  缺点：
  - 观察者多时性能开销大
  - 顺序依赖时难以控制通知顺序
  - 可能导致循环调用（A观察B，B观察A）

---
  总结：观察者模式是最常用的设计模式之一，核心是解耦事件源和事件处理，让它们可以独立演化。


