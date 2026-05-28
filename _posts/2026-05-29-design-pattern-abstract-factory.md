---
title: "设计模式详解：抽象工厂模式（Abstract Factory）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 抽象工厂模式

一、核心思想

  提供一个接口，用于创建一系列相关或相互依赖的对象（产品家族），而无需指定它们的具体类。

  传统方式：客户端分别创建 WinButton + WinTextBox，平台切换时改动散落各处
  抽象工厂：客户端通过 UIFactory 接口创建整套UI组件，切换平台只需换工厂实现

  关键区别：工厂方法创建一种产品，抽象工厂创建一族产品。

---
  二、模式结构

```
  ┌──────────────────────────────────────────────────────────────────┐
  │              AbstractFactory (抽象工厂)                            │
  │  ┌────────────────────────────────────────────────────────────┐  │
  │  │ + createProductA(): AbstractProductA*                       │  │
  │  │ + createProductB(): AbstractProductB*                       │  │
  │  │ + createProductC(): AbstractProductC*                       │  │
  │  └────────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────┘
              ▲                                    ▲
              │                                    │
  ┌───────────┴──────────────┐     ┌──────────────┴───────────────┐
  │  ConcreteFactory1        │     │    ConcreteFactory2           │
  │  (如: WindowsFactory)    │     │    (如: MacFactory)           │
  │  ┌────────────────────┐  │     │  ┌────────────────────────┐  │
  │  │createProductA()    │  │     │  │createProductA()         │  │
  │  │ → WinButton        │  │     │  │ → MacButton             │  │
  │  │createProductB()    │  │     │  │createProductB()         │  │
  │  │ → WinTextBox       │  │     │  │ → MacTextBox            │  │
  │  └────────────────────┘  │     │  └────────────────────────┘  │
  └──────────────────────────┘     └───────────────────────────────┘

  产品家族：
  ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
  │AbstractProductA│    │AbstractProductB│    │AbstractProductC│
  │  (Button)     │     │  (TextBox)    │     │  (CheckBox)   │
  └───────┬───────┘     └───────┬───────┘     └───────┬───────┘
          │                     │                     │
    ┌─────┴─────┐        ┌─────┴─────┐        ┌─────┴─────┐
    │WinButton  │        │WinTextBox │        │WinCheckBox│
    │MacButton  │        │MacTextBox │        │MacCheckBox│
    └───────────┘        └───────────┘        └───────────┘
```

---
  三、标准实现

```cpp
#include <memory>
#include <string>
#include <iostream>

// ========== 抽象产品 ==========

class IButton {
public:
    virtual ~IButton() = default;
    virtual void render() = 0;
    virtual void onClick(std::function<void()> handler) = 0;
};

class ITextBox {
public:
    virtual ~ITextBox() = default;
    virtual void render() = 0;
    virtual void setText(const std::string& text) = 0;
    virtual std::string getText() const = 0;
};

class ICheckBox {
public:
    virtual ~ICheckBox() = default;
    virtual void render() = 0;
    virtual void setChecked(bool checked) = 0;
};

// ========== Windows 产品家族 ==========

class WinButton : public IButton {
public:
    void render() override { std::cout << "[Win Button]\n"; }
    void onClick(std::function<void()> handler) override { handler(); }
};

class WinTextBox : public ITextBox {
    std::string text_;
public:
    void render() override { std::cout << "[Win TextBox: " << text_ << "]\n"; }
    void setText(const std::string& text) override { text_ = text; }
    std::string getText() const override { return text_; }
};

class WinCheckBox : public ICheckBox {
    bool checked_ = false;
public:
    void render() override {
        std::cout << "[Win CheckBox: " << (checked_ ? "✓" : "☐") << "]\n";
    }
    void setChecked(bool checked) override { checked_ = checked; }
};

// ========== Mac 产品家族 ==========

class MacButton : public IButton {
public:
    void render() override { std::cout << "(Mac Button)\n"; }
    void onClick(std::function<void()> handler) override { handler(); }
};

class MacTextBox : public ITextBox {
    std::string text_;
public:
    void render() override { std::cout << "(Mac TextBox: " << text_ << ")\n"; }
    void setText(const std::string& text) override { text_ = text; }
    std::string getText() const override { return text_; }
};

class MacCheckBox : public ICheckBox {
    bool checked_ = false;
public:
    void render() override {
        std::cout << "(Mac CheckBox: " << (checked_ ? "✓" : "○") << ")\n";
    }
    void setChecked(bool checked) override { checked_ = checked; }
};

// ========== 抽象工厂 ==========

class IUIFactory {
public:
    virtual ~IUIFactory() = default;
    virtual std::unique_ptr<IButton> createButton() = 0;
    virtual std::unique_ptr<ITextBox> createTextBox() = 0;
    virtual std::unique_ptr<ICheckBox> createCheckBox() = 0;
};

// ========== 具体工厂 ==========

class WindowsUIFactory : public IUIFactory {
public:
    std::unique_ptr<IButton> createButton() override {
        return std::make_unique<WinButton>();
    }
    std::unique_ptr<ITextBox> createTextBox() override {
        return std::make_unique<WinTextBox>();
    }
    std::unique_ptr<ICheckBox> createCheckBox() override {
        return std::make_unique<WinCheckBox>();
    }
};

class MacUIFactory : public IUIFactory {
public:
    std::unique_ptr<IButton> createButton() override {
        return std::make_unique<MacButton>();
    }
    std::unique_ptr<ITextBox> createTextBox() override {
        return std::make_unique<MacTextBox>();
    }
    std::unique_ptr<ICheckBox> createCheckBox() override {
        return std::make_unique<MacCheckBox>();
    }
};

// ========== 客户端代码 ==========

class LoginDialog {
    std::unique_ptr<IButton> loginBtn_;
    std::unique_ptr<ITextBox> usernameBox_;
    std::unique_ptr<ITextBox> passwordBox_;
    std::unique_ptr<ICheckBox> rememberMe_;

public:
    // 客户端只依赖抽象工厂接口
    explicit LoginDialog(IUIFactory& factory) {
        loginBtn_ = factory.createButton();
        usernameBox_ = factory.createTextBox();
        passwordBox_ = factory.createTextBox();
        rememberMe_ = factory.createCheckBox();
    }

    void render() {
        usernameBox_->setText("用户名");
        usernameBox_->render();
        passwordBox_->setText("密码");
        passwordBox_->render();
        rememberMe_->setChecked(true);
        rememberMe_->render();
        loginBtn_->render();
    }
};

int main() {
    // 根据平台选择工厂（这是唯一知道具体类的地方）
    #ifdef _WIN32
        WindowsUIFactory factory;
    #else
        MacUIFactory factory;
    #endif

    LoginDialog dialog(factory);
    dialog.render();
    return 0;
}
```

---
  四、工厂方法 vs 抽象工厂

```
  ┌──────────────────┬──────────────────────┬───────────────────────┐
  │      维度        │     工厂方法         │      抽象工厂          │
  ├──────────────────┼──────────────────────┼───────────────────────┤
  │ 产品数量         │ 创建一种产品         │ 创建一族相关产品       │
  ├──────────────────┼──────────────────────┼───────────────────────┤
  │ 扩展方向         │ 纵向（新增产品类型） │ 横向（新增产品家族）   │
  ├──────────────────┼──────────────────────┼───────────────────────┤
  │ 方法数           │ 一个工厂方法         │ 多个工厂方法           │
  ├──────────────────┼──────────────────────┼───────────────────────┤
  │ 约束             │ 无跨产品约束         │ 保证产品家族一致性     │
  ├──────────────────┼──────────────────────┼───────────────────────┤
  │ 典型应用         │ 日志器、解析器       │ 跨平台UI、数据库访问层 │
  ├──────────────────┼──────────────────────┼───────────────────────┤
  │ 违反开闭原则的点 │ 新增产品类型：不违反 │ 新增产品种类：需改接口 │
  └──────────────────┴──────────────────────┴───────────────────────┘

  扩展对比：
  - 新增一个 Linux 产品家族 → 只需新增 LinuxUIFactory（✅ 开闭原则）
  - 新增一种产品（如 Slider） → 需修改 IUIFactory 接口（❌ 违反开闭原则）
```

---
  五、实际应用场景

  1. 数据库访问层

```cpp
// 不同数据库的连接+语句+结果集构成一个产品家族
class IConnection { /* ... */ };
class IStatement { /* ... */ };
class IResultSet { /* ... */ };

class IDatabaseFactory {
public:
    virtual std::unique_ptr<IConnection> createConnection(const std::string& url) = 0;
    virtual std::unique_ptr<IStatement> createStatement(IConnection& conn) = 0;
};

class MySQLFactory : public IDatabaseFactory { /* 创建MySQL系列 */ };
class PostgreSQLFactory : public IDatabaseFactory { /* 创建PG系列 */ };
```

  2. 消息序列化

```cpp
// JSON / Protobuf / MessagePack 各自是一个产品家族
class ISerializer { /* ... */ };
class IDeserializer { /* ... */ };
class ISchemaValidator { /* ... */ };

class ISerializationFactory {
public:
    virtual std::unique_ptr<ISerializer> createSerializer() = 0;
    virtual std::unique_ptr<IDeserializer> createDeserializer() = 0;
    virtual std::unique_ptr<ISchemaValidator> createValidator() = 0;
};

class JsonFactory : public ISerializationFactory { /* ... */ };
class ProtobufFactory : public ISerializationFactory { /* ... */ };
```

  3. 主题系统

```cpp
class IColor { /* ... */ };
class IFont { /* ... */ };
class IIcon { /* ... */ };

class IThemeFactory {
public:
    virtual std::unique_ptr<IColor> createPrimaryColor() = 0;
    virtual std::unique_ptr<IFont> createBodyFont() = 0;
    virtual std::unique_ptr<IIcon> createIconSet() = 0;
};

class DarkThemeFactory : public IThemeFactory { /* 暗色主题 */ };
class LightThemeFactory : public IThemeFactory { /* 亮色主题 */ };
```

---
  六、开闭原则分析

```
  抽象工厂的扩展性矩阵：

                     新增产品家族          新增产品种类
                   (如LinuxFactory)     (如新增Slider)
  ─────────────────────────────────────────────────────
  修改范围         仅新增一个工厂类        修改抽象工厂接口
                                         + 所有具体工厂

  开闭原则         ✅ 满足               ❌ 违反

  结论：抽象工厂适合"产品家族可能增加，但产品种类稳定"的场景
```

---
  七、何时使用

  ✅ 适用场景：
  - 系统需要多个产品系列中选一个使用（如跨平台）
  - 需要保证产品之间的一致性（Mac按钮配Mac文本框）
  - 想要隔离具体类的创建，客户端只使用抽象接口

  ❌ 不适用场景：
  - 只有一种产品（用工厂方法就够）
  - 产品种类经常变化（每次都要改抽象工厂接口）
  - 产品之间无关联，不构成"家族"

---
  八、设计要点

  1. 抽象工厂通常以单例模式实现（全局只需一个工厂实例）
  2. 新增产品家族时完全满足开闭原则
  3. 新增产品种类时需要修改所有工厂，这是抽象工厂的主要局限
  4. 可以结合原型模式：工厂内部通过克隆原型对象来创建产品
  5. 实际项目中，通常在程序入口处（main/配置阶段）决定使用哪个具体工厂
