---
title: "设计模式详解：原型模式（Prototype）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 原型模式
 一、核心思想

  通过复制现有实例来创建新实例，而不是通过 new 关键字。

  传统方式：new ConcreteClass()  // 需要知道具体类名
  原型模式：prototype->clone()   // 只需知道原型对象

---
  二、模式结构
```

  ┌─────────────────────────────────────────────────────────────────┐
  │                    Prototype (抽象原型)                          │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + clone() : Prototype*   // 克隆自身                     │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
              ▲
              │ 实现
      ┌───────┴───────┬───────────────┐
      │               │               │
  ┌───┴───────────┐┌───┴───────────┐┌───┴───────────┐
  │ConcretePrototype││ConcretePrototype││ConcretePrototype│
  │       A         ││       B         ││       C         │
  │                 ││                 ││                 │
  │ - fieldA        ││ - fieldB        ││ - fieldC        │
  │ + clone()       ││ + clone()       ││ + clone()       │
  │ { return new    ││ { return new    ││ { return new    │
  │   A(*this); }   ││   B(*this); }   ││   C(*this); }   │
  └─────────────────┘└─────────────────┘└─────────────────┘
              ▲
              │ 管理
  ┌───────────┴───────────────────────────────────────────────────┐
  │                    Client (客户端)                              │
  │  ┌─────────────────────────────────────────────────────────┐  │
  │  │ - prototypeMap: map<string, Prototype*>                 │  │
  │  │ + registerPrototype(name, prototype)                    │  │
  │  │ + create(name) → prototypeMap[name]->clone()            │  │
  │  └─────────────────────────────────────────────────────────┘  │
  └────────────────────────────────────────────────────────────────┘

```
---
  三、标准实现

  // 抽象原型
  class Prototype {
  public:
      virtual ~Prototype() = default;
      virtual Prototype* clone() const = 0;
      virtual void use() = 0;
  };

  // 具体原型
  class ConcretePrototype : public Prototype {
  public:
      ConcretePrototype(int value, const std::string& name)
          : m_value(value), m_name(name) {}

      // 拷贝构造函数实现克隆
      ConcretePrototype(const ConcretePrototype& other)
          : m_value(other.m_value), m_name(other.m_name) {
          std::cout << "克隆创建: " << m_name << std::endl;
      }
    
      // 克隆方法
      Prototype* clone() const override {
          return new ConcretePrototype(*this);  // 调用拷贝构造
      }
    
      void use() override {
          std::cout << "使用: " << m_name << ", value=" << m_value << std::endl;
      }

  private:
      int m_value;
      std::string m_name;
  };

  // 原型管理器
  class PrototypeManager {
  public:
      void registerPrototype(const std::string& key, Prototype* proto) {
          m_prototypes[key] = proto;
      }

      Prototype* create(const std::string& key) {
          auto it = m_prototypes.find(key);
          if (it != m_prototypes.end()) {
              return it->second->clone();  // 克隆返回新对象
          }
          return nullptr;
      }

  private:
      std::map<std::string, Prototype*> m_prototypes;
  };

  // 使用
  int main() {
      PrototypeManager manager;

      // 注册原型
      manager.registerPrototype("A", new ConcretePrototype(100, "PrototypeA"));
      manager.registerPrototype("B", new ConcretePrototype(200, "PrototypeB"));
    
      // 克隆创建
      Prototype* obj1 = manager.create("A");  // 克隆 PrototypeA
      Prototype* obj2 = manager.create("B");  // 克隆 PrototypeB
      Prototype* obj3 = manager.create("A");  // 再次克隆 PrototypeA
    
      obj1->use();  // 使用: PrototypeA, value=100
      obj2->use();  // 使用: PrototypeB, value=200
  }

---
  四、浅拷贝 vs 深拷贝

  浅拷贝：复制指针值，多个对象共享同一资源
  深拷贝：复制指针指向的内容，每个对象独立拥有资源

  class ShallowCopy {
  public:
      int* m_data;

      ShallowCopy(int v) : m_data(new int(v)) {}
    
      // 浅拷贝（默认行为）
      ShallowCopy* clone() const {
          return new ShallowCopy(*this);  // m_data 指向同一内存
      }
  };

  class DeepCopy {
  public:
      int* m_data;

      DeepCopy(int v) : m_data(new int(v)) {}
    
      // 深拷贝
      DeepCopy* clone() const {
          DeepCopy* copy = new DeepCopy(*this);
          copy->m_data = new int(*m_data);  // 分配新内存
          return copy;
      }
  };

 ```
  浅拷贝：                    深拷贝：
  ┌──────────┐               ┌──────────┐    ┌──────────┐
  │ Object1  │               │ Object1  │    │ Object2  │
  │ m_data ──┼──┐            │ m_data ──┼──▶ │ m_data ──┼──▶ [100]
  └──────────┘  │            └──────────┘    └──────────┘
  ┌──────────┐  │
  │ Object2  │  │
  │ m_data ──┼──┘ ▶ [100]    两个对象各自拥有独立副本
  └──────────┘
                共享同一资源（危险）
 ```

---
  五、VQRS 原型模式实现

  1. ValueSyntax 语法值原型 (ResultSet/ValueSyntax.h)

  // 抽象原型
  class ValueSyntax {
  public:
      virtual ~ValueSyntax() {}
      virtual uint32 get_syntax() = 0;

      // 原型方法：克隆自身
      virtual ValueSyntax* clone() = 0;
    
      // 类型转换接口
      virtual const int to_long(int &iVal) const = 0;
      virtual const int to_ulong(uint32 &ulVal) const = 0;
      virtual const int to_char(std::string &strVal) const = 0;
  };

  // 具体原型：整型
  class LongSyntax : public ValueSyntax {
  public:
      LongSyntax(int iVal) : m_SnmpInt32(iVal) {}
      LongSyntax(const LongSyntax& val) : m_SnmpInt32(val.m_SnmpInt32) {}

      virtual ValueSyntax* clone() {
          return new LongSyntax(*this);  // 拷贝构造实现克隆
      }

  private:
      int m_SnmpInt32;
  };

  // 具体原型：无符号整型
  class ULongSyntax : public ValueSyntax {
  public:
      ULongSyntax(uint32 ulVal) : m_SnmpUInt32(ulVal) {}
      ULongSyntax(const ULongSyntax& val) : m_SnmpUInt32(val.m_SnmpUInt32) {}

      virtual ValueSyntax* clone() {
          return new ULongSyntax(*this);
      }

  private:
      unsigned int m_SnmpUInt32;
  };

  // 具体原型：字符串
  class StringSyntax : public ValueSyntax {
  public:
      StringSyntax(std::string& strVal) : m_SnmpOctet(strVal) {}
      StringSyntax(const StringSyntax& val) : m_SnmpOctet(val.m_SnmpOctet) {}

      virtual ValueSyntax* clone() {
          return new StringSyntax(*this);
      }

  private:
      std::string m_SnmpOctet;
  };

  // 具体原型：字节
  class ByteSyntax : public ValueSyntax {
  public:
      ByteSyntax(byte* pByte, uint32 ulLen);
      ByteSyntax(const ByteSyntax& val);

      virtual ValueSyntax* clone() {
          return new ByteSyntax(*this);
      }

  private:
      std::string m_SnmpOctet;  // 深拷贝（std::string 自动处理）
  };

  类图：
```
  ┌─────────────────────────────────────────────────────────────────┐
  │                       ValueSyntax                                │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + clone() : ValueSyntax*                                │   │
  │  │ + get_syntax() : uint32                                 │   │
  │  │ + to_long() / to_ulong() / to_char()                    │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
              ▲
      ┌───────┼───────┬───────────────┐
      │       │       │               │
  ┌───┴───────┴───────┴─────────────────────────────────────────────┐
  │                                                                  │
  │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
  │  │ LongSyntax    │ │ ULongSyntax   │ │ StringSyntax  │ │ ByteSyntax    │
  │  │               │ │               │ │               │ │               │
  │  │ - m_SnmpInt32 │ │ - m_SnmpUInt32│ │ - m_SnmpOctet │ │ - m_SnmpOctet │
  │  │ + clone()     │ │ + clone()     │ │ + clone()     │ │ + clone()     │
  │  └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
```
  2. IPlugin 插件原型 (PluginFramework/PluginFactory.h)

  // 插件接口（原型）
  class IPlugin {
  public:
      virtual ~IPlugin() {}

      // 原型方法
      virtual bool IsClone() = 0;       // 是否支持克隆
      virtual IPlugin* clone() = 0;     // 克隆自身
    
      virtual bool IsFactory() = 0;
      virtual void injectSender(CProcessorBase* pSender) = 0;
  };

  // 单例处理器（不支持克隆）
  class CPluginHandlerSingleton : public IPluginHanderSender {
  public:
      virtual bool IsFactory() { return false; }
      virtual bool IsClone() { return false; }
      virtual IPlugin* clone() { return NULL; }  // 不支持克隆
  };

  // 注入插件时根据 IsClone 决定是否克隆
  template<class K>
  int CPluginFactory<K>::injectPlugin(K& key, IPlugin& plugIn, bool bDefault) {
      IPlugin* pPlugin = NULL;

      if (plugIn.IsClone()) {
          pPlugin = plugIn.clone();  // 克隆新实例
      } else {
          pPlugin = &plugIn;         // 使用原实例
      }
    
      m_mapPlugin[key] = pPlugin;
      return 0;
  }

---
  六、原型模式 vs 其他创建模式
```

  ┌──────────┬──────────────┬──────────────────────┐
  │   模式   │   创建方式   │       适用场景       │
  ├──────────┼──────────────┼──────────────────────┤
  │ 工厂方法 │ 子类决定创建 │ 需要延迟到子类       │
  ├──────────┼──────────────┼──────────────────────┤
  │ 抽象工厂 │ 工厂组合创建 │ 创建产品族           │
  ├──────────┼──────────────┼──────────────────────┤
  │ 建造者   │ 分步骤构建   │ 复杂对象构建         │
  ├──────────┼──────────────┼──────────────────────┤
  │ 原型     │ 克隆已有对象 │ 创建成本高、状态相似 │
  └──────────┴──────────────┴──────────────────────┘
	```

  工厂方法：  Product* p = factory->createProduct();
  抽象工厂：  ProductA* a = factory->createA();
             ProductB* b = factory->createB();
  建造者：    Product* p = builder->setA()->setB()->build();
  原型：      Product* p = prototype->clone();

---
  七、原型模式的优点

  ┌──────────┬────────────────────────────────┐
  │   优点   │              说明              │
  ├──────────┼────────────────────────────────┤
  │ 性能优化 │ 复制比创建快（尤其是复杂对象） │
  ├──────────┼────────────────────────────────┤
  │ 简化创建 │ 不需要知道具体类名             │
  ├──────────┼────────────────────────────────┤
  │ 动态添加 │ 运行时注册新原型               │
  ├──────────┼────────────────────────────────┤
  │ 状态保留 │ 克隆保留原对象状态             │
  ├──────────┼────────────────────────────────┤
  │ 避免构造 │ 跳过复杂的构造过程             │
  └──────────┴────────────────────────────────┘

---
  八、设计要点

  ┌────────────┬──────────────────────────────┐
  │    要点    │             说明             │
  ├────────────┼──────────────────────────────┤
  │ 拷贝构造   │ 必须正确实现拷贝构造函数     │
  ├────────────┼──────────────────────────────┤
  │ 深浅拷贝   │ 根据需求选择深拷贝或浅拷贝   │
  ├────────────┼──────────────────────────────┤
  │ clone 方法 │ 通常返回 new Concrete(*this) │
  ├────────────┼──────────────────────────────┤
  │ 原型管理   │ 可用原型管理器统一管理       │
  ├────────────┼──────────────────────────────┤
  │ 内存管理   │ 克隆返回的对象需由调用者释放 │
  └────────────┴──────────────────────────────┘

---
  九、适用场景

  适合使用：
  - 创建对象成本高（复杂初始化）
  - 需要创建大量相似对象
  - 隐藏对象创建细节
  - 运行时动态指定创建类型
  - 需要保留对象状态快照

  不适合使用：
  - 对象简单，直接创建即可
  - 对象间差异大
  - 深拷贝实现困难（循环引用）
  - 类没有拷贝构造函数

---
  十、实际应用示例

  1. 图形编辑器

  class Shape {
  public:
      virtual Shape* clone() const = 0;
      virtual void draw() = 0;
      virtual void move(int x, int y) = 0;
  };

  class Circle : public Shape {
  public:
      Circle(int x, int y, int r) : m_x(x), m_y(y), m_radius(r) {}

      Shape* clone() const override {
          return new Circle(*this);
      }
    
      void draw() override { /* ... */ }
      void move(int x, int y) override { m_x += x; m_y += y; }

  private:
      int m_x, m_y, m_radius;
  };

  // 使用
  Shape* prototype = new Circle(0, 0, 10);
  Shape* copy1 = prototype->clone();  // 复制圆形
  Shape* copy2 = prototype->clone();  // 再次复制

  2. 配置快照

  class Configuration {
  public:
      Configuration* clone() const {
          return new Configuration(*this);
      }

      void setParam(const std::string& key, const std::string& value) {
          m_params[key] = value;
      }

  private:
      std::map<std::string, std::string> m_params;
  };

  // 保存快照
  Configuration* current = new Configuration();
  current->setParam("mode", "production");

  Configuration* snapshot = current->clone();  // 保存快照
  current->setParam("mode", "debug");           // 修改当前配置

  // 可以恢复到快照状态

  3. 线程池任务

  class Task {
  public:
      virtual Task* clone() const = 0;
      virtual void execute() = 0;
  };

  class DataProcessTask : public Task {
  public:
      DataProcessTask(const std::string& data) : m_data(data) {}

      Task* clone() const override {
          return new DataProcessTask(*this);
      }
    
      void execute() override { /* 处理数据 */ }

  private:
      std::string m_data;
  };

  // 多个线程执行相同任务
  Task* taskProto = new DataProcessTask("sample_data");
  for (int i = 0; i < 10; i++) {
      threadPool.submit(taskProto->clone());
  }

---
  十一、C++ 现代实践

  使用智能指针

  class Prototype {
  public:
      virtual std::unique_ptr<Prototype> clone() const = 0;
  };

  class Concrete : public Prototype {
  public:
      std::unique_ptr<Prototype> clone() const override {
          return std::make_unique<Concrete>(*this);
      }
  };

  使用 CRTP 简化

  // CRTP 自动实现 clone
  template<typename Derived>
  class Cloneable {
  public:
      std::unique_ptr<Derived> clone() const {
          return std::make_unique<Derived>(static_cast<const Derived&>(*this));
      }
  };

  class MyClass : public Cloneable<MyClass> {
      // 自动获得 clone() 方法
  };

---
  十二、VQRS 中的使用场景

  // 数据库查询结果使用原型克隆
  class ResultSet {
      std::map<std::string, ValueSyntax*> m_values;

  public:
      // 复制结果集时需要克隆所有值
      ResultSet(const ResultSet& other) {
          for (auto& pair : other.m_values) {
              m_values[pair.first] = pair.second->clone();  // 原型克隆
          }
      }
  };

  原型模式在 VQRS 中的价值：
  - 多态值存储：ValueSyntax 可存储不同类型值
  - 结果集复制：深拷贝保证数据独立
  - 插件管理：支持单例和克隆两种模式
