---
title: "设计模式详解：装饰器模式（Decorator）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 装饰器模式
 一、核心思想

  动态地给对象添加额外职责，比继承更灵活。

  继承方式：类A → 类B(A+v2) → 类C(B+v3)  // 静态，编译时确定
  装饰器：  对象A → 装饰B(A) → 装饰C(A)   // 动态，运行时组合

---
  二、模式结构

  ┌─────────────────────────────────────────────────────────────────┐
  │                   Component (抽象组件)                           │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + operation()   // 公共接口                               │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
              ▲                               ▲
              │                               │
  ┌───────────┴───────────┐       ┌───────────┴───────────┐
  │  ConcreteComponent    │       │      Decorator        │
  │    (具体组件)          │       │     (装饰器基类)       │
  │                       │       │ ┌───────────────────┐ │
  │ + operation()         │       │ │ - component       │ │
  │ { 真实业务逻辑 }        │       │ │ + operation()     │ │
  │                       │       │ │ { 调用component    │ │
  │                       │       │ │   .operation() }  │ │
  │                       │       │ └───────────────────┘ │
  └───────────────────────┘       └───────────────────────┘
                                          ▲
                      ┌───────────────────┼───────────────────┐
                      │                   │                   │
          ┌───────────┴───────────┐ ┌─────┴───────────┐ ┌─────┴───────────┐
          │   ConcreteDecoratorA  │ │ConcreteDecoratorB│ │ConcreteDecoratorC│
          │      (装饰器A)         │ │    (装饰器B)     │ │    (装饰器C)     │
          │ ┌───────────────────┐ │ │ ┌─────────────┐ │ │ ┌─────────────┐ │
          │ │ + addedState      │ │ │ │+ addedState │ │ │ │+ addedState │ │
          │ │ + operation()     │ │ │ │+ operation()│ │ │ │+ operation()│ │
          │ │ {                 │ │ │ │{            │ │ │ │{            │ │
          │ │  新增功能         │ │ │ │ 新增功能    │ │ │ │ 新增功能    │ │
          │ │  component->op()  │ │ │ │component->op│ │ │ │component->op│ │
          │ │ }                 │ │ │ │}            │ │ │ │}            │ │
          │ └───────────────────┘ │ │ └─────────────┘ │ │ └─────────────┘ │
          └───────────────────────┘ └─────────────────┘ └─────────────────┘

---
  三、标准实现

  // 抽象组件
  class Component {
  public:
      virtual ~Component() = default;
      virtual void operation() = 0;
  };

  // 具体组件
  class ConcreteComponent : public Component {
  public:
      void operation() override {
          std::cout << "ConcreteComponent: 基础操作\n";
      }
  };

  // 装饰器基类
  class Decorator : public Component {
  public:
      Decorator(Component* component) : m_component(component) {}

      void operation() override {
          m_component->operation();
      }

  protected:
      Component* m_component;
  };

  // 具体装饰器A
  class ConcreteDecoratorA : public Decorator {
  public:
      ConcreteDecoratorA(Component* component) : Decorator(component) {}

      void operation() override {
          addedBehavior();              // 新增行为
          Decorator::operation();       // 调用原操作
          std::cout << "DecoratorA: 后置处理\n";
      }

  private:
      void addedBehavior() {
          std::cout << "DecoratorA: 前置增强\n";
      }
  };

  // 具体装饰器B
  class ConcreteDecoratorB : public Decorator {
  public:
      ConcreteDecoratorB(Component* component) : Decorator(component) {}

      void operation() override {
          Decorator::operation();
          addedBehavior();              // 后置增强
      }

  private:
      void addedBehavior() {
          std::cout << "DecoratorB: 后置增强\n";
      }
  };

  // 使用示例
  int main() {
      Component* component = new ConcreteComponent();

      // 动态添加装饰
      Component* decorated = new ConcreteDecoratorB(
          new ConcreteDecoratorA(component)
      );
    
      decorated->operation();
      // 输出:
      // DecoratorA: 前置增强
      // ConcreteComponent: 基础操作
      // DecoratorA: 后置处理
      // DecoratorB: 后置增强
    
      delete decorated;  // 需要正确释放
  }

---
  四、装饰器 vs 继承

  继承方式：
  ┌─────────────────────────────────────────────────────────┐
  │                    需要预定义所有组合                      │
  │                                                         │
  │  Stream ──▶ BufferStream ──▶ EncryptedBufferStream     │
  │          ──▶ EncryptedStream ──▶ EncryptedBufferStream  │
  │                                                         │
  │  类数量爆炸：N个功能 = 2^N 个类                           │
  └─────────────────────────────────────────────────────────┘

  装饰器方式：
  ┌─────────────────────────────────────────────────────────┐
  │                    运行时动态组合                         │
  │                                                         │
  │  Stream stream = new EncryptedDecorator(               │
  │                      new BufferDecorator(               │
  │                          new FileStream()               │
  │                      )                                  │
  │                  );                                     │
  │                                                         │
  │  类数量：N个功能 = N个装饰器类                            │
  └─────────────────────────────────────────────────────────┘

---
  五、VQRS 中的类似结构

  1. 算法类继承体系 (AnalyzeAlgorithm.h)

  // 基类
  class CAlgorithm : public AlgorithmCheck {
  public:
      virtual int HandleAlgorithmAnalyse(AlgorithmHandle *pVdsHdlTemp,
                                         DaoVideoRoutingInfo &stVideoRoutingInfo,
                                         int (*asyncResultFunc)(void *),
                                         std::function<void(...)> syncResultFunc);
  };

  // 派生类（类似装饰器扩展功能）
  class CAlgorithmVqa : public CAlgorithm {
  public:
      virtual int HandleAlgorithmAnalyseRules(AlgorithmHandle *pVdsHdlTemp,
                                              DaoVideoRoutingInfo &stVideoRoutingInfo);
  };

  class CAlgorithmAqa : public CAlgorithm { /* 音频算法 */ };
  class CAlgorithmOsd : public CAlgorithm { /* OSD算法 */ };
  class CAlgorithmBigVqa : public CAlgorithm { /* 大模型算法 */ };

  说明：这是继承扩展，不是装饰器。区别在于：
  - 装饰器：运行时动态组合
  - 继承：编译时静态确定

  2. 组合模式中的叶子节点

  // AnComposite / AnLeaf 是组合模式，不是装饰器
  class AnLeaf : public AnComponent {
      virtual int handleComponent(CMsg &msg) = 0;
  };

  class AnComposite : public AnComponent {
      std::list<AnComponent*> m_Chlid;
      virtual int handleComponent(CMsg &msg) {
          for (auto* child : m_Chlid) {
              child->handleComponent(msg);
          }
      }
  };

---
  六、装饰器典型应用场景

  1. I/O 流（经典案例）

  // Java I/O 装饰器模式
  InputStream input = new BufferedInputStream(
                          new GZIPInputStream(
                              new FileInputStream("file.gz")
                          )
                      );

  // C++ 类似实现
  class InputStream {
  public:
      virtual int read() = 0;
  };

  class FileInputStream : public InputStream { /* 文件读取 */ };

  class BufferedInputStream : public InputStream {
      InputStream* source;
  public:
      int read() override {
          // 缓冲逻辑
          return source->read();
      }
  };

  class EncryptedInputStream : public InputStream {
      InputStream* source;
  public:
      int read() override {
          int data = source->read();
          return decrypt(data);  // 解密
      }
  };

  2. 咖啡店示例（Head First 设计模式）

  // 饮料基类
  class Beverage {
  public:
      virtual string getDescription() = 0;
      virtual double cost() = 0;
  };

  // 具体饮料
  class Espresso : public Beverage {
  public:
      string getDescription() { return "浓缩咖啡"; }
      double cost() { return 1.99; }
  };

  // 调料装饰器
  class CondimentDecorator : public Beverage {
  protected:
      Beverage* beverage;
  };

  class Milk : public CondimentDecorator {
  public:
      Milk(Beverage* b) { beverage = b; }
      string getDescription() {
          return beverage->getDescription() + ", 牛奶";
      }
      double cost() { return beverage->cost() + 0.10; }
  };

  class Mocha : public CondimentDecorator {
  public:
      Mocha(Beverage* b) { beverage = b; }
      string getDescription() {
          return beverage->getDescription() + ", 摩卡";
      }
      double cost() { return beverage->cost() + 0.20; }
  };

  // 使用：双倍摩卡加牛奶浓缩咖啡
  Beverage* beverage = new Mocha(
                          new Mocha(
                              new Milk(
                                  new Espresso()
                              )
                          )
                      );
  // cost: 1.99 + 0.10 + 0.20 + 0.20 = 2.49

---
  七、装饰器 vs 其他模式

  ┌────────┬──────────────┬──────────┬────────────────────┐
  │  模式  │     目的     │   关系   │        特点        │
  ├────────┼──────────────┼──────────┼────────────────────┤
  │ 装饰器 │ 动态添加职责 │ 包装同类 │ 接口相同，增强功能 │
  ├────────┼──────────────┼──────────┼────────────────────┤
  │ 代理   │ 控制访问     │ 包装同类 │ 接口相同，控制访问 │
  ├────────┼──────────────┼──────────┼────────────────────┤
  │ 适配器 │ 接口转换     │ 包装异类 │ 接口不同，转换接口 │
  ├────────┼──────────────┼──────────┼────────────────────┤
  │ 外观   │ 简化接口     │ 组合多个 │ 提供高层接口       │
  ├────────┼──────────────┼──────────┼────────────────────┤
  │ 组合   │ 树形结构     │ 组合同类 │ 部分-整体层次      │
  └────────┴──────────────┴──────────┴────────────────────┘

  装饰器：  Component ↔ Decorator (同接口，增强功能)
  代理：    Subject ↔ Proxy (同接口，控制访问)
  适配器：  Target ↔ Adapter → Adaptee (不同接口，转换)
  组合：    Component ↔ Composite (树形结构)

---
  八、装饰器与代理的区别

  // 装饰器：添加功能
  class LoggingDecorator : public Component {
  public:
      void operation() {
          log("before");       // 新增功能
          component->operation();
          log("after");        // 新增功能
      }
  };

  // 代理：控制访问
  class ProtectionProxy : public Subject {
  public:
      void operation() {
          if (!checkPermission()) {  // 控制访问
              throw "Access denied";
          }
          realSubject->operation();  // 不添加新功能
      }
  };

  ┌──────────┬────────────┬──────────────┐
  │   特点   │   装饰器   │     代理     │
  ├──────────┼────────────┼──────────────┤
  │ 目的     │ 添加职责   │ 控制访问     │
  ├──────────┼────────────┼──────────────┤
  │ 对象创建 │ 客户端控制 │ 代理可能创建 │
  ├──────────┼────────────┼──────────────┤
  │ 功能     │ 增强原功能 │ 不改变原功能 │
  ├──────────┼────────────┼──────────────┤
  │ 数量     │ 可多层嵌套 │ 通常单层     │
  └──────────┴────────────┴──────────────┘

---
  九、设计要点

  ┌──────────┬──────────────────────────┐
  │   要点   │           说明           │
  ├──────────┼──────────────────────────┤
  │ 接口一致 │ 装饰器与组件接口相同     │
  ├──────────┼──────────────────────────┤
  │ 保持透明 │ 客户端不知道被装饰       │
  ├──────────┼──────────────────────────┤
  │ 单一职责 │ 每个装饰器只添加一个功能 │
  ├──────────┼──────────────────────────┤
  │ 可叠加   │ 多个装饰器可以嵌套组合   │
  ├──────────┼──────────────────────────┤
  │ 内存管理 │ 注意装饰器链的资源释放   │
  └──────────┴──────────────────────────┘

---
  十、适用场景

  适合使用：
  - 需要动态添加/撤销功能
  - 不希望通过继承产生大量子类
  - 功能可以任意组合
  - 需要在运行时配置对象的行为

  不适合使用：
  - 功能固定，不需要动态组合
  - 装饰器嵌套层数过多（难以调试）
  - 性能敏感场景（多层调用开销）

---
  十一、C++ 实践建议

  使用智能指针管理生命周期

  auto component = std::make_shared<ConcreteComponent>();
  auto decorated = std::make_shared<ConcreteDecoratorA>(component);
  auto finalObj = std::make_shared<ConcreteDecoratorB>(decorated);

  使用函数式装饰器（现代 C++）

  // 函数装饰器
  template<typename Func>
  auto logDecorator(Func func) {
      return [func](auto... args) {
          std::cout << "Before call\n";
          auto result = func(args...);
          std::cout << "After call\n";
          return result;
      };
  }

  // 使用
  auto original = [](int x) { return x * 2; };
  auto decorated = logDecorator(original);
  decorated(5);  // 输出日志 + 执行函数
