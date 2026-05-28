---
title: "设计模式详解：建造者模式（Builder）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 建造者模式
一、核心思想

  将复杂对象的构建与表示分离，使同样的构建过程可以创建不同的表示。

  传统方式：构造函数参数过多，难以理解和维护
  建造者：  分步骤构建，清晰灵活

---
  二、模式结构
```

  ┌─────────────────────────────────────────────────────────────────┐
  │                      Director (指挥者)                          │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ - builder: Builder                                       │   │
  │  │ + construct()                                            │   │
  │  │ {                                                        │   │
  │  │   builder->buildPartA();                                 │   │
  │  │   builder->buildPartB();                                 │   │
  │  │   builder->buildPartC();                                 │   │
  │  │   return builder->getResult();                           │   │
  │  │ }                                                        │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
                                │
                                │ 使用
                                ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                      Builder (抽象建造者)                        │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + buildPartA() = 0                                       │   │
  │  │ + buildPartB() = 0                                       │   │
  │  │ + buildPartC() = 0                                       │   │
  │  │ + getResult() : Product* = 0                             │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
              ▲                               ▲
              │                               │
  ┌───────────┴───────────┐       ┌───────────┴───────────┐
  │   ConcreteBuilderA    │       │   ConcreteBuilderB    │
  │      (建造者A)         │       │      (建造者B)         │
  │ ┌───────────────────┐ │       │ ┌───────────────────┐ │
  │  │ - product        │ │       │  │ - product        │ │
  │  │ + buildPartA()   │ │       │  │ + buildPartA()   │ │
  │  │ + buildPartB()   │ │       │  │ + buildPartB()   │ │
  │  │ + getResult()    │ │       │  │ + getResult()    │ │
  │  └───────────────────┘ │       │  └───────────────────┘ │
  └───────────────────────┘       └───────────────────────┘
              │                               │
              ▼                               ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                       Product (产品)                             │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ - partA                                                 │   │
  │  │ - partB                                                 │   │
  │  │ - partC                                                 │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘

```
---
  三、标准实现

  1. 经典建造者模式

  // 产品类
  class Computer {
  public:
      std::string m_cpu;
      std::string m_ram;
      std::string m_storage;
      std::string m_gpu;

      void show() {
          std::cout << "CPU: " << m_cpu << "\n";
          std::cout << "RAM: " << m_ram << "\n";
          std::cout << "Storage: " << m_storage << "\n";
          std::cout << "GPU: " << m_gpu << "\n";
      }
  };

  // 抽象建造者
  class ComputerBuilder {
  public:
      virtual ~ComputerBuilder() = default;
      virtual void buildCPU() = 0;
      virtual void buildRAM() = 0;
      virtual void buildStorage() = 0;
      virtual void buildGPU() = 0;
      virtual Computer* getResult() = 0;
  };

  // 具体建造者：办公电脑
  class OfficeComputerBuilder : public ComputerBuilder {
  public:
      OfficeComputerBuilder() { m_computer = new Computer(); }

      void buildCPU() override { m_computer->m_cpu = "Intel i5"; }
      void buildRAM() override { m_computer->m_ram = "8GB"; }
      void buildStorage() override { m_computer->m_storage = "256GB SSD"; }
      void buildGPU() override { m_computer->m_gpu = "Integrated"; }
    
      Computer* getResult() override { return m_computer; }

  private:
      Computer* m_computer;
  };

  // 具体建造者：游戏电脑
  class GamingComputerBuilder : public ComputerBuilder {
  public:
      GamingComputerBuilder() { m_computer = new Computer(); }

      void buildCPU() override { m_computer->m_cpu = "Intel i9"; }
      void buildRAM() override { m_computer->m_ram = "32GB"; }
      void buildStorage() override { m_computer->m_storage = "1TB NVMe"; }
      void buildGPU() override { m_computer->m_gpu = "RTX 4090"; }
    
      Computer* getResult() override { return m_computer; }

  private:
      Computer* m_computer;
  };

  // 指挥者
  class ComputerDirector {
  public:
      Computer* construct(ComputerBuilder* builder) {
          builder->buildCPU();
          builder->buildRAM();
          builder->buildStorage();
          builder->buildGPU();
          return builder->getResult();
      }
  };

  // 使用
  int main() {
      ComputerDirector director;

      ComputerBuilder* officeBuilder = new OfficeComputerBuilder();
      Computer* officePC = director.construct(officeBuilder);
    
      ComputerBuilder* gamingBuilder = new GamingComputerBuilder();
      Computer* gamingPC = director.construct(gamingBuilder);
  }

  2. 链式建造者（Fluent Builder，推荐）

  class HttpRequest {
  public:
      std::string m_url;
      std::string m_method;
      std::map<std::string, std::string> m_headers;
      std::string m_body;
      int m_timeout;

      // 建造者类
      class Builder {
      public:
          Builder(const std::string& url) : m_url(url), m_method("GET"), m_timeout(30) {}
    
          // 链式方法
          Builder& method(const std::string& method) {
              m_method = method;
              return *this;
          }
    
          Builder& header(const std::string& key, const std::string& value) {
              m_headers[key] = value;
              return *this;
          }
    
          Builder& body(const std::string& body) {
              m_body = body;
              return *this;
          }
    
          Builder& timeout(int timeout) {
              m_timeout = timeout;
              return *this;
          }
    
          // 构建产品
          HttpRequest build() {
              return HttpRequest(*this);
          }
    
      private:
          friend class HttpRequest;
          std::string m_url;
          std::string m_method;
          std::map<std::string, std::string> m_headers;
          std::string m_body;
          int m_timeout;
      };

  private:
      HttpRequest(const Builder& b)
          : m_url(b.m_url), m_method(b.m_method),
            m_headers(b.m_headers), m_body(b.m_body), m_timeout(b.m_timeout) {}
  };

  // 使用：链式调用
  HttpRequest request = HttpRequest::Builder("https://api.example.com")
      .method("POST")
      .header("Content-Type", "application/json")
      .header("Authorization", "Bearer token")
      .body("{\"name\":\"test\"}")
      .timeout(60)
      .build();

---
  四、构造函数 vs 建造者

  // 构造函数：参数多时难以理解
  Computer pc1("Intel i5", "8GB", "256GB SSD", "Integrated");
  Computer pc2("Intel i9", "32GB", "1TB NVMe", "RTX 4090");
  // 问题：参数顺序难以记忆，可选参数怎么办？

  // 重载构造函数：组合爆炸
  Computer(std::string cpu);
  Computer(std::string cpu, std::string ram);
  Computer(std::string cpu, std::string ram, std::string storage);
  // 问题：需要定义大量构造函数

  // 建造者：清晰灵活
  Computer pc = Computer::Builder()
      .setCPU("Intel i5")
      .setRAM("8GB")
      .setGPU("Integrated")  // 可选，跳过 storage
      .build();

---
  五、VQRS 中的类似模式

  1. 消息构建（类似建造者思想）

  // 消息类
  class CMsg : public Envelope {
  public:
      uint32 ulSrcID;
      uint32 ulDstID;
      uint32 ulOperID;
      uint32 ulResult;
      // ... 更多字段

      void CreateMsgAck(const CMsg& msgReq, int nResult = 0);
      void copyMsgHead(const CMsg &msg);
  };

  // 消息构建过程（分步骤设置）
  CMsg msgReq;
  msgReq.ulSrcID = MODULE_A;
  msgReq.ulDstID = MODULE_B;
  msgReq.ulOperID = OPER_GET_DATA;
  msgReq.ulMsgType = MSG_TYPE_REQUEST;
  msgReq.stEnvelope.addIE(ieData);  // 添加数据

  2. VQRS 中可改进的建造者应用

  // 当前方式：分散设置
  CMsg msg;
  msg.ulSrcID = MODULE_A;
  msg.ulDstID = MODULE_B;
  msg.ulOperID = OPER_GET_DATA;
  msg.ulMsgType = MSG_TYPE_REQUEST;
  msg.ulResult = 0;

  // 改进：链式建造者
  class CMsgBuilder {
  public:
      CMsgBuilder& from(uint32 srcID) {
          m_msg.ulSrcID = srcID;
          return *this;
      }

      CMsgBuilder& to(uint32 dstID) {
          m_msg.ulDstID = dstID;
          return *this;
      }
    
      CMsgBuilder& oper(uint32 operID) {
          m_msg.ulOperID = operID;
          return *this;
      }
    
      CMsgBuilder& type(uint32 msgType) {
          m_msg.ulMsgType = msgType;
          return *this;
      }
    
      CMsgBuilder& addIE(IE& ie) {
          m_msg.stEnvelope.addIE(ie);
          return *this;
      }
    
      CMsg build() { return m_msg; }

  private:
      CMsg m_msg;
  };

  // 使用
  CMsg msg = CMsgBuilder()
      .from(MODULE_A)
      .to(MODULE_B)
      .oper(OPER_GET_DATA)
      .type(MSG_TYPE_REQUEST)
      .addIE(ieData)
      .build();

---
  六、建造者 vs 其他创建模式
```
  ┌──────────┬────────────┬──────────────┬────────────────────┐
  │   模式   │  创建方式  │    关注点    │      适用场景      │
  ├──────────┼────────────┼──────────────┼────────────────────┤
  │ 工厂方法 │ 一次性创建 │ 创建哪个类   │ 类的种类多变       │
  ├──────────┼────────────┼──────────────┼────────────────────┤
  │ 抽象工厂 │ 产品族创建 │ 产品组合     │ 创建相关对象族     │
  ├──────────┼────────────┼──────────────┼────────────────────┤
  │ 建造者   │ 分步构建   │ 构建过程     │ 复杂对象，步骤固定 │
  ├──────────┼────────────┼──────────────┼────────────────────┤
  │ 原型     │ 克隆复制   │ 复制现有对象 │ 创建成本高         │
  └──────────┴────────────┴──────────────┴────────────────────┘
```
  工厂方法：  Product* p = factory->createProduct(type);
  抽象工厂：  ProductA* a = factory->createA();
             ProductB* b = factory->createB();
  建造者：    Product* p = builder->setA()->setB()->setC()->build();
  原型：      Product* p = prototype->clone();

---
  七、建造者模式变体

  1. 内部建造者类（推荐）

  class Configuration {
  public:
      class Builder {
      public:
          Builder& host(const std::string& h) { m_host = h; return *this; }
          Builder& port(int p) { m_port = p; return *this; }
          Builder& ssl(bool s) { m_ssl = s; return *this; }
          Configuration build() { return Configuration(*this); }

      private:
          friend class Configuration;
          std::string m_host = "localhost";
          int m_port = 80;
          bool m_ssl = false;
      };

  private:
      Configuration(const Builder& b) : m_host(b.m_host), m_port(b.m_port), m_ssl(b.m_ssl) {}
      std::string m_host;
      int m_port;
      bool m_ssl;
  };

  2. 带验证的建造者

  class User {
  public:
      class Builder {
      public:
          Builder& name(const std::string& n) { m_name = n; return *this; }
          Builder& email(const std::string& e) { m_email = e; return *this; }
          Builder& age(int a) { m_age = a; return *this; }

          User build() {
              validate();
              return User(*this);
          }
    
      private:
          void validate() {
              if (m_name.empty()) throw std::invalid_argument("name required");
              if (m_email.find('@') == std::string::npos)
                  throw std::invalid_argument("invalid email");
              if (m_age < 0 || m_age > 150)
                  throw std::invalid_argument("invalid age");
          }
    
          friend class User;
          std::string m_name;
          std::string m_email;
          int m_age = 0;
      };
  };

---
  八、设计要点

 ```
  ┌────────────┬────────────────────────────┐
  │    要点    │            说明            │
  ├────────────┼────────────────────────────┤
  │ 分步构建   │ 将复杂构建分解为多个步骤   │
  ├────────────┼────────────────────────────┤
  │ 相同过程   │ 不同建造者使用相同构建步骤 │
  ├────────────┼────────────────────────────┤
  │ 隐藏细节   │ 客户端不需要知道内部结构   │
  ├────────────┼────────────────────────────┤
  │ 链式调用   │ 返回 *this 实现流式接口    │
  ├────────────┼────────────────────────────┤
  │ 不可变对象 │ 构建完成后对象不可修改     │
  └────────────┴────────────────────────────┘
 ```

---
  九、适用场景

  适合使用：
  - 对象有很多可选参数
  - 构建过程分多个步骤
  - 需要创建不同表示的对象
  - 参数有验证逻辑
  - 创建不可变对象

  不适合使用：
  - 对象简单，参数少
  - 不需要分步构建
  - 增加复杂度但无收益

---
  十、实际应用示例

  1. StringBuilder（C++ 标准库）

  // 不是设计模式，但体现了建造者思想
  std::stringstream ss;
  ss << "Name: " << name;
  ss << ", Age: " << age;
  ss << ", Email: " << email;
  std::string result = ss.str();

  2. HTTP 请求构建

  class HttpRequest {
  public:
      class Builder {
      public:
          Builder(const std::string& url) : m_url(url) {}

          Builder& GET() { m_method = "GET"; return *this; }
          Builder& POST() { m_method = "POST"; return *this; }
    
          Builder& header(const std::string& k, const std::string& v) {
              m_headers[k] = v;
              return *this;
          }
    
          Builder& json(const std::string& body) {
              m_body = body;
              m_headers["Content-Type"] = "application/json";
              return *this;
          }
    
          HttpRequest build() { return HttpRequest(*this); }
      };
  };

  // 使用
  auto request = HttpRequest::Builder("https://api.example.com/users")
      .POST()
      .header("Authorization", "Bearer token")
      .json("{\"name\":\"John\"}")
      .build();

  3. 数据库查询构建

  class QueryBuilder {
  public:
      QueryBuilder& select(const std::vector<std::string>& cols) {
          m_select = cols;
          return *this;
      }

      QueryBuilder& from(const std::string& table) {
          m_from = table;
          return *this;
      }
    
      QueryBuilder& where(const std::string& condition) {
          m_where.push_back(condition);
          return *this;
      }
    
      QueryBuilder& orderBy(const std::string& col, bool asc = true) {
          m_orderBy = col + (asc ? " ASC" : " DESC");
          return *this;
      }
    
      QueryBuilder& limit(int n) {
          m_limit = n;
          return *this;
      }
    
      std::string build() {
          std::string sql = "SELECT ";
          sql += join(m_select, ", ");
          sql += " FROM " + m_from;
          if (!m_where.empty()) {
              sql += " WHERE " + join(m_where, " AND ");
          }
          if (!m_orderBy.empty()) {
              sql += " ORDER BY " + m_orderBy;
          }
          if (m_limit > 0) {
              sql += " LIMIT " + std::to_string(m_limit);
          }
          return sql;
      }

  private:
      std::vector<std::string> m_select;
      std::string m_from;
      std::vector<std::string> m_where;
      std::string m_orderBy;
      int m_limit = 0;
  };

  // 使用
  std::string sql = QueryBuilder()
      .select({"id", "name", "email"})
      .from("users")
      .where("age > 18")
      .where("status = 'active'")
      .orderBy("created_at", false)
      .limit(10)
      .build();

  // SELECT id, name, email FROM users WHERE age > 18 AND status = 'active' ORDER BY created_at DESC LIMIT 10

  4. XML/JSON 文档构建

  class XmlBuilder {
  public:
      XmlBuilder& element(const std::string& name) {
          m_elements.push_back("<" + name + ">");
          m_currentElement = name;
          return *this;
      }

      XmlBuilder& text(const std::string& text) {
          m_elements.back() += text + "</" + m_currentElement + ">";
          return *this;
      }
    
      XmlBuilder& attribute(const std::string& name, const std::string& value) {
          // 添加属性
          return *this;
      }
    
      std::string build() {
          return "<?xml version=\"1.0\"?>\n" + join(m_elements, "\n");
      }
  };

---
  十一、建造者模式与 VQRS 的结合建议

  // 配置构建器
  class VQRSConfig {
  public:
      class Builder {
      public:
          Builder& rabbitMQ(const std::string& host, int port) {
              m_mqHost = host;
              m_mqPort = port;
              return *this;
          }

          Builder& database(const std::string& host, const std::string& name) {
              m_dbHost = host;
              m_dbName = name;
              return *this;
          }
    
          Builder& analyzeFrame(int count, int step) {
              m_frameCount = count;
              m_step = step;
              return *this;
          }
    
          Builder& enableBigModel(bool enable) {
              m_bigModelEnable = enable;
              return *this;
          }
    
          VQRSConfig build() {
              validate();
              return VQRSConfig(*this);
          }
    
      private:
          void validate() {
              if (m_frameCount <= 0) throw std::invalid_argument("frame count must > 0");
          }
    
          friend class VQRSConfig;
          std::string m_mqHost;
          int m_mqPort = 5672;
          std::string m_dbHost;
          std::string m_dbName;
          int m_frameCount = 80;
          int m_step = 2;
          bool m_bigModelEnable = false;
      };
  };

  // 使用
  VQRSConfig config = VQRSConfig::Builder()
      .rabbitMQ("192.168.1.100", 5672)
      .database("192.168.1.101", "vqrs_db")
      .analyzeFrame(100, 3)
      .enableBigModel(true)
      .build();

  建造者模式特别适合 VQRS 中复杂的配置对象和消息对象构建，能显著提高代码可读性和可维护性。
