---
title: "设计模式详解：外观模式（Facade）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 外观模式
一、核心思想

  为子系统中的一组接口提供一个统一的高层接口，简化客户端调用。

  传统方式：客户端 → 子系统A → 子系统B → 子系统C → ...
  外观模式：客户端 → 外观类 → 子系统A/B/C（内部协调）

---
  二、模式结构

  ┌─────────────────────────────────────────────────────────────────┐
  │                          Client                                  │
  └─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                        Facade (外观)                             │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ - subsystemA: SubsystemA                                 │   │
  │  │ - subsystemB: SubsystemB                                 │   │
  │  │ - subsystemC: SubsystemC                                 │   │
  │  │ + simpleOperation()  // 简化的统一接口                    │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
                │                │                │
                ▼                ▼                ▼
  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
  │   SubsystemA    │  │   SubsystemB    │  │   SubsystemC    │
  │   (子系统A)      │  │   (子系统B)      │  │   (子系统C)      │
  │ + operationA()  │  │ + operationB()  │  │ + operationC()  │
  └─────────────────┘  └─────────────────┘  └─────────────────┘

---
  三、标准实现

  // 子系统 A
  class SubsystemA {
  public:
      void operationA() {
          std::cout << "SubsystemA: 操作A\n";
      }
  };

  // 子系统 B
  class SubsystemB {
  public:
      void operationB() {
          std::cout << "SubsystemB: 操作B\n";
      }
  };

  // 子系统 C
  class SubsystemC {
  public:
      void operationC() {
          std::cout << "SubsystemC: 操作C\n";
      }
  };

  // 外观类
  class Facade {
  public:
      Facade() {
          m_subsystemA = new SubsystemA();
          m_subsystemB = new SubsystemB();
          m_subsystemC = new SubsystemC();
      }

      ~Facade() {
          delete m_subsystemA;
          delete m_subsystemB;
          delete m_subsystemC;
      }
    
      // 简化的统一接口
      void simpleOperation() {
          m_subsystemA->operationA();
          m_subsystemB->operationB();
          m_subsystemC->operationC();
      }
    
      void anotherOperation() {
          m_subsystemB->operationB();
          m_subsystemC->operationC();
      }

  private:
      SubsystemA* m_subsystemA;
      SubsystemB* m_subsystemB;
      SubsystemC* m_subsystemC;
  };

  // 客户端使用
  int main() {
      Facade facade;
      facade.simpleOperation();  // 一行调用完成复杂操作
  }

---
  四、VQRS 中的外观模式实现

  1. CNmsServer - 系统级外观

  class CNmsServer {
  public:
      // 统一的服务入口
      int StartService();    // 启动所有子系统
      int StopService();     // 停止所有子系统

      // 简化的配置访问接口
      string getRabbitMqHost() const;
      string getDbHost() const;
      int getDbPort() const;
      int GetStreamTime(void);
      int GetStep(void);
      // ... 大量 getter 方法

  private:
      // 隐藏的复杂子系统
      CTpServer*              m_pTpServer;
      CConfigManager*         m_pConfigMgr;
      CRunLog*                m_pRunLog;
      CTcpAdapter*            m_pTcpAdapter;
      CRabbitMQAdapter*       m_pRabbitMQAdapter;
      CMediaSdkAdapter*       m_pMediaSDKAdapter;
      CVideoRoutingManager*   m_pVideoRoutingManage;
      CVideoRoutingExec*      m_pVideoRoutingExec;
      CVideoAnalyzeManager*   m_pVideoAnalyzeManage;
      CVideoDecodeManager*    m_pVideoDecodeManage;
      CPicSdkAdapter*         m_pPicSDKAdapter;
      CPicAnalyzeManager*     m_pPicAnalyzeManager;
      CLicenseManage*         m_pLicenseManage;
  };

  架构图：

  ┌─────────────────────────────────────────────────────────────────────┐
  │                           CNmsServer (外观)                          │
  │  ┌───────────────────────────────────────────────────────────────┐ │
  │  │  StartService() / StopService() / getXXX() / GetXXX()         │ │
  │  └───────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────────┘
      │      │      │       │       │       │       │
      ▼      ▼      ▼       ▼       ▼       ▼       ▼
  ┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐
  │TpSvr ││CfgMgr││TcpAdp││RbMq  ││Media ││Video ││Decode│
  └──────┘└──────┘└──────┘└──────┘└──────┘└──────┘└──────┘

  2. CVideoAnalyzeManager - 分析任务外观

  // 多个子任务（叶子节点）
  class CAnalyzeTask : public AnComposite {
  private:
      CAnalyzeTaskAudioDia    m_oTaskAudioDia;      // 音频诊断
      CAnalyzeTaskPullStream  m_oTaskPullStream;    // 拉流
      CAnalyzeTaskVideoDia    m_oTaskVideoDia;      // 视频诊断
      CAnalyzeTaskVideoBigDia m_oTaskVideoBigDia;   // 大模型诊断
      CAnalyzeTaskOsd         m_oTaskOsdCaption;    // OSD检测
      CAnalyzeTaskBitStream   m_oTaskBitStream;     // 码流分析
      CAnalyzeTaskNetworDia   m_oTaskNetworkDia;    // 网络诊断
      CAnalyzeTaskLinkDia     m_oTaskLinkDia;       // 链路诊断
  };

  // 外观类
  class CVideoAnalyzeManager : public CProcessorBase {
  public:
      int startDriver(void);   // 初始化所有分析任务
      int stopDriver(void);    // 停止所有分析任务

  private:
      CAnalyzeTaskBase m_oAnlyzeTaskBase;  // 组合所有任务
  };

  分析任务流水线：

  ┌─────────────────────────────────────────────────────────────────┐
  │              CVideoAnalyzeManager (外观)                         │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │  startDriver() → Init() → 启动所有分析任务               │   │
  │  │  DealWithOneRequest() → 分发到对应任务                   │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
                                │
      ┌────────┬────────┬───────┴───────┬────────┬────────┐
      ▼        ▼        ▼               ▼        ▼        ▼
  ┌───────┐┌───────┐┌───────┐     ┌───────┐┌───────┐┌───────┐
  │AudioDia││VideoDia││BigDia │     │  OSD  ││BitStrm││Network│
  │(音频)  ││(视频)  ││(大模型)│     │(字幕) ││(码流) ││(网络) │
  └───────┘└───────┘└───────┘     └───────┘└───────┘└───────┘

---
  五、外观模式 vs 其他模式

  ┌────────┬──────────────────────┬────────────────┐
  │  模式  │         目的         │      关系      │
  ├────────┼──────────────────────┼────────────────┤
  │ 外观   │ 简化接口，隐藏复杂性 │ 组合子系统     │
  ├────────┼──────────────────────┼────────────────┤
  │ 代理   │ 控制访问，添加功能   │ 代理单个对象   │
  ├────────┼──────────────────────┼────────────────┤
  │ 装饰器 │ 动态添加职责         │ 包装同类对象   │
  ├────────┼──────────────────────┼────────────────┤
  │ 适配器 │ 接口转换             │ 包装不兼容接口 │
  ├────────┼──────────────────────┼────────────────┤
  │ 中介者 │ 对象间通信解耦       │ 集中协调交互   │
  └────────┴──────────────────────┴────────────────┘

  外观：   Client → Facade → SubsystemA + SubsystemB (简化调用)
  代理：   Client → Proxy → RealSubject (控制访问)
  装饰器： Client → Decorator → Component (增强功能)
  适配器： Client → Adapter → Adaptee (接口转换)
  中介者： Client → Mediator ↔ ColleagueA/B (协调交互)

---
  六、外观模式的层次

  ┌─────────────────────────────────────────────────────────────┐
  │                     Presentation Layer                       │
  │                      (表现层/界面层)                          │
  └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                      Facade Layer                            │
  │                      (外观层/业务门面)                        │
  │  ┌─────────────────────────────────────────────────────┐   │
  │  │  为上层提供粗粒度的服务接口，屏蔽下层复杂性            │   │
  │  └─────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                      Business Layer                          │
  │                      (业务逻辑层)                            │
  └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                      Data Access Layer                       │
  │                      (数据访问层)                            │
  └─────────────────────────────────────────────────────────────┘

---
  七、设计要点

  ┌────────────┬──────────────────────────────────────────┐
  │    要点    │                   说明                   │
  ├────────────┼──────────────────────────────────────────┤
  │ 单一职责   │ 外观类只做委托，不包含业务逻辑           │
  ├────────────┼──────────────────────────────────────────┤
  │ 不限制访问 │ 外观提供简化接口，但不阻止直接访问子系统 │
  ├────────────┼──────────────────────────────────────────┤
  │ 可扩展     │ 可以为特定场景添加新的外观类             │
  ├────────────┼──────────────────────────────────────────┤
  │ 层次清晰   │ 避免外观类之间的循环依赖                 │
  └────────────┴──────────────────────────────────────────┘

---
  八、适用场景

  适合使用：
  - 需要为复杂子系统提供简单接口
  - 客户端与子系统之间存在大量依赖
  - 需要分层架构，隔离各层
  - 遗留系统需要简化接口

  不适合使用：
  - 子系统本就简单
  - 外观类变成"上帝对象"
  - 客户端需要完全控制子系统

---
  九、实际应用示例

  数据库访问外观

  class DatabaseFacade {
  public:
      // 简化的数据库操作接口
      bool insertUser(const User& user) {
          return m_connection->execute(
              m_builder->buildInsert("users", user)
          );
      }

      User findUser(int id) {
          auto result = m_connection->query(
              m_builder->buildSelect("users", {"id", id})
          );
          return m_mapper->mapToUser(result);
      }

  private:
      Connection*  m_connection;   // 连接管理
      QueryBuilder* m_builder;      // SQL构建器
      ObjectMapper* m_mapper;       // 对象映射
  };

  // 客户端无需了解连接池、SQL构建、映射等细节
  User user = dbFacade.findUser(123);

  编译器外观

  class CompilerFacade {
  public:
      bool compile(const string& sourceFile, const string& outputFile) {
          // 隐藏复杂的编译流程
          string code = m_preprocessor->process(sourceFile);
          AST ast = m_parser->parse(code);
          IR ir = m_optimizer->optimize(ast);
          return m_codegen->generate(ir, outputFile);
      }

  private:
      Preprocessor* m_preprocessor;
      Parser*       m_parser;
      Optimizer*    m_optimizer;
      CodeGenerator* m_codegen;
  };

  // 客户端一行代码完成编译
  compiler.compile("main.cpp", "main.exe");

---
  十、外观模式的变体

  ┌──────────┬──────────────────────────────┐
  │   变体   │             说明             │
  ├──────────┼──────────────────────────────┤
  │ 最小外观 │ 只提供最常用的操作           │
  ├──────────┼──────────────────────────────┤
  │ 多个外观 │ 为不同客户端提供不同外观     │
  ├──────────┼──────────────────────────────┤
  │ 外观链   │ 外观类调用其他外观类         │
  ├──────────┼──────────────────────────────┤
  │ 动态外观 │ 根据配置选择不同的子系统组合 │
  └──────────┴──────────────────────────────┘
