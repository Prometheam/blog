---
title: "设计模式详解：享元模式（Flyweight）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 享元模式

一、核心思想

  通过共享技术实现大量细粒度对象的复用，减少内存占用。

  传统方式：1000个相同字符 → 1000个对象
  享元模式：1000个相同字符 → 1个共享对象 + 1000次引用

  本质：将对象的状态分为内部状态（可共享）和外部状态（不可共享），共享内部状态相同的对象。

---
  二、模式结构

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                    Flyweight (抽象享元)                          │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + operation(extrinsicState)   // 外部状态作为参数传入     │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
                      ▲                         ▲
                      │                         │
          ┌───────────┴───────────┐   ┌─────────┴─────────────┐
          │  ConcreteFlyweight    │   │  UnsharedConcrete     │
          │    (具体享元)          │   │  Flyweight (非共享)   │
          │  ┌─────────────────┐  │   │                       │
          │  │ intrinsicState  │  │   │  全部状态都不共享      │
          │  │ (内部状态-共享)  │  │   │                       │
          │  └─────────────────┘  │   └───────────────────────┘
          └───────────────────────┘
                      ▲
                      │ 创建/管理
          ┌───────────┴───────────┐
          │  FlyweightFactory     │
          │    (享元工厂)          │
          │  ┌─────────────────┐  │
          │  │ flyweights pool │  │
          │  │ (享元池-缓存)    │  │
          │  │ + getFlyweight()│  │
          │  └─────────────────┘  │
          └───────────────────────┘
```

---
  三、内部状态 vs 外部状态

```
  ┌──────────┬──────────────────────┬────────────┬──────────────────┐
  │   类型   │         说明         │    存储    │       示例       │
  ├──────────┼──────────────────────┼────────────┼──────────────────┤
  │ 内部状态 │ 可共享，不随环境变化 │ 享元对象内 │ 字符的字体、形状 │
  ├──────────┼──────────────────────┼────────────┼──────────────────┤
  │ 外部状态 │ 不可共享，随环境变化 │ 客户端传入 │ 字符的位置、颜色 │
  └──────────┴──────────────────────┴────────────┴──────────────────┘
```

  判断内外部状态的方法：
  - 如果N个对象中该属性的值相同或取值范围很小 → 内部状态
  - 如果N个对象中该属性各不相同 → 外部状态

---
  四、标准实现

```cpp
#include <memory>
#include <string>
#include <unordered_map>
#include <iostream>
#include <mutex>

// 抽象享元
class Flyweight {
public:
    virtual ~Flyweight() = default;
    virtual void operation(const std::string& extrinsicState) = 0;
};

// 具体享元（包含内部状态）
class ConcreteFlyweight : public Flyweight {
private:
    std::string m_intrinsicState;  // 内部状态（可共享）
public:
    explicit ConcreteFlyweight(const std::string& state)
        : m_intrinsicState(state) {}

    void operation(const std::string& extrinsicState) override {
        std::cout << "享元[" << m_intrinsicState << "] "
                  << "外部状态: " << extrinsicState << "\n";
    }
};

// 享元工厂（线程安全）
class FlyweightFactory {
public:
    std::shared_ptr<Flyweight> getFlyweight(const std::string& key) {
        std::lock_guard<std::mutex> lock(mutex_);

        auto it = pool_.find(key);
        if (it != pool_.end()) {
            std::cout << "复用已有享元: " << key << "\n";
            return it->second;
        }

        std::cout << "创建新享元: " << key << "\n";
        auto fw = std::make_shared<ConcreteFlyweight>(key);
        pool_[key] = fw;
        return fw;
    }

    size_t poolSize() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return pool_.size();
    }

private:
    std::unordered_map<std::string, std::shared_ptr<Flyweight>> pool_;
    mutable std::mutex mutex_;
};
```

---
  五、实际应用：围棋游戏

```cpp
// 内部状态：颜色（黑/白）- 只有2种，可共享
// 外部状态：位置(x, y) - 361个位置，不可共享

struct Position {
    int x, y;
};

class ChessPiece {
    std::string color_;  // 内部状态
public:
    explicit ChessPiece(const std::string& color) : color_(color) {}

    void draw(Position pos) {
        std::cout << color_ << "棋 → (" << pos.x << "," << pos.y << ")\n";
    }
};

class ChessBoard {
    FlyweightFactory factory_;
    std::vector<std::pair<std::shared_ptr<Flyweight>, Position>> pieces_;

public:
    void placePiece(const std::string& color, int x, int y) {
        auto piece = factory_.getFlyweight(color);
        pieces_.push_back({piece, {x, y}});
    }

    void render() {
        for (auto& [piece, pos] : pieces_) {
            piece->operation("(" + std::to_string(pos.x) + "," + std::to_string(pos.y) + ")");
        }
    }

    void printStats() {
        std::cout << "棋子总数: " << pieces_.size() << "\n";
        std::cout << "享元对象数: " << factory_.poolSize() << "\n";
        // 即使有200个棋子，享元对象只有2个（黑/白）
    }
};
```

---
  六、实际应用：文本编辑器字符渲染

```cpp
// 文档中有10万个字符，但字符种类（字体+大小+样式组合）通常<100种
// 内部状态：字体、大小、粗体/斜体 → 共享
// 外部状态：位置、颜色 → 不共享

struct CharStyle {
    std::string font;
    int size;
    bool bold;
    bool italic;

    bool operator==(const CharStyle& o) const {
        return font == o.font && size == o.size && bold == o.bold && italic == o.italic;
    }
};

struct CharStyleHash {
    size_t operator()(const CharStyle& s) const {
        size_t h = std::hash<std::string>{}(s.font);
        h ^= std::hash<int>{}(s.size) << 1;
        h ^= std::hash<bool>{}(s.bold) << 2;
        h ^= std::hash<bool>{}(s.italic) << 3;
        return h;
    }
};

class CharFlyweight {
    CharStyle style_;  // 内部状态
public:
    explicit CharFlyweight(CharStyle style) : style_(std::move(style)) {}
    void render(char ch, int x, int y) {
        // 使用共享的style渲染字符到指定位置
    }
};

class CharFlyweightFactory {
    std::unordered_map<CharStyle, std::shared_ptr<CharFlyweight>, CharStyleHash> cache_;
public:
    std::shared_ptr<CharFlyweight> get(const CharStyle& style) {
        auto it = cache_.find(style);
        if (it != cache_.end()) return it->second;
        auto fw = std::make_shared<CharFlyweight>(style);
        cache_[style] = fw;
        return fw;
    }

    // 10万个字符 → 可能只有50-100个享元对象
    size_t uniqueStyles() const { return cache_.size(); }
};
```

---
  七、内存优化量化

```
  场景：文本编辑器，100,000 个字符

  不使用享元：
  - 每个字符对象: 字体(32B) + 大小(4B) + 样式(2B) + 字符(1B) + 位置(8B) = ~47B
  - 总内存: 100,000 × 47B = 4.7 MB

  使用享元（假设50种样式组合）：
  - 享元对象: 50 × 38B = 1,900B ≈ 2KB
  - 字符引用: 100,000 × (指针8B + 字符1B + 位置8B) = 1.7MB
  - 总内存: 1.7MB

  节省: 4.7MB → 1.7MB，减少 64%
```

---
  八、vs 其他模式

```
  ┌────────────────┬──────────────────────────────────────────────────┐
  │    对比模式    │              区别                                 │
  ├────────────────┼──────────────────────────────────────────────────┤
  │ 单例          │ 单例只有1个实例；享元可有多个不同的共享实例        │
  ├────────────────┼──────────────────────────────────────────────────┤
  │ 对象池        │ 对象池的对象可变且独占使用；享元不可变且共享使用   │
  ├────────────────┼──────────────────────────────────────────────────┤
  │ 组合          │ 组合的叶节点可以用享元实现                        │
  ├────────────────┼──────────────────────────────────────────────────┤
  │ 策略          │ 无状态的策略对象可以作为享元共享                  │
  └────────────────┴──────────────────────────────────────────────────┘
```

---
  九、何时使用

  ✅ 适用场景：
  - 系统中有大量相似对象，消耗大量内存
  - 对象的大部分状态可以外部化
  - 去除外部状态后，多个对象可以用较少的共享对象替代
  - 应用程序不依赖对象标识（共享对象无法区分）

  ❌ 不适用场景：
  - 对象数量不多（共享的开销>收益）
  - 对象间状态差异大，难以分离内外部状态
  - 需要区分每个对象的身份（==比较）

---
  十、设计要点

  1. 享元对象必须是不可变的（内部状态一旦设定不再改变）
  2. 享元工厂通常是单例
  3. 线程安全：工厂的缓存需要加锁保护
  4. 内存 vs 时间：享元节省内存但增加了外部状态传递的时间开销
  5. 现实中的享元：字符串驻留(String Interning)、Integer缓存(-128~127)
