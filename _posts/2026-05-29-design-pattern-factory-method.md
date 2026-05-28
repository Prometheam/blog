---
title: "设计模式详解：工厂方法模式（Factory Method）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 工厂方法模式

一、核心思想

  定义一个创建对象的接口，但让子类决定实例化哪个类。工厂方法将对象的创建延迟到子类。

  传统方式：客户端直接 new ConcreteProduct()，与具体类耦合
  工厂方法：客户端调用工厂接口，由子类决定创建哪个产品

  本质：将 new 操作封装到子类中，客户端只依赖抽象。

---
  二、模式结构

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                   Creator (抽象工厂/创建者)                       │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + factoryMethod(): Product*    // 工厂方法（抽象）        │   │
  │  │ + someOperation()              // 使用产品的业务方法      │   │
  │  │ {                                                        │   │
  │  │   Product* p = factoryMethod();  // 调用工厂方法          │   │
  │  │   p->doStuff();                                          │   │
  │  │ }                                                        │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
              ▲                                   ▲
              │                                   │
  ┌───────────┴───────────┐       ┌───────────────┴───────────────┐
  │  ConcreteCreatorA     │       │       ConcreteCreatorB         │
  │  ┌─────────────────┐  │       │  ┌─────────────────────────┐  │
  │  │ factoryMethod() │  │       │  │ factoryMethod()          │  │
  │  │ {               │  │       │  │ {                        │  │
  │  │   return new    │  │       │  │   return new             │  │
  │  │   ProductA();   │  │       │  │   ProductB();            │  │
  │  │ }               │  │       │  │ }                        │  │
  │  └─────────────────┘  │       │  └─────────────────────────┘  │
  └────────────────────────┘       └───────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │                    Product (抽象产品)                             │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + doStuff()   // 产品接口                                │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
              ▲                                   ▲
              │                                   │
  ┌───────────┴───────────┐       ┌───────────────┴───────────┐
  │     ProductA          │       │        ProductB            │
  └───────────────────────┘       └────────────────────────────┘
```

---
  三、简单工厂 vs 工厂方法

```
  ┌──────────────┬─────────────────────────┬───────────────────────────┐
  │     维度     │       简单工厂           │        工厂方法            │
  ├──────────────┼─────────────────────────┼───────────────────────────┤
  │ 工厂数量     │ 一个工厂类               │ 每种产品对应一个工厂       │
  ├──────────────┼─────────────────────────┼───────────────────────────┤
  │ 创建逻辑     │ if-else/switch 集中判断  │ 子类各自实现               │
  ├──────────────┼─────────────────────────┼───────────────────────────┤
  │ 开闭原则     │ ❌ 新增产品需修改工厂    │ ✅ 新增工厂子类即可        │
  ├──────────────┼─────────────────────────┼───────────────────────────┤
  │ 复杂度       │ 简单                     │ 类数量较多                 │
  ├──────────────┼─────────────────────────┼───────────────────────────┤
  │ 适用场景     │ 产品种类少且稳定         │ 产品种类多且可能扩展       │
  └──────────────┴─────────────────────────┴───────────────────────────┘
```

---
  四、标准实现

```cpp
#include <memory>
#include <string>
#include <iostream>

// 抽象产品
class Transport {
public:
    virtual ~Transport() = default;
    virtual void deliver(const std::string& cargo) = 0;
    virtual double cost() const = 0;
};

// 具体产品A
class Truck : public Transport {
public:
    void deliver(const std::string& cargo) override {
        std::cout << "卡车运输: " << cargo << " (陆运)\n";
    }
    double cost() const override { return 10.0; }  // 每公里
};

// 具体产品B
class Ship : public Transport {
public:
    void deliver(const std::string& cargo) override {
        std::cout << "轮船运输: " << cargo << " (海运)\n";
    }
    double cost() const override { return 5.0; }
};

// 具体产品C
class Airplane : public Transport {
public:
    void deliver(const std::string& cargo) override {
        std::cout << "飞机运输: " << cargo << " (空运)\n";
    }
    double cost() const override { return 50.0; }
};

// 抽象工厂（Creator）
class Logistics {
public:
    virtual ~Logistics() = default;

    // 工厂方法：由子类决定创建哪种运输工具
    virtual std::unique_ptr<Transport> createTransport() = 0;

    // 业务逻辑：使用工厂方法创建的产品
    void planDelivery(const std::string& cargo) {
        auto transport = createTransport();
        std::cout << "运费: " << transport->cost() << "/km\n";
        transport->deliver(cargo);
    }
};

// 具体工厂A
class RoadLogistics : public Logistics {
public:
    std::unique_ptr<Transport> createTransport() override {
        return std::make_unique<Truck>();
    }
};

// 具体工厂B
class SeaLogistics : public Logistics {
public:
    std::unique_ptr<Transport> createTransport() override {
        return std::make_unique<Ship>();
    }
};

// 具体工厂C
class AirLogistics : public Logistics {
public:
    std::unique_ptr<Transport> createTransport() override {
        return std::make_unique<Airplane>();
    }
};

// 使用
int main() {
    std::unique_ptr<Logistics> logistics;

    std::string route = "international";
    if (route == "local") {
        logistics = std::make_unique<RoadLogistics>();
    } else if (route == "international") {
        logistics = std::make_unique<SeaLogistics>();
    } else {
        logistics = std::make_unique<AirLogistics>();
    }

    logistics->planDelivery("电子产品");
    return 0;
}
```

---
  五、参数化工厂方法

  当工厂需要根据参数创建不同产品时：

```cpp
// 参数化工厂（介于简单工厂和工厂方法之间）
class TransportFactory {
public:
    enum class Type { TRUCK, SHIP, AIRPLANE };

    static std::unique_ptr<Transport> create(Type type) {
        switch (type) {
            case Type::TRUCK:    return std::make_unique<Truck>();
            case Type::SHIP:     return std::make_unique<Ship>();
            case Type::AIRPLANE: return std::make_unique<Airplane>();
        }
        throw std::invalid_argument("Unknown transport type");
    }
};

// 注册式工厂（完全符合开闭原则）
class TransportRegistry {
    using Creator = std::function<std::unique_ptr<Transport>()>;
    std::unordered_map<std::string, Creator> creators_;

public:
    void registerType(const std::string& name, Creator creator) {
        creators_[name] = std::move(creator);
    }

    std::unique_ptr<Transport> create(const std::string& name) {
        auto it = creators_.find(name);
        if (it == creators_.end()) {
            throw std::runtime_error("Unknown type: " + name);
        }
        return it->second();
    }
};

// 使用注册式工厂
TransportRegistry registry;
registry.registerType("truck", []{ return std::make_unique<Truck>(); });
registry.registerType("ship", []{ return std::make_unique<Ship>(); });
// 新增类型无需修改工厂代码！
registry.registerType("drone", []{ return std::make_unique<Drone>(); });
```

---
  六、实际应用场景

  1. 日志框架

```cpp
// 抽象日志器
class ILogger {
public:
    virtual ~ILogger() = default;
    virtual void log(const std::string& msg) = 0;
};

class FileLogger : public ILogger {
    std::ofstream file_;
public:
    FileLogger(const std::string& path) : file_(path, std::ios::app) {}
    void log(const std::string& msg) override { file_ << msg << "\n"; }
};

class ConsoleLogger : public ILogger {
public:
    void log(const std::string& msg) override { std::cout << msg << "\n"; }
};

class NetworkLogger : public ILogger {
    std::string server_;
public:
    NetworkLogger(const std::string& server) : server_(server) {}
    void log(const std::string& msg) override { /* 发送到远程 */ }
};

// 工厂方法
class LoggerFactory {
public:
    virtual ~LoggerFactory() = default;
    virtual std::unique_ptr<ILogger> createLogger() = 0;
};

class FileLoggerFactory : public LoggerFactory {
    std::string path_;
public:
    FileLoggerFactory(const std::string& path) : path_(path) {}
    std::unique_ptr<ILogger> createLogger() override {
        return std::make_unique<FileLogger>(path_);
    }
};
```

  2. 数据库连接工厂

```cpp
class IConnection {
public:
    virtual ~IConnection() = default;
    virtual void connect(const std::string& connStr) = 0;
    virtual void execute(const std::string& sql) = 0;
    virtual void close() = 0;
};

class MySQLConnection : public IConnection { /* ... */ };
class PostgreSQLConnection : public IConnection { /* ... */ };
class SQLiteConnection : public IConnection { /* ... */ };

// 工厂方法：根据配置决定创建哪种连接
class ConnectionFactory {
public:
    virtual std::unique_ptr<IConnection> createConnection() = 0;
};

class MySQLFactory : public ConnectionFactory {
public:
    std::unique_ptr<IConnection> createConnection() override {
        return std::make_unique<MySQLConnection>();
    }
};
```

---
  七、vs 其他模式

```
  ┌────────────────┬──────────────────────────────────────────────┐
  │    对比模式    │              区别                             │
  ├────────────────┼──────────────────────────────────────────────┤
  │ 简单工厂      │ 一个工厂创建所有产品 vs 每种产品一个工厂     │
  ├────────────────┼──────────────────────────────────────────────┤
  │ 抽象工厂      │ 工厂方法创建一种产品，抽象工厂创建产品家族   │
  ├────────────────┼──────────────────────────────────────────────┤
  │ 模板方法      │ 工厂方法是模板方法的特化（创建步骤延迟到子类）│
  ├────────────────┼──────────────────────────────────────────────┤
  │ 原型          │ 工厂方法通过继承创建，原型通过克隆创建        │
  └────────────────┴──────────────────────────────────────────────┘
```

---
  八、何时使用

  ✅ 适用场景：
  - 不确定需要创建的对象的确切类型
  - 希望为库或框架的用户提供扩展点
  - 需要复用已有对象而非每次创建新对象

  ❌ 不适用场景：
  - 产品种类少且不会变化（简单工厂就够）
  - 创建逻辑极其简单（直接 new 即可）
  - 引入工厂层级会过度设计

---
  九、设计要点

  1. 工厂方法的返回类型应该是抽象产品（指针/引用）
  2. 优先使用 std::unique_ptr 管理产品生命周期
  3. 当工厂方法有默认实现时，Creator 不必是纯抽象类
  4. 参数化工厂方法是简单工厂和工厂方法的折中
  5. 注册式工厂完全满足开闭原则，是大型系统的首选
