---
title: "设计模式详解：模板方法模式（Template Method）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 模板方法模式
核心思想: 在父类中定义算法的骨架，将某些步骤延迟到子类实现。父类控制流程，子类实现细节。

  现实比喻

  简历模板：
```
  ┌─────────────────────────────────┐
  │  个人简历                        │
  ├─────────────────────────────────┤
  │  姓名: _________     ← 填写     │
  │  年龄: _________     ← 填写     │
  │  学历: _________     ← 填写     │
  │  工作经历:                    │
  │  ┌─────────────────────┐      │
  │  │  (自由发挥区域)        │ ← 填写 │
  │  └─────────────────────┘      │
  └─────────────────────────────────┘
```

  模板固定了结构，具体内容由每个人填写。

---
  代码示例
```cpp
  // 抽象类：定义算法骨架
  class DataProcessor {
  public:
      // 模板方法：定义算法骨架（final防止子类覆盖）
      void process() final {
          readData();
          if (validateData()) {
              processData();
          }
          saveData();
          logResult();
      }

      virtual ~DataProcessor() = default;

  protected:
      // 具体步骤：有些由子类实现，有些有默认实现
      virtual void readData() = 0;           // 必须实现
      virtual bool validateData() = 0;       // 必须实现
      virtual void processData() = 0;        // 必须实现

      virtual void saveData() {              // 可选实现（钩子）
          std::cout << "默认保存方式" << std::endl;
      }

      void logResult() {                     // 公共实现
          std::cout << "处理完成" << std::endl;
      }
  };

  // 具体类：文件处理器
  class FileProcessor : public DataProcessor {
      std::string m_filename;

  protected:
      void readData() override {
          std::cout << "从文件读取: " << m_filename << std::endl;
      }

      bool validateData() override {
          std::cout << "校验文件格式" << std::endl;
          return true;
      }

      void processData() override {
          std::cout << "解析文件内容" << std::endl;
      }

  public:
      FileProcessor(const std::string& filename) : m_filename(filename) {}
  };

  // 具体类：数据库处理器
  class DatabaseProcessor : public DataProcessor {
      std::string m_connStr;

  protected:
      void readData() override {
          std::cout << "从数据库查询: " << m_connStr << std::endl;
      }

      bool validateData() override {
          std::cout << "校验数据完整性" << std::endl;
          return true;
      }

      void processData() override {
          std::cout << "处理数据库记录" << std::endl;
      }

      void saveData() override {
          std::cout << "写回数据库" << std::endl;
      }

  public:
      DatabaseProcessor(const std::string& connStr) : m_connStr(connStr) {}
  };

  // 使用
  int main() {
      std::unique_ptr<DataProcessor> processor;

      processor = std::make_unique<FileProcessor>("data.txt");
      processor->process();
      // 输出: 从文件读取 → 校验文件格式 → 解析文件内容 → 默认保存方式 → 处理完成

      processor = std::make_unique<DatabaseProcessor>("mysql://...");
      processor->process();
      // 输出: 从数据库查询 → 校验数据完整性 → 处理数据库记录 → 写回数据库 → 处理完成
  }
```
---
  VQRS 中的实际应用

  项目中的 CProcessorBase 就是模板方法模式：
```cpp
  class CProcessorBase : public ThreadBase {
  public:
      // 线程主循环（骨架）
      void run() {
          while (m_bRunning) {
              CMsg msg = getMessage();

              switch (msg.type) {
                  case REQUEST:
                      DealWithOneRequest(msg);   // 子类实现
                      break;
                  case RESPONSE:
                      DealWithOneResponse(msg);  // 子类实现
                      break;
                  case NOTIFY:
                      DealWithOneNotify(msg);    // 子类实现
                      break;
                  case TIMEOUT:
                      DealWithOneTimeOut(msg);   // 子类实现
                      break;
              }
          }
      }

  protected:
      // 交给子类实现的具体步骤
      virtual int DealWithOneRequest(CMsg& msgReq);
      virtual int DealWithOneResponse(CMsg& msgRsp);
      virtual int DealWithOneNotify(CMsg& msgNotify);
      virtual int DealWithOneTimeOut(unsigned long ulSubID, unsigned long ulTimerID);
  };
```
  父类控制消息分发流程，子类只需关注具体消息的处理逻辑。

---
  关键概念

```
  ┌──────────┬──────────────────────────────────────┐
  │   概念   │                 说明                 │
  ├──────────┼──────────────────────────────────────┤
  │ 模板方法 │ 定义算法骨架的方法，通常设为 final   │
  ├──────────┼──────────────────────────────────────┤
  │ 基本方法 │ 算法的各个步骤，由子类实现           │
  ├──────────┼──────────────────────────────────────┤
  │ 钩子方法 │ 提供默认实现的方法，子类可选择性覆盖 │
  └──────────┴──────────────────────────────────────┘
```

---
  钩子方法示例
```cpp
  class Game {
  public:
      void play() final {          // 模板方法
          initialize();
          startPlay();
          if (wantBonus()) {        // 钩子控制流程
              playBonus();
          }
          endPlay();
      }

      virtual ~Game() = default;

  protected:
      virtual void initialize() = 0;
      virtual void startPlay() = 0;
      virtual void endPlay() = 0;

      // 钩子方法：子类可覆盖以改变流程
      virtual bool wantBonus() { return false; }
      virtual void playBonus() {}
  };

  // 足球游戏：没有奖励关卡
  class Football : public Game {
      void initialize() override { std::cout << "足球场准备" << std::endl; }
      void startPlay() override { std::cout << "开始踢球" << std::endl; }
      void endPlay() override { std::cout << "比赛结束" << std::endl; }
  };

  // RPG游戏：有奖励关卡
  class RPGGame : public Game {
      void initialize() override { std::cout << "加载地图" << std::endl; }
      void startPlay() override { std::cout << "开始冒险" << std::endl; }
      void endPlay() override { std::cout << "保存进度" << std::endl; }

      bool wantBonus() override { return true; }  // 启用奖励
      void playBonus() override { std::cout << "隐藏关卡" << std::endl; }
  };
```
---
  与策略模式的区别

 ```
  ┌──────────┬────────────────────────────┬────────────────┐
  │   对比   │          模板方法          │    策略模式    │
  ├──────────┼────────────────────────────┼────────────────┤
  │ 关系     │ 继承                       │ 组合           │
  ├──────────┼────────────────────────────┼────────────────┤
  │ 变化点   │ 整体算法不变，部分步骤变化 │ 整个算法可替换 │
  ├──────────┼────────────────────────────┼────────────────┤
  │ 控制权   │ 父类控制流程               │ 客户端选择策略 │
  ├──────────┼────────────────────────────┼────────────────┤
  │ 扩展方式 │ 继承扩展                   │ 新增策略类     │
  └──────────┴────────────────────────────┴────────────────┘
```

  模板方法：父类说 "按我规定的步骤走，每步怎么做你定"
  策略模式：客户端说 "我要用这个策略，具体怎么实现它定"

---
  适用场景

  - 多个类有相同逻辑，只有部分步骤不同
  - 需要控制子类扩展点（哪些可变、哪些固定）
  - 重构时提取公共代码到父类

---
  优缺点

  优点：
  - 复用公共代码，避免重复
  - 控制子类行为，符合"开闭原则"

  缺点：
  - 每个实现都需要一个子类，类数量增加
  - 继承关系限制了灵活性

  总结：模板方法是最常用的设计模式之一，简单但强大。

