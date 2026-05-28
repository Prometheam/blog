---
title: "设计模式详解：解释器模式（Interpreter）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 解释器模式
 核心思想: 给定一门语言，定义它的文法表示，并定义一个解释器，该解释器使用该表示来解释语言中的句子。

  解释器模式将每个文法规则映射到一个类，通过组合这些类来解释复杂的表达式。

---
  现实比喻

  计算器表达式解析：

  输入: "3 + 5 * 2"

  解释过程:
  ┌─────────────────────────────────────────────┐
  │                  + 表达式                    │
  │                 /     \                      │
  │            数字3      * 表达式               │
  │                        /     \               │
  │                   数字5    数字2              │
  └─────────────────────────────────────────────┘

  计算过程: 3 + (5 * 2) = 3 + 10 = 13

  每个节点是一个解释器，负责解释自己的部分

---
  代码示例：数学表达式解释器
```cpp
  #include <iostream>
  #include <string>
  #include <memory>
  #include <map>

  // 抽象表达式
  class Expression {
  public:
      virtual ~Expression() = default;
      virtual int interpret(const std::map<std::string, int>& context) = 0;
  };

  // 终结符表达式：数字
  class NumberExpression : public Expression {
      int m_number;

  public:
      NumberExpression(int number) : m_number(number) {}

      int interpret(const std::map<std::string, int>&) override {
          return m_number;
      }
  };

  // 终结符表达式：变量
  class VariableExpression : public Expression {
      std::string m_name;

  public:
      VariableExpression(const std::string& name) : m_name(name) {}

      int interpret(const std::map<std::string, int>& context) override {
          auto it = context.find(m_name);
          if (it != context.end()) {
              return it->second;
          }
          return 0;
      }
  };

  // 非终结符表达式：加法
  class AddExpression : public Expression {
      std::unique_ptr<Expression> m_left;
      std::unique_ptr<Expression> m_right;

  public:
      AddExpression(std::unique_ptr<Expression> left, std::unique_ptr<Expression> right)
          : m_left(std::move(left)), m_right(std::move(right)) {}

      int interpret(const std::map<std::string, int>& context) override {
          return m_left->interpret(context) + m_right->interpret(context);
      }
  };

  // 非终结符表达式：减法
  class SubtractExpression : public Expression {
      std::unique_ptr<Expression> m_left;
      std::unique_ptr<Expression> m_right;

  public:
      SubtractExpression(std::unique_ptr<Expression> left, std::unique_ptr<Expression> right)
          : m_left(std::move(left)), m_right(std::move(right)) {}

      int interpret(const std::map<std::string, int>& context) override {
          return m_left->interpret(context) - m_right->interpret(context);
      }
  };

  // 非终结符表达式：乘法
  class MultiplyExpression : public Expression {
      std::unique_ptr<Expression> m_left;
      std::unique_ptr<Expression> m_right;

  public:
      MultiplyExpression(std::unique_ptr<Expression> left, std::unique_ptr<Expression> right)
          : m_left(std::move(left)), m_right(std::move(right)) {}

      int interpret(const std::map<std::string, int>& context) override {
          return m_left->interpret(context) * m_right->interpret(context);
      }
  };

  // 使用
  int main() {
      // 手动构建表达式树: (a + b) * (c - 5)
      // 其中 a=10, b=5, c=20
      auto expr = std::make_unique<MultiplyExpression>(
          std::make_unique<AddExpression>(std::make_unique<VariableExpression>("a"),std::make_unique<VariableExpression>("b")),
          std::make_unique<SubtractExpression>(std::make_unique<VariableExpression>("c"),std::make_unique<NumberExpression>(5)));
{% raw %}
      //std::map<std::string, int> context = {{'a', 10}, {'b', 5}, {'c', 20}};
{% endraw %}
      int result = expr->interpret(context);
      std::cout << "(a + b) * (c - 5) = " << result << std::endl;
      std::cout << "(10 + 5) * (20 - 5) = " << (10 + 5) * (20 - 5) << std::endl;

      return 0;
  }
```
  输出：
  (a + b) * (c - 5) = 225
  (10 + 5) * (20 - 5) = 225

---
  带解析器的完整示例
```cpp
  #include <iostream>
  #include <string>
  #include <memory>
  #include <vector>
  #include <sstream>
  #include <cctype>

  // 表达式接口（同上）
  class Expression {
  public:
      virtual ~Expression() = default;
      virtual int interpret() = 0;
  };

  // 数字表达式
  class NumberExpr : public Expression {
      int m_value;
  public:
      NumberExpr(int v) : m_value(v) {}
      int interpret() override { return m_value; }
  };

  // 二元操作表达式
  class BinaryExpr : public Expression {
      char m_op;
      std::unique_ptr<Expression> m_left;
      std::unique_ptr<Expression> m_right;

  public:
      BinaryExpr(char op, std::unique_ptr<Expression> left, std::unique_ptr<Expression> right)
          : m_op(op), m_left(std::move(left)), m_right(std::move(right)) {}

      int interpret() override {
          int l = m_left->interpret();
          int r = m_right->interpret();
          switch (m_op) {
              case '+': return l + r;
              case '-': return l - r;
              case '*': return l * r;
              case '/': return r != 0 ? l / r : 0;
              default: return 0;
          }
      }
  };

  // 简单表达式解析器
  class ExpressionParser {
      std::string m_input;
      size_t m_pos = 0;

      char peek() { return m_pos < m_input.size() ? m_input[m_pos] : '\0'; }
      char get() { return m_pos < m_input.size() ? m_input[m_pos++] : '\0'; }
      void skipSpace() { while (std::isspace(peek())) get(); }

      int parseNumber() {
          skipSpace();
          int num = 0;
          while (std::isdigit(peek())) {
              num = num * 10 + (get() - '0');
          }
          return num;
      }

      // 解析因子：数字或括号表达式
      std::unique_ptr<Expression> parseFactor() {
          skipSpace();
          if (peek() == '(') {
              get(); // 消费 '('
              auto expr = parseExpression();
              skipSpace();
              if (peek() == ')') get(); // 消费 ')'
              return expr;
          }
          return std::make_unique<NumberExpr>(parseNumber());
      }

      // 解析项：处理 * /
      std::unique_ptr<Expression> parseTerm() {
          auto left = parseFactor();
          skipSpace();
          while (peek() == '*' || peek() == '/') {
              char op = get();
              auto right = parseFactor();
              left = std::make_unique<BinaryExpr>(op, std::move(left), std::move(right));
              skipSpace();
          }
          return left;
      }

      // 解析表达式：处理 + -
      std::unique_ptr<Expression> parseExpression() {
          auto left = parseTerm();
          skipSpace();
          while (peek() == '+' || peek() == '-') {
              char op = get();
              auto right = parseTerm();
              left = std::make_unique<BinaryExpr>(op, std::move(left), std::move(right));
              skipSpace();
          }
          return left;
      }

  public:
      ExpressionParser(const std::string& input) : m_input(input) {}

      std::unique_ptr<Expression> parse() {
          m_pos = 0;
          return parseExpression();
      }
  };

  // 使用
  int main() {
      std::vector<std::string> expressions = {
          "3 + 5",
          "10 - 4 * 2",
          "(3 + 5) * 2",
          "2 + 3 * 4 - 6 / 2"
      };

      for (const auto& expr : expressions) {
          ExpressionParser parser(expr);
          auto ast = parser.parse();
          std::cout << expr << " = " << ast->interpret() << std::endl;
      }

      return 0;
  }
```
  输出：
  3 + 5 = 8
  10 - 4 * 2 = 2
  (3 + 5) * 2 = 16
  2 + 3 * 4 - 6 / 2 = 11

---
  结构示意图

  ┌─────────────────────────────────────────────────────────────┐
  │                    Client (解析器)                          │
  │  解析输入字符串，构建抽象语法树 (AST)                         │
  └─────────────────────────────────────────────────────────────┘
                                │
                                │ 构建
                                ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                  <<interface>>                              │
  │                   AbstractExpression                        │
  │  ─────────────────────────────────────────────────────────  │
  │  + interpret(context)                                       │
  └─────────────────────────────────────────────────────────────┘
                      △                       △
                      │                       │
          ┌───────────┴───────────┐   ┌──────┴─────────────────┐
          │  TerminalExpression   │   │  NonterminalExpression │
          │  (终结符表达式)        │   │  (非终结符表达式)       │
          │───────────────────────│   │────────────────────────│
          │ 数字、变量             │   │ 加减乘除、逻辑运算      │
          │ + interpret()         │   │ - expressions[]        │
          └───────────────────────┘   │ + interpret()          │
                                      └────────────────────────┘

  示例 AST 结构: "3 + 5 * 2"

                      [+]
                     /   \
                   [3]   [*]
                        /   \
                      [5]   [2]

  终结符: 3, 5, 2 (无法再分解)
  非终结符: +, * (由更小的表达式组成)

---
  实际应用：布尔表达式解释器
```cpp
  #include <iostream>
  #include <string>
  #include <map>

  // 布尔表达式接口
  class BooleanExpr {
  public:
      virtual ~BooleanExpr() = default;
      virtual bool evaluate(const std::map<std::string, bool>& context) = 0;
  };

  // 变量
  class Variable : public BooleanExpr {
      std::string m_name;
  public:
      Variable(const std::string& name) : m_name(name) {}
      bool evaluate(const std::map<std::string, bool>& ctx) override {
          auto it = ctx.find(m_name);
          return it != ctx.end() ? it->second : false;
      }
  };

  // 常量
  class Constant : public BooleanExpr {
      bool m_value;
  public:
      Constant(bool v) : m_value(v) {}
      bool evaluate(const std::map<std::string, bool>&) override {
          return m_value;
      }
  };

  // AND 操作
  class AndExpr : public BooleanExpr {
      std::unique_ptr<BooleanExpr> m_left, m_right;
  public:
      AndExpr(std::unique_ptr<BooleanExpr> l, std::unique_ptr<BooleanExpr> r)
          : m_left(std::move(l)), m_right(std::move(r)) {}
      bool evaluate(const std::map<std::string, bool>& ctx) override {
          return m_left->evaluate(ctx) && m_right->evaluate(ctx);
      }
  };

  // OR 操作
  class OrExpr : public BooleanExpr {
      std::unique_ptr<BooleanExpr> m_left, m_right;
  public:
      OrExpr(std::unique_ptr<BooleanExpr> l, std::unique_ptr<BooleanExpr> r)
          : m_left(std::move(l)), m_right(std::move(r)) {}
      bool evaluate(const std::map<std::string, bool>& ctx) override {
          return m_left->evaluate(ctx) || m_right->evaluate(ctx);
      }
  };

  // NOT 操作
  class NotExpr : public BooleanExpr {
      std::unique_ptr<BooleanExpr> m_expr;
  public:
      NotExpr(std::unique_ptr<BooleanExpr> e) : m_expr(std::move(e)) {}
      bool evaluate(const std::map<std::string, bool>& ctx) override {
          return !m_expr->evaluate(ctx);
      }
  };

  int main() {
      // 表达式: (A AND B) OR (NOT C)
      auto expr = std::make_unique<OrExpr>(
          std::make_unique<AndExpr>(
              std::make_unique<Variable>("A"),
              std::make_unique<Variable>("B")
          ),
          std::make_unique<NotExpr>(
              std::make_unique<Variable>("C")
          )
      );
{% raw %}
      // 测试不同上下文
      std::vector<std::map<std::string, bool>> contexts = {
          {{"A", true},  {"B", true},  {"C", false}},  // T AND T OR NOT F = T
          {{"A", false}, {"B", true},  {"C", false}},  // F AND T OR NOT F = T
          {{"A", true},  {"B", false}, {"C", true}},   // T AND F OR NOT T = F
      };
{% endraw %}
      for (size_t i = 0; i < contexts.size(); ++i) {
          bool result = expr->evaluate(contexts[i]);
          std::cout << "Context " << i+1 << ": "
                    << "A=" << contexts[i].at("A") << ", "
                    << "B=" << contexts[i].at("B") << ", "
                    << "C=" << contexts[i].at("C")
                    << " => (A AND B) OR (NOT C) = " << (result ? "true" : "false")
                    << std::endl;
      }

      return 0;
  }
```
  输出：
  Context 1: A=1, B=1, C=0 => (A AND B) OR (NOT C) = true
  Context 2: A=0, B=1, C=0 => (A AND B) OR (NOT C) = true
  Context 3: A=1, B=0, C=1 => (A AND B) OR (NOT C) = false

---
  文法规则表示

  使用 BNF（巴克斯-瑙尔范式）定义文法：

  表达式文法:
  ────────────────────────────────────────
  expression ::= term { ('+' | '-') term }*
  term       ::= factor { ('*' | '/') factor }*
  factor     ::= number | '(' expression ')'
  number     ::= digit { digit }*
  digit      ::= '0' | '1' | ... | '9'
  ────────────────────────────────────────

  每条文法规则 → 一个类
  expression → Expression 类
  term       → Term 类
  factor     → Factor 类
  number     → NumberExpression 类

---
  适用场景

  ┌─────────────────────┬──────────────────────┐
  │        场景         │         说明         │
  ├─────────────────────┼──────────────────────┤
  │ DSL（领域特定语言） │ SQL 解析、正则表达式 │
  ├─────────────────────┼──────────────────────┤
  │ 配置文件解析        │ 自定义配置语法       │
  ├─────────────────────┼──────────────────────┤
  │ 表达式求值          │ 计算器、公式引擎     │
  ├─────────────────────┼──────────────────────┤
  │ 规则引擎            │ 业务规则判断         │
  ├─────────────────────┼──────────────────────┤
  │ 编译器前端          │ 语法分析、AST 构建   │
  └─────────────────────┴──────────────────────┘

---
  与组合模式的关系

  解释器模式大量使用组合模式构建语法树：

  解释器模式 = 组合模式 + 解释逻辑

  组合模式：构建树形结构
  解释器模式：在树形结构上增加 interpret() 操作

  Expression (Component)
      ├── NumberExpr (Leaf) - 终结符
      └── BinaryExpr (Composite) - 非终结符
              ├── left: Expression
              └── right: Expression

---
  优缺点

  优点：
  - 每条文法规则一个类，易于维护
  - 易于扩展新文法规则
  - 可以方便地实现复杂的文法

  缺点：
  - 文法复杂时类数量爆炸
  - 效率问题（递归解释）
  - 对于简单场景过度设计

---
  实际应用建议

  ┌────────────────────────────────────────────────────────────┐
  │                    是否使用解释器模式？                      │
  ├────────────────────────────────────────────────────────────┤
  │  ✓ 文法简单且相对稳定                                       │
  │  ✓ 对效率要求不高                                           │
  │  ✓ 需要灵活扩展表达式                                       │
  ├────────────────────────────────────────────────────────────┤
  │  ✗ 文法非常复杂 → 考虑解析器生成器           │
  │  ✗ 高性能要求 → 编译成字节码或直接编译                       │
  │  ✗ 简单的字符串处理 → 正则表达式或现有解析库                 │
  └────────────────────────────────────────────────────────────┘

---
  总结：解释器模式本质是用类来表示文法规则，通过组合构建抽象语法树，然后递归解释执行。适用于需要解析自定义语法或表达式的场景，但在实际开发中，复杂语法解析通常使用专门工具（ANTLR、Flex/Bison 等）。

