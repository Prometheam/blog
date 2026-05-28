---
title: "设计模式详解：适配器模式（Adapter）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 适配器模式
 一、核心思想

  将一个类的接口转换成客户端期望的另一个接口，使原本不兼容的类可以协同工作。

  客户端期望接口 ──▶ 适配器 ──▶ 被适配者
                    (转换)

---
  二、模式结构

  类适配器（继承方式）

  ```
	┌─────────────────────────────────────────────────────────────────┐
  │                      Target (目标接口)                          │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + request()   // 客户端期望的接口                         │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
              ▲
              │ 实现
              │
  ┌───────────────────────────────────────────────────────────────────┐
  │                        Adapter (适配器)                            │
  │  ┌─────────────────────────────────────────────────────────────┐ │
  │ │  class Adapter : public Target, private Adaptee              │ │
  │ │  {                                                            │ │
  │ │      + request() { specificRequest(); }  // 转换调用          │ │
  │ │  }                                                            │ │
  │  └─────────────────────────────────────────────────────────────┘ │
  └───────────────────────────────────────────────────────────────────┘
              │
              │ 继承
              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                     Adaptee (被适配者)                           │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + specificRequest()  // 现有接口                          │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘

  对象适配器（组合方式，推荐）

  ┌─────────────────────────────────────────────────────────────────┐
  │                      Target (目标接口)                          │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + request()   // 客户端期望的接口                         │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
              ▲
              │ 实现
              │
  ┌───────────────────────────────────────────────────────────────────┐
  │                        Adapter (适配器)                            │
  │  ┌─────────────────────────────────────────────────────────────┐ │
  │ │  - adaptee: Adaptee    // 组合持有被适配者                    │ │
  │ │  + request() { adaptee->specificRequest(); }  // 委托调用    │ │
  │  └─────────────────────────────────────────────────────────────┘ │
  └───────────────────────────────────────────────────────────────────┘
              │
              │ 组合
              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                     Adaptee (被适配者)                           │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + specificRequest()  // 现有接口                          │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
	```

---
  三、标准实现

  对象适配器（推荐）

  // 目标接口：客户端期望的接口
  class Target {
  public:
      virtual ~Target() = default;
      virtual void request() = 0;
  };

  // 被适配者：现有接口
  class Adaptee {
  public:
      void specificRequest() {
          std::cout << "Adaptee: 特殊请求\n";
      }
  };

  // 适配器：转换接口
  class Adapter : public Target {
  public:
      Adapter(Adaptee* adaptee) : m_adaptee(adaptee) {}

      void request() override {
          // 接口转换：request() → specificRequest()
          m_adaptee->specificRequest();
      }

  private:
      Adaptee* m_adaptee;  // 组合持有
  };

  // 使用
  Target* target = new Adapter(new Adaptee());
  target->request();  // 客户端只需知道 Target 接口

  类适配器（多重继承）

  // 适配器：多重继承
  class Adapter : public Target, private Adaptee {
  public:
      void request() override {
          specificRequest();  // 直接调用继承来的方法
      }
  };

---
  四、VQRS 中的适配器模式实现

  1. 架构总览

```
	  ┌─────────────────────────────────────────────────────────────────────┐
  │                        VQRS 系统架构                                 │
  │  ┌───────────────────────────────────────────────────────────────┐ │
  │  │                    CProcessorBase (目标接口)                   │ │
  │  │  + DealWithOneRequest()                                       │ │
  │  │  + DealWithOneResponse()                                      │ │
  │  │  + DealWithOneNotify()                                        │ │
  │  │  + DealWithOneTimeOut()                                       │ │
  │  └───────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────────┘
              ▲
              │ 实现
      ┌───────┼───────┬───────────────┬───────────────┐
      │       │       │               │               │
  ┌───┴───┐┌───┴───┐┌───┴───────┐┌─────┴─────┐┌───────┴───────┐
  │Media  ││RabbitMQ││   Tcp     ││   PicSdk  ││    其他       │
  │Sdk    ││Adapter ││  Adapter  ││  Adapter  ││   Adapter     │
  │Adapter││        ││           ││           ││               │
  └───┬───┘└───┬───┘└─────┬─────┘└─────┬─────┘└───────────────┘
      │        │           │            │
      │        │           │            │
      ▼        ▼           ▼            ▼
  ┌───────┐┌─────────┐┌─────────┐┌───────────┐
  │Media  ││RabbitMQ ││   TCP   ││  PicSdk   │
  │ SDK   ││ 库/SDK  ││ Socket  ││   SDK     │
  │(被适配)││(被适配) ││ (被适配) ││  (被适配)  │
  └───────┘└─────────┘└─────────┘└───────────┘
	```

  2. MediaSdkAdapter - 媒体SDK适配器

  // 目标接口
  class CProcessorBase {
  public:
      virtual int DealWithOneRequest(CMsg& msgReq) = 0;
      virtual int DealWithOneResponse(CMsg& msgRsp) = 0;
      virtual int DealWithOneNotify(CMsg& msgNotify) = 0;
      virtual int DealWithOneTimeOut(unsigned long ulSubID, unsigned long ulTimerID) = 0;
      virtual int startDriver(void) = 0;
      virtual int stopDriver(void) = 0;
  };

  // 适配器：将 MediaSDK 接口适配为 CProcessorBase
  class CMediaSdkAdapter : public CProcessorBase {
  public:
      CMediaSdkAdapter(CProcessorBase *pMsgCenter);

      // 目标接口实现
      virtual int startDriver(void);    // 初始化 MediaSDK
      virtual int stopDriver(void);     // 关闭 MediaSDK
    
      virtual int DealWithOneRequest(CMsg& msgReq);
      virtual int DealWithOneResponse(CMsg& msgRsp);
      virtual int DealWithOneNotify(CMsg& msgNotify);
      virtual int DealWithOneTimeOut(unsigned long ulSubID, unsigned long ulTimerID);
    
      // 额外功能：网络质量检测
      static int GetNetworkQuality(DaoVideoRoutingInfo &stVideoRouting);

  private:
      // 内部持有被适配者
      CMediaSdkClient m_oMediaSdk;    // MediaSDK 客户端
      CSessionMgr     m_ssnMgr;       // 会话管理
      CThreadPool     m_threadPool;   // 线程池
  };

  适配过程：

  ```
	┌─────────────────────────────────────────────────────────────────┐
  │                   CMediaSdkAdapter                              │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ DealWithOneRequest(CMsg& msg)                            │   │
  │  │ {                                                        │   │
  │  │     // 转换：CMsg → MediaSDK 参数                         │   │
  │  │     DealExecRoutTaskReq(msg);                            │   │
  │  │ }                                                        │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
                                │
                                │ 适配转换
                                ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                     MediaSDK (被适配者)                          │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ StartLiveStream()     // 开始直播流                       │   │
  │  │ StopLiveStream()      // 停止直播流                       │   │
  │  │ PullStreamData()      // 拉取流数据                       │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
	```

  3. RabbitMQAdapter - 消息队列适配器

  class CRabbitMQAdapter : public CProcessorBase {
  public:
      CRabbitMQAdapter(CProcessorBase *pMsgCenter);

      // 目标接口实现
      virtual int startDriver();
      virtual int DealWithOneNotify(CMsg& msgNotify);
      virtual int DealWithOneTimeOut(unsigned long ulSubId, unsigned long ulTimerId);

  private:
      // 被适配者：RabbitMQ 配置和队列
      struct RabbitMQConfig stRabbitMqConfig;
      QUEUEMAP m_mapQueue;  // RabbitMQ 队列映射
  };

  // 适配转换：内部消息 → RabbitMQ 消息
  int CRabbitMQAdapter::DealWithOneNotify(CMsg& msgNotify) {
      // 1. 解析内部消息格式
      // 2. 转换为 RabbitMQ 消息格式
      // 3. 调用 RabbitMQ API 发送
  }

  4. TcpAdapter - TCP 通信适配器

  class CTcpAdapter : public CProcessorBase {
  public:
      CTcpAdapter(CProcessorBase *pMsgCenter);

      // 目标接口实现
      virtual int startDriver(void);
      virtual int stopDriver(void);
      virtual int DealWithOneRequest(CMsg& msgReq);
      virtual int DealWithOneResponse(CMsg& msgRsp);
    
      // TCP 特有接口
      int SendAlarm(CMsg &msgAlarm);

  private:
      int DealAddDevReq(CMsg& msgReq);   // 添加设备
      int DealDelDevReq(CMsg& msgReq);   // 删除设备
      int DealMdfDevReq(CMsg& msgReq);   // 修改设备
      int DealQueryDataReq(CMsg &msgReq);// 查询数据
  };

---
  五、适配器模式 vs 其他模式

  ┌────────┬──────────┬───────────┬────────────────────┐
  │  模式  │   目的   │ 接口关系  │      典型场景      │
  ├────────┼──────────┼───────────┼────────────────────┤
  │ 适配器 │ 接口转换 │ 不同接口  │ 集成第三方库       │
  ├────────┼──────────┼───────────┼────────────────────┤
  │ 代理   │ 控制访问 │ 相同接口  │ 延迟加载、权限控制 │
  ├────────┼──────────┼───────────┼────────────────────┤
  │ 装饰器 │ 功能增强 │ 相同接口  │ 动态添加职责       │
  ├────────┼──────────┼───────────┼────────────────────┤
  │ 外观   │ 简化接口 │ 高层接口  │ 隐藏复杂性         │
  ├────────┼──────────┼───────────┼────────────────────┤
  │ 桥接   │ 分离维度 │ 抽象-实现 │ 独立变化           │
  └────────┴──────────┴───────────┴────────────────────┘

  适配器：  Target ← Adapter ← Adaptee (不同接口，转换调用)
  代理：    Subject ← Proxy ← RealSubject (同接口，控制访问)
  装饰器：  Component ← Decorator ← Component (同接口，增强功能)
  外观：    Facade → SubsystemA/B/C (简化高层接口)
  桥接：    Abstraction ←→ Implementor (分离两个维度)

---
  六、两种适配器对比

  ┌──────────┬────────────────┬────────────────┐
  │   特点   │    类适配器    │   对象适配器   │
  ├──────────┼────────────────┼────────────────┤
  │ 实现方式 │ 多重继承       │ 组合           │
  ├──────────┼────────────────┼────────────────┤
  │ 灵活性   │ 低（静态绑定） │ 高（动态绑定） │
  ├──────────┼────────────────┼────────────────┤
  │ 适配范围 │ 只能适配一个类 │ 可适配多个对象 │
  ├──────────┼────────────────┼────────────────┤
  │ 覆盖行为 │ 可以覆盖       │ 需要装饰器配合 │
  ├──────────┼────────────────┼────────────────┤
  │ 推荐度   │ 不推荐         │ 推荐           │
  └──────────┴────────────────┴────────────────┘

  // 类适配器（不推荐）
  class Adapter : public Target, private Adaptee {
      void request() override { specificRequest(); }
  };

  // 对象适配器（推荐）
  class Adapter : public Target {
      Adaptee* m_adaptee;  // 可运行时替换
      void request() override { m_adaptee->specificRequest(); }
  };

---
  七、双向适配器

  // 双向适配器：两个接口互相转换
  class TwoWayAdapter : public TargetA, public TargetB {
  public:
      TwoWayAdapter(TargetA* a = nullptr, TargetB* b = nullptr)
          : m_a(a), m_b(b) {}

      // TargetA 接口
      void requestA() override {
          if (m_b) m_b->requestB();  // A → B
      }
    
      // TargetB 接口
      void requestB() override {
          if (m_a) m_a->requestA();  // B → A
      }

  private:
      TargetA* m_a;
      TargetB* m_b;
  };

---
  八、设计要点

  ┌──────────┬──────────────────────────┐
  │   要点   │           说明           │
  ├──────────┼──────────────────────────┤
  │ 单一职责 │ 适配器只做接口转换       │
  ├──────────┼──────────────────────────┤
  │ 开闭原则 │ 不修改被适配者代码       │
  ├──────────┼──────────────────────────┤
  │ 优先组合 │ 使用对象适配器更灵活     │
  ├──────────┼──────────────────────────┤
  │ 命名清晰 │ 适配器类以 Adapter 结尾  │
  ├──────────┼──────────────────────────┤
  │ 适度使用 │ 新系统应直接设计统一接口 │
  └──────────┴──────────────────────────┘

---
  九、适用场景

  适合使用：
  - 需要使用现有类，但接口不兼容
  - 想要复用一些类，但接口不一致
  - 需要统一多个类的接口
  - 遗留系统升级

  不适合使用：
  - 新系统设计（应直接设计统一接口）
  - 接口差异过大（考虑重构）
  - 只为一处使用（过度设计）

---
  十、实际应用示例

  1. 数据库适配器

  // 目标接口：统一数据库操作
  class IDatabase {
  public:
      virtual void connect(const std::string& url) = 0;
      virtual void execute(const std::string& sql) = 0;
      virtual Result query(const std::string& sql) = 0;
  };

  // MySQL 适配器
  class MySQLAdapter : public IDatabase {
  public:
      void connect(const std::string& url) override {
          mysql_real_connect(m_conn, ...);  // MySQL API
      }
      void execute(const std::string& sql) override {
          mysql_query(m_conn, sql.c_str());
      }
  private:
      MYSQL* m_conn;  // MySQL 被适配者
  };

  // PostgreSQL 适配器
  class PostgreSQLAdapter : public IDatabase {
  public:
      void connect(const std::string& url) override {
          PQconnectdb(url.c_str());  // PostgreSQL API
      }
  private:
      PGconn* m_conn;  // PostgreSQL 被适配者
  };

  // 使用：统一接口，切换数据库无需改代码
  IDatabase* db = new MySQLAdapter();
  db->connect("localhost");
  db->execute("SELECT * FROM users");

  2. 日志适配器

  // 目标接口：统一日志接口
  class ILogger {
  public:
      virtual void info(const std::string& msg) = 0;
      virtual void error(const std::string& msg) = 0;
  };

  // spdlog 适配器
  class SpdlogAdapter : public ILogger {
  public:
      void info(const std::string& msg) override {
          spdlog::info(msg);  // 转换为 spdlog 调用
      }
      void error(const std::string& msg) override {
          spdlog::error(msg);
      }
  };

  // glog 适配器
  class GlogAdapter : public ILogger {
  public:
      void info(const std::string& msg) override {
          LOG(INFO) << msg;  // 转换为 glog 调用
      }
      void error(const std::string& msg) override {
          LOG(ERROR) << msg;
      }
  };

  3. 第三方支付适配器

  // 目标接口：统一支付接口
  class IPayment {
  public:
      virtual bool pay(double amount) = 0;
      virtual bool refund(double amount) = 0;
  };

  // 支付宝适配器
  class AlipayAdapter : public IPayment {
  public:
      bool pay(double amount) override {
          return alipay_trade_pay(amount);  // 支付宝 SDK
      }
  private:
      AlipayClient m_client;
  };

  // 微信支付适配器
  class WechatPayAdapter : public IPayment {
  public:
      bool pay(double amount) override {
          return wechat_jsapi_pay(amount);  // 微信 SDK
      }
  private:
      WechatPayClient m_client;
  };

---
  十一、适配器在 VQRS 中的统一模式

  ┌─────────────────────────────────────────────────────────────────────┐
  │                     VQRS 适配器统一模式                              │
  └─────────────────────────────────────────────────────────────────────┘

  所有适配器遵循相同的模式：

  1. 继承 CProcessorBase（目标接口）
  2. 组合持有被适配对象
  3. 实现消息转换逻辑
  4. 提供统一的 startDriver/stopDriver 生命周期

  ```
	┌─────────────────────────────────────────────────────────────────┐
  │                     CProcessorBase                               │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + startDriver()                                         │   │
  │  │ + stopDriver()                                          │   │
  │  │ + DealWithOneRequest(CMsg&)                             │   │
  │  │ + DealWithOneResponse(CMsg&)                            │   │
  │  │ + DealWithOneNotify(CMsg&)                              │   │
  │  │ + DealWithOneTimeOut(ulSubID, ulTimerID)                │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
              ▲
              │ 继承
      ┌───────┴───────┬───────────────┬───────────────┐
      │               │               │               │
  ┌───┴───────────┐┌───┴───────────┐┌───┴───────────┐
  │MediaSdkAdapter││RabbitMQAdapter││  TcpAdapter   │
  │               ││               ││               │
  │ + startDriver ││ + startDriver ││ + startDriver │
  │   → 初始化SDK  ││   → 连接MQ    ││   → 启动监听  │
  │               ││               ││               │
  │ - m_oMediaSdk ││ - m_mapQueue  ││ - m_socket    │
  │   (被适配者)   ││   (被适配者)   ││   (被适配者)  │
  └───────────────┘└───────────────┘└───────────────┘
	```

  这种设计使得：
  - 统一管理：所有外部组件通过相同接口管理
  - 易于扩展：新增适配器只需实现 CProcessorBase
  - 解耦清晰：业务逻辑与外部 SDK 隔离
  - 便于测试：可以 Mock 适配器进行单元测试
