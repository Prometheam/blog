---
title: "设计模式详解：桥接模式（Bridge）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 桥接模式
 一、核心思想

  将抽象部分与实现部分分离，使它们都可以独立变化。

  传统继承：抽象类 → 具体实现类（固定绑定）
  桥接模式：抽象类 ──桥接──▶ 实现接口（动态绑定）

---
  二、模式结构

  ```
	┌─────────────────────────────────────────────────────────────────┐
  │                   Abstraction (抽象类)                           │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ - impl: Implementor   // 持有实现接口的引用               │   │
  │  │ + operation()         // 调用 impl.operationImpl()       │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
              │                               │
              │ 继承                           │ 组合（桥接）
              ▼                               ▼
  ┌───────────────────────┐       ┌───────────────────────────────┐
  │  RefinedAbstraction    │       │     Implementor (实现接口)     │
  │    (扩展抽象类)         │       │  ┌─────────────────────────┐ │
  │                        │       │  │ + operationImpl()       │ │
  │ + operation()          │       │  └─────────────────────────┘ │
  │ { 增强功能 }            │       └───────────────────────────────┘
  └───────────────────────┘                       │
                                                  │ 实现
                          ┌───────────────────────┼───────────────────────┐
                          ▼                       ▼                       ▼
              ┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐
              │ ConcreteImplA     │   │ ConcreteImplB     │   │ ConcreteImplC     │
              │   (实现A)         │   │   (实现B)         │   │   (实现C)         │
              │ + operationImpl() │   │ + operationImpl() │   │ + operationImpl() │
              └───────────────────┘   └───────────────────┘   └───────────────────┘
	```

---
  三、标准实现

  // 实现接口
  class Implementor {
  public:
      virtual ~Implementor() = default;
      virtual void operationImpl() = 0;
  };

  // 具体实现A
  class ConcreteImplA : public Implementor {
  public:
      void operationImpl() override {
          std::cout << "ConcreteImplA: 具体实现A\n";
      }
  };

  // 具体实现B
  class ConcreteImplB : public Implementor {
  public:
      void operationImpl() override {
          std::cout << "ConcreteImplB: 具体实现B\n";
      }
  };

  // 抽象类
  class Abstraction {
  public:
      Abstraction(Implementor* impl) : m_impl(impl) {}
      virtual ~Abstraction() { delete m_impl; }

      virtual void operation() {
          m_impl->operationImpl();
      }

  protected:
      Implementor* m_impl;
  };

  // 扩展抽象类
  class RefinedAbstraction : public Abstraction {
  public:
      RefinedAbstraction(Implementor* impl) : Abstraction(impl) {}

      void operation() override {
          std::cout << "RefinedAbstraction: 前置处理\n";
          m_impl->operationImpl();  // 委托给实现
          std::cout << "RefinedAbstraction: 后置处理\n";
      }
  };

  // 使用示例
  int main() {
      // 运行时选择实现
      Abstraction* abs1 = new Abstraction(new ConcreteImplA());
      Abstraction* abs2 = new RefinedAbstraction(new ConcreteImplB());

      abs1->operation();  // 使用实现A
      abs2->operation();  // 使用实现B（带增强）
  }

---
  四、为什么需要桥接模式？

  问题：类爆炸

  不使用桥接模式：

  Shape ──▶ Circle
        ──▶ Rectangle
        ──▶ Triangle

  DrawingAPI ──▶ DrawAPI1
             ──▶ DrawAPI2

  组合继承：
  Circle + DrawAPI1 = CircleAPI1
  Circle + DrawAPI2 = CircleAPI2
  Rectangle + DrawAPI1 = RectangleAPI1
  Rectangle + DrawAPI2 = RectangleAPI2
  ...

  N个形状 × M个API = N×M 个类

  使用桥接模式：

  Shape ──▶ Circle          DrawingAPI ──▶ DrawAPI1
        ──▶ Rectangle    ◀──桥接──▶        ──▶ DrawAPI2
        ──▶ Triangle

  N个形状 + M个API = N+M 个类

---
  五、桥接模式经典案例

  图形绘制

  // 实现接口：绘制API
  class DrawingAPI {
  public:
      virtual void drawCircle(double x, double y, double radius) = 0;
      virtual void drawRectangle(double x, double y, double w, double h) = 0;
      virtual ~DrawingAPI() = default;
  };

  // 具体实现：OpenGL
  class OpenGLAPI : public DrawingAPI {
  public:
      void drawCircle(double x, double y, double radius) override {
          std::cout << "OpenGL 绘制圆形: (" << x << "," << y << ") r=" << radius << "\n";
      }
      void drawRectangle(double x, double y, double w, double h) override {
          std::cout << "OpenGL 绘制矩形: (" << x << "," << y << ") " << w << "x" << h << "\n";
      }
  };

  // 具体实现：DirectX
  class DirectXAPI : public DrawingAPI {
  public:
      void drawCircle(double x, double y, double radius) override {
          std::cout << "DirectX 绘制圆形: (" << x << "," << y << ") r=" << radius << "\n";
      }
      void drawRectangle(double x, double y, double w, double h) override {
          std::cout << "DirectX 绘制矩形: (" << x << "," << y << ") " << w << "x" << h << "\n";
      }
  };

  // 抽象类：形状
  class Shape {
  public:
      Shape(DrawingAPI* api) : m_api(api) {}
      virtual ~Shape() { delete m_api; }
      virtual void draw() = 0;
      virtual void resize(double factor) = 0;

  protected:
      DrawingAPI* m_api;
  };

  // 具体抽象：圆形
  class Circle : public Shape {
  public:
      Circle(double x, double y, double r, DrawingAPI* api)
          : Shape(api), m_x(x), m_y(y), m_radius(r) {}

      void draw() override {
          m_api->drawCircle(m_x, m_y, m_radius);
      }
    
      void resize(double factor) override {
          m_radius *= factor;
      }

  private:
      double m_x, m_y, m_radius;
  };

  // 使用
  Shape* circle1 = new Circle(0, 0, 5, new OpenGLAPI());
  Shape* circle2 = new Circle(0, 0, 5, new DirectXAPI());

  circle1->draw();  // OpenGL 绘制
  circle2->draw();  // DirectX 绘制

---
  六、VQRS 中的桥接思想

  1. 插件工厂模式 (PluginFactory.h)

  // 实现接口
  class IPlugin {
  public:
      virtual bool IsClone() = 0;
      virtual IPlugin* clone() = 0;
      virtual bool IsFactory() = 0;
      virtual void injectSender(CProcessorBase* pSender) = 0;
  };

  // 抽象处理者（持有实现接口）
  class IPluginHanderSender : public IPlugin {
  protected:
      CProcessorBase* m_pSender;  // 桥接的实现

  public:
      virtual void injectSender(CProcessorBase* pSender) {
          m_pSender = pSender;
      }
  };

  // 具体实现
  class CPluginHandlerSingleton : public IPluginHanderSender {
  public:
      virtual bool IsFactory() { return false; }
      virtual bool IsClone() { return false; }
  };

  // 抽象工厂（持有插件实现）
  template<class K>
  class CPluginFactory : public IPlugin {
  private:
      std::map<K, IPlugin*> m_mapPlugin;  // 桥接多个实现

  public:
      IPlugin* getPlugin(K& key, bool bDefault = true);
      int injectPlugin(K& key, IPlugin& plugIn, bool bDefault = false);
  };

  桥接结构：

  ┌─────────────────────────────────────────────────────────────┐
  │                 CPluginFactory<K> (抽象)                     │
  │  ┌─────────────────────────────────────────────────────┐   │
  │  │ - m_mapPlugin: map<K, IPlugin*>  // 桥接多个实现      │   │
  │  │ + getPlugin(key) → IPlugin                          │   │
  │  └─────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────┘
                                │
                                │ 组合（桥接）
                                ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                     IPlugin (实现接口)                       │
  └─────────────────────────────────────────────────────────────┘
            │                   │                   │
            ▼                   ▼                   ▼
  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
  │CPluginHandler   │ │ CSyncHandler    │ │ 其他Handler     │
  │  Singleton      │ │                 │ │                 │
  └─────────────────┘ └─────────────────┘ └─────────────────┘

  2. 会话管理器 (Session.h)

  // 抽象会话
  class NMSSession : public ThreadSafeRefCounted {
  public:
      virtual void setSsnID(uint32 ulSsnID);
      virtual int startTimer(uint32 ulSecond, bool bIsCycle = false);
  };

  // 会话管理器（抽象层，持有实现）
  template<class T, class IDGen>
  class SessionMgr {
  private:
      IDGen m_SubIDGen;                // ID生成器（可变实现）
      std::map<uint32, T*> m_mapSession;  // 会话存储（可变实现）

  public:
      int createSession(uint32& ulSsnID);
      int deleteSession(uint32 ulSsnID);
      T* getSession(uint32 ulSsnID);
  };

  // 使用不同的实现
  SessionMgr<MySession, IDGenerator> mgr1;  // 实现1
  SessionMgr<MySession, UUIDGenerator> mgr2;  // 实现2

---
  七、桥接模式 vs 其他模式

  ┌────────┬────────────────┬──────────┬──────────────────────┐
  │  模式  │      目的      │   关系   │         特点         │
  ├────────┼────────────────┼──────────┼──────────────────────┤
  │ 桥接   │ 分离抽象与实现 │ 组合关系 │ 抽象持有实现接口     │
  ├────────┼────────────────┼──────────┼──────────────────────┤
  │ 策略   │ 算法可互换     │ 组合关系 │ 上下文持有策略接口   │
  ├────────┼────────────────┼──────────┼──────────────────────┤
  │ 适配器 │ 接口转换       │ 包装关系 │ 让不兼容接口协同     │
  ├────────┼────────────────┼──────────┼──────────────────────┤
  │ 代理   │ 控制访问       │ 包装关系 │ 代理与真实对象同接口 │
  ├────────┼────────────────┼──────────┼──────────────────────┤
  │ 装饰器 │ 动态增强       │ 包装关系 │ 装饰器与组件同接口   │
  └────────┴────────────────┴──────────┴──────────────────────┘

  桥接：   Abstraction ◀──▶ Implementor  (分离维度，独立变化)
  策略：   Context ◀──▶ Strategy         (算法切换)
  适配器： Target ◀── Adapter ──▶ Adaptee (接口转换)
  代理：   Subject ◀── Proxy ──▶ RealSubject (控制访问)
  装饰器： Component ◀── Decorator ──▶ Component (功能增强)

  桥接 vs 策略的区别：

  // 桥接：抽象与实现的分离（两个维度）
  class Shape {
      DrawingAPI* m_api;  // 绘制实现（一个维度）
      // 形状属性（另一个维度）
  };
  // Shape 和 DrawingAPI 可以独立变化

  // 策略：算法的切换
  class Sorter {
      SortStrategy* m_strategy;  // 排序算法
  };
  // Sorter 本身不变化，只是策略可换

---
  八、设计要点

  ┌──────────────┬────────────────────────────┐
  │     要点     │            说明            │
  ├──────────────┼────────────────────────────┤
  │ 识别维度     │ 找出可以独立变化的两个维度 │
  ├──────────────┼────────────────────────────┤
  │ 组合优于继承 │ 用组合代替多层继承         │
  ├──────────────┼────────────────────────────┤
  │ 实现接口     │ 定义清晰的实现接口         │
  ├──────────────┼────────────────────────────┤
  │ 运行时绑定   │ 抽象可以在运行时切换实现   │
  ├──────────────┼────────────────────────────┤
  │ 开闭原则     │ 新增实现不影响已有抽象     │
  └──────────────┴────────────────────────────┘

---
  九、适用场景

  适合使用：
  - 需要避免抽象和实现的永久绑定
  - 抽象和实现都应有独立扩展能力
  - 需要在运行时切换实现
  - 多层继承导致类爆炸

  不适合使用：
  - 抽象和实现没有独立变化需求
  - 只有一个实现
  - 增加复杂度但无实际收益

---
  十、实际应用示例

  数据库驱动

  // 实现接口：数据库连接
  class IDBConnection {
  public:
      virtual void connect(const std::string& url) = 0;
      virtual void execute(const std::string& sql) = 0;
      virtual void disconnect() = 0;
  };

  // 具体实现
  class MySQLConnection : public IDBConnection { /* ... */ };
  class PostgreSQLConnection : public IDBConnection { /* ... */ };
  class OracleConnection : public IDBConnection { /* ... */ };

  // 抽象类：数据库操作
  class Database {
  public:
      Database(IDBConnection* conn) : m_conn(conn) {}

      void query(const std::string& sql) {
          m_conn->execute(sql);
      }

  private:
      IDBConnection* m_conn;
  };

  // 使用
  Database db1(new MySQLConnection());
  Database db2(new PostgreSQLConnection());

  日志系统

  // 实现接口：日志输出
  class ILoggerImpl {
  public:
      virtual void write(const std::string& msg) = 0;
  };

  class ConsoleLogger : public ILoggerImpl {
  public:
      void write(const std::string& msg) override {
          std::cout << msg << std::endl;
      }
  };

  class FileLogger : public ILoggerImpl {
  public:
      void write(const std::string& msg) override {
          // 写入文件
      }
  };

  // 抽象类：日志器
  class Logger {
  public:
      Logger(ILoggerImpl* impl) : m_impl(impl) {}

      void log(const std::string& msg) {
          std::string formatted = format(msg);
          m_impl->write(formatted);
      }

  private:
      ILoggerImpl* m_impl;
  };

---
  十一、桥接模式的组合结构

                      ┌─────────────────────────────┐
                      │        Abstraction          │
                      │    (抽象层 - 业务逻辑)       │
                      └─────────────────────────────┘
                                  │
                      ┌───────────┴───────────┐
                      │                       │
                      ▼                       ▼
          ┌───────────────────┐   ┌───────────────────┐
          │ RefinedAbstraction│   │ RefinedAbstraction│
          │        A          │   │        B          │
          └───────────────────┘   └───────────────────┘
                      │                       │
                      └───────────┬───────────┘
                                  │
                                  ▼
                      ┌─────────────────────────────┐
                      │       Implementor          │
                      │    (实现接口 - 平台相关)    │
                      └─────────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
      ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
      │ ConcreteImplA │   │ ConcreteImplB │   │ ConcreteImplC │
      │   Windows     │   │    Linux      │   │    macOS      │
      └───────────────┘   └───────────────┘   └───────────────┘

  核心价值：抽象层和实现层可以独立扩展，互不影响。
