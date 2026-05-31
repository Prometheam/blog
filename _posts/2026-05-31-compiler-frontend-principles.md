---
title: "编译器前端原理：Lexer、Parser与AST构建"
categories: [C++语言]
location: 西安
render_with_liquid: false
---

### 引言

编译器不只是"学术课题"。作为后端开发者，你可能需要：解析配置DSL、实现查询语言、构建规则引擎、编写代码生成器。这些场景的核心技术都是编译器前端——词法分析、语法分析、AST构建。

我在项目中实现过一个规则表达式引擎（类似`if order.amount > 1000 and user.vip then approve`），核心就是一个递归下降解析器 + AST求值器。理解了编译器前端，这类需求可以在几百行代码内优雅解决。

本文讲解编译器前端的完整流程：Lexer（词法分析）→ Parser（语法分析）→ AST（抽象语法树），并用C++实现一个可计算的表达式语言。

---

### 1. 编译器前端流程

```
  源代码到可执行的完整流程：

  ┌──────────────────────────────────────────────────────────────┐
  │                      前端 (Front End)                         │
  │                                                              │
  │  源代码 → [Lexer] → Token流 → [Parser] → AST → [语义分析]   │
  │  "x+1"    词法分析   [ID:x]    语法分析     +    类型检查    │
  │                      [+]                   / \               │
  │                      [NUM:1]              x   1              │
  │                                                              │
  ├──────────────────────────────────────────────────────────────┤
  │                      中端 (Middle End)                        │
  │                                                              │
  │  AST → [IR生成] → IR → [优化Pass] → 优化后IR               │
  │                   三地址码/SSA         常量折叠/死代码消除    │
  │                                                              │
  ├──────────────────────────────────────────────────────────────┤
  │                      后端 (Back End)                          │
  │                                                              │
  │  优化后IR → [指令选择] → [寄存器分配] → [指令调度] → 机器码  │
  └──────────────────────────────────────────────────────────────┘

  本文聚焦前端（Lexer + Parser + AST）
```

---

### 2. 词法分析器（Lexer）

将字符流转换为Token流：

```cpp
#include <string>
#include <vector>
#include <variant>
#include <optional>
#include <stdexcept>

// Token类型
enum class TokenType {
    // 字面量
    INTEGER,    // 123
    FLOAT,      // 3.14
    STRING,     // "hello"
    IDENTIFIER, // variable_name

    // 运算符
    PLUS, MINUS, STAR, SLASH, PERCENT,  // + - * / %
    EQ, NEQ, LT, GT, LTE, GTE,         // == != < > <= >=
    AND, OR, NOT,                        // and or not
    ASSIGN,                              // =

    // 分隔符
    LPAREN, RPAREN,  // ( )
    LBRACE, RBRACE,  // { }
    COMMA, SEMICOLON, DOT,

    // 关键字
    KW_IF, KW_ELSE, KW_WHILE, KW_RETURN,
    KW_TRUE, KW_FALSE, KW_NULL,
    KW_FN, KW_LET,

    // 特殊
    END_OF_FILE,
    ERROR
};

struct Token {
    TokenType type;
    std::string value;
    int line;
    int column;
};

class Lexer {
public:
    explicit Lexer(const std::string& source)
        : source_(source), pos_(0), line_(1), col_(1) {}

    std::vector<Token> tokenize() {
        std::vector<Token> tokens;
        while (pos_ < source_.size()) {
            skipWhitespace();
            if (pos_ >= source_.size()) break;

            Token token = nextToken();
            if (token.type != TokenType::ERROR) {
                tokens.push_back(token);
            }
        }
        tokens.push_back({TokenType::END_OF_FILE, "", line_, col_});
        return tokens;
    }

private:
    Token nextToken() {
        char c = current();
        int start_line = line_, start_col = col_;

        // 数字
        if (isdigit(c)) return lexNumber(start_line, start_col);

        // 标识符/关键字
        if (isalpha(c) || c == '_') return lexIdentifier(start_line, start_col);

        // 字符串
        if (c == '"') return lexString(start_line, start_col);

        // 运算符和分隔符
        advance();
        switch (c) {
            case '+': return {TokenType::PLUS, "+", start_line, start_col};
            case '-': return {TokenType::MINUS, "-", start_line, start_col};
            case '*': return {TokenType::STAR, "*", start_line, start_col};
            case '/': return {TokenType::SLASH, "/", start_line, start_col};
            case '%': return {TokenType::PERCENT, "%", start_line, start_col};
            case '(': return {TokenType::LPAREN, "(", start_line, start_col};
            case ')': return {TokenType::RPAREN, ")", start_line, start_col};
            case '{': return {TokenType::LBRACE, "{", start_line, start_col};
            case '}': return {TokenType::RBRACE, "}", start_line, start_col};
            case ',': return {TokenType::COMMA, ",", start_line, start_col};
            case ';': return {TokenType::SEMICOLON, ";", start_line, start_col};
            case '.': return {TokenType::DOT, ".", start_line, start_col};
            case '=':
                if (peek() == '=') { advance(); return {TokenType::EQ, "==", start_line, start_col}; }
                return {TokenType::ASSIGN, "=", start_line, start_col};
            case '!':
                if (peek() == '=') { advance(); return {TokenType::NEQ, "!=", start_line, start_col}; }
                return {TokenType::NOT, "!", start_line, start_col};
            case '<':
                if (peek() == '=') { advance(); return {TokenType::LTE, "<=", start_line, start_col}; }
                return {TokenType::LT, "<", start_line, start_col};
            case '>':
                if (peek() == '=') { advance(); return {TokenType::GTE, ">=", start_line, start_col}; }
                return {TokenType::GT, ">", start_line, start_col};
        }

        return {TokenType::ERROR, std::string(1, c), start_line, start_col};
    }

    Token lexNumber(int line, int col) {
        std::string num;
        bool is_float = false;
        while (pos_ < source_.size() && (isdigit(current()) || current() == '.')) {
            if (current() == '.') is_float = true;
            num += current();
            advance();
        }
        return {is_float ? TokenType::FLOAT : TokenType::INTEGER, num, line, col};
    }

    Token lexIdentifier(int line, int col) {
        std::string id;
        while (pos_ < source_.size() && (isalnum(current()) || current() == '_')) {
            id += current();
            advance();
        }
        // 关键字检查
        if (id == "if") return {TokenType::KW_IF, id, line, col};
        if (id == "else") return {TokenType::KW_ELSE, id, line, col};
        if (id == "while") return {TokenType::KW_WHILE, id, line, col};
        if (id == "return") return {TokenType::KW_RETURN, id, line, col};
        if (id == "fn") return {TokenType::KW_FN, id, line, col};
        if (id == "let") return {TokenType::KW_LET, id, line, col};
        if (id == "true") return {TokenType::KW_TRUE, id, line, col};
        if (id == "false") return {TokenType::KW_FALSE, id, line, col};
        if (id == "and") return {TokenType::AND, id, line, col};
        if (id == "or") return {TokenType::OR, id, line, col};
        if (id == "not") return {TokenType::NOT, id, line, col};
        return {TokenType::IDENTIFIER, id, line, col};
    }

    Token lexString(int line, int col) {
        advance(); // skip opening "
        std::string str;
        while (pos_ < source_.size() && current() != '"') {
            if (current() == '\\') { advance(); str += escapeChar(current()); }
            else { str += current(); }
            advance();
        }
        advance(); // skip closing "
        return {TokenType::STRING, str, line, col};
    }

    char current() { return source_[pos_]; }
    char peek() { return pos_ + 1 < source_.size() ? source_[pos_ + 1] : '\0'; }
    void advance() { if (source_[pos_] == '\n') { line_++; col_ = 1; } else { col_++; } pos_++; }
    void skipWhitespace() { while (pos_ < source_.size() && isspace(current())) advance(); }
    char escapeChar(char c) { switch(c) { case 'n': return '\n'; case 't': return '\t'; default: return c; } }

    std::string source_;
    size_t pos_;
    int line_, col_;
};
```

---

### 3. AST 节点定义

```cpp
#include <memory>
#include <variant>
#include <vector>
#include <string>

// AST节点基类
struct ASTNode {
    virtual ~ASTNode() = default;
    int line = 0;
};

using ASTPtr = std::unique_ptr<ASTNode>;

// 表达式节点
struct NumberLiteral : ASTNode { double value; };
struct StringLiteral : ASTNode { std::string value; };
struct BoolLiteral : ASTNode { bool value; };
struct Identifier : ASTNode { std::string name; };

struct BinaryExpr : ASTNode {
    TokenType op;  // +, -, *, /, ==, <, and, or...
    ASTPtr left;
    ASTPtr right;
};

struct UnaryExpr : ASTNode {
    TokenType op;  // -, not
    ASTPtr operand;
};

struct CallExpr : ASTNode {
    std::string callee;
    std::vector<ASTPtr> arguments;
};

struct MemberExpr : ASTNode {
    ASTPtr object;
    std::string member;
};

// 语句节点
struct LetStatement : ASTNode {
    std::string name;
    ASTPtr initializer;
};

struct AssignStatement : ASTNode {
    std::string name;
    ASTPtr value;
};

struct IfStatement : ASTNode {
    ASTPtr condition;
    std::vector<ASTPtr> then_body;
    std::vector<ASTPtr> else_body;
};

struct WhileStatement : ASTNode {
    ASTPtr condition;
    std::vector<ASTPtr> body;
};

struct ReturnStatement : ASTNode {
    ASTPtr value;
};

struct FunctionDecl : ASTNode {
    std::string name;
    std::vector<std::string> params;
    std::vector<ASTPtr> body;
};
```

---

### 4. 递归下降解析器（Parser）

```cpp
class Parser {
public:
    explicit Parser(const std::vector<Token>& tokens)
        : tokens_(tokens), pos_(0) {}

    // 解析程序（顶层）
    std::vector<ASTPtr> parseProgram() {
        std::vector<ASTPtr> statements;
        while (!isAtEnd()) {
            statements.push_back(parseStatement());
        }
        return statements;
    }

private:
    // 语句解析
    ASTPtr parseStatement() {
        if (match(TokenType::KW_LET)) return parseLetStatement();
        if (match(TokenType::KW_IF)) return parseIfStatement();
        if (match(TokenType::KW_WHILE)) return parseWhileStatement();
        if (match(TokenType::KW_FN)) return parseFunctionDecl();
        if (match(TokenType::KW_RETURN)) return parseReturnStatement();
        return parseExpressionStatement();
    }

    ASTPtr parseLetStatement() {
        auto stmt = std::make_unique<LetStatement>();
        stmt->name = consume(TokenType::IDENTIFIER, "Expected variable name").value;
        consume(TokenType::ASSIGN, "Expected '='");
        stmt->initializer = parseExpression();
        consume(TokenType::SEMICOLON, "Expected ';'");
        return stmt;
    }

    ASTPtr parseIfStatement() {
        auto stmt = std::make_unique<IfStatement>();
        stmt->condition = parseExpression();
        consume(TokenType::LBRACE, "Expected '{'");
        while (!check(TokenType::RBRACE) && !isAtEnd()) {
            stmt->then_body.push_back(parseStatement());
        }
        consume(TokenType::RBRACE, "Expected '}'");
        if (match(TokenType::KW_ELSE)) {
            consume(TokenType::LBRACE, "Expected '{'");
            while (!check(TokenType::RBRACE) && !isAtEnd()) {
                stmt->else_body.push_back(parseStatement());
            }
            consume(TokenType::RBRACE, "Expected '}'");
        }
        return stmt;
    }

    // 表达式解析（Pratt Parsing / 优先级爬升）
    ASTPtr parseExpression() {
        return parseOr();
    }

    ASTPtr parseOr() {
        auto left = parseAnd();
        while (match(TokenType::OR)) {
            auto expr = std::make_unique<BinaryExpr>();
            expr->op = TokenType::OR;
            expr->left = std::move(left);
            expr->right = parseAnd();
            left = std::move(expr);
        }
        return left;
    }

    ASTPtr parseAnd() {
        auto left = parseComparison();
        while (match(TokenType::AND)) {
            auto expr = std::make_unique<BinaryExpr>();
            expr->op = TokenType::AND;
            expr->left = std::move(left);
            expr->right = parseComparison();
            left = std::move(expr);
        }
        return left;
    }

    ASTPtr parseComparison() {
        auto left = parseAddition();
        while (match({TokenType::EQ, TokenType::NEQ, TokenType::LT,
                      TokenType::GT, TokenType::LTE, TokenType::GTE})) {
            auto expr = std::make_unique<BinaryExpr>();
            expr->op = previous().type;
            expr->left = std::move(left);
            expr->right = parseAddition();
            left = std::move(expr);
        }
        return left;
    }

    ASTPtr parseAddition() {
        auto left = parseMultiplication();
        while (match({TokenType::PLUS, TokenType::MINUS})) {
            auto expr = std::make_unique<BinaryExpr>();
            expr->op = previous().type;
            expr->left = std::move(left);
            expr->right = parseMultiplication();
            left = std::move(expr);
        }
        return left;
    }

    ASTPtr parseMultiplication() {
        auto left = parseUnary();
        while (match({TokenType::STAR, TokenType::SLASH, TokenType::PERCENT})) {
            auto expr = std::make_unique<BinaryExpr>();
            expr->op = previous().type;
            expr->left = std::move(left);
            expr->right = parseUnary();
            left = std::move(expr);
        }
        return left;
    }

    ASTPtr parseUnary() {
        if (match({TokenType::MINUS, TokenType::NOT})) {
            auto expr = std::make_unique<UnaryExpr>();
            expr->op = previous().type;
            expr->operand = parseUnary();
            return expr;
        }
        return parsePrimary();
    }

    ASTPtr parsePrimary() {
        if (match(TokenType::INTEGER)) {
            auto node = std::make_unique<NumberLiteral>();
            node->value = std::stod(previous().value);
            return node;
        }
        if (match(TokenType::FLOAT)) {
            auto node = std::make_unique<NumberLiteral>();
            node->value = std::stod(previous().value);
            return node;
        }
        if (match(TokenType::STRING)) {
            auto node = std::make_unique<StringLiteral>();
            node->value = previous().value;
            return node;
        }
        if (match(TokenType::KW_TRUE)) {
            auto node = std::make_unique<BoolLiteral>();
            node->value = true;
            return node;
        }
        if (match(TokenType::KW_FALSE)) {
            auto node = std::make_unique<BoolLiteral>();
            node->value = false;
            return node;
        }
        if (match(TokenType::IDENTIFIER)) {
            std::string name = previous().value;
            if (match(TokenType::LPAREN)) {
                // 函数调用
                auto call = std::make_unique<CallExpr>();
                call->callee = name;
                if (!check(TokenType::RPAREN)) {
                    do { call->arguments.push_back(parseExpression()); }
                    while (match(TokenType::COMMA));
                }
                consume(TokenType::RPAREN, "Expected ')'");
                return call;
            }
            auto node = std::make_unique<Identifier>();
            node->name = name;
            return node;
        }
        if (match(TokenType::LPAREN)) {
            auto expr = parseExpression();
            consume(TokenType::RPAREN, "Expected ')'");
            return expr;
        }
        throw std::runtime_error("Unexpected token: " + peek().value);
    }

    // 辅助函数
    bool match(TokenType type) { if (check(type)) { advance(); return true; } return false; }
    bool match(std::initializer_list<TokenType> types) {
        for (auto t : types) if (match(t)) return true;
        return false;
    }
    bool check(TokenType type) { return !isAtEnd() && peek().type == type; }
    Token advance() { if (!isAtEnd()) pos_++; return previous(); }
    Token peek() { return tokens_[pos_]; }
    Token previous() { return tokens_[pos_ - 1]; }
    bool isAtEnd() { return peek().type == TokenType::END_OF_FILE; }
    Token consume(TokenType type, const std::string& msg) {
        if (check(type)) return advance();
        throw std::runtime_error(msg + " at line " + std::to_string(peek().line));
    }

    const std::vector<Token>& tokens_;
    size_t pos_;
};
```

---

### 5. AST 求值器（解释执行）

```cpp
#include <unordered_map>
#include <functional>

using Value = std::variant<double, bool, std::string, std::nullptr_t>;

class Evaluator {
    std::unordered_map<std::string, Value> variables_;
    std::unordered_map<std::string, std::function<Value(std::vector<Value>)>> builtins_;

public:
    Evaluator() {
        // 注册内置函数
        builtins_["print"] = [](auto args) -> Value {
            for (auto& a : args) { /* print */ }
            return nullptr;
        };
        builtins_["abs"] = [](auto args) -> Value {
            return std::abs(std::get<double>(args[0]));
        };
    }

    Value evaluate(ASTNode* node) {
        if (auto* n = dynamic_cast<NumberLiteral*>(node)) return n->value;
        if (auto* n = dynamic_cast<BoolLiteral*>(node)) return n->value;
        if (auto* n = dynamic_cast<StringLiteral*>(node)) return n->value;
        if (auto* n = dynamic_cast<Identifier*>(node)) return variables_.at(n->name);

        if (auto* n = dynamic_cast<BinaryExpr*>(node)) {
            Value left = evaluate(n->left.get());
            Value right = evaluate(n->right.get());
            return evalBinary(n->op, left, right);
        }

        if (auto* n = dynamic_cast<LetStatement*>(node)) {
            variables_[n->name] = evaluate(n->initializer.get());
            return nullptr;
        }

        if (auto* n = dynamic_cast<IfStatement*>(node)) {
            if (isTruthy(evaluate(n->condition.get()))) {
                for (auto& stmt : n->then_body) evaluate(stmt.get());
            } else {
                for (auto& stmt : n->else_body) evaluate(stmt.get());
            }
            return nullptr;
        }

        if (auto* n = dynamic_cast<CallExpr*>(node)) {
            std::vector<Value> args;
            for (auto& arg : n->arguments) args.push_back(evaluate(arg.get()));
            return builtins_.at(n->callee)(args);
        }

        throw std::runtime_error("Unknown AST node type");
    }

private:
    Value evalBinary(TokenType op, Value left, Value right) {
        double l = std::get<double>(left);
        double r = std::get<double>(right);
        switch (op) {
            case TokenType::PLUS:  return l + r;
            case TokenType::MINUS: return l - r;
            case TokenType::STAR:  return l * r;
            case TokenType::SLASH: return l / r;
            case TokenType::LT:    return l < r;
            case TokenType::GT:    return l > r;
            case TokenType::EQ:    return l == r;
            default: throw std::runtime_error("Unknown operator");
        }
    }

    bool isTruthy(Value v) {
        if (auto* b = std::get_if<bool>(&v)) return *b;
        if (auto* d = std::get_if<double>(&v)) return *d != 0;
        return true;
    }
};
```

---

### 6. 完整使用示例

```cpp
int main() {
    std::string source = R"(
        let x = 10;
        let y = 20;
        let result = x * y + 5;
        if result > 100 {
            print("Large result:", result);
        } else {
            print("Small result:", result);
        }
    )";

    // 词法分析
    Lexer lexer(source);
    auto tokens = lexer.tokenize();

    // 语法分析
    Parser parser(tokens);
    auto ast = parser.parseProgram();

    // 解释执行
    Evaluator eval;
    for (auto& node : ast) {
        eval.evaluate(node.get());
    }

    return 0;
}
```

---

### 7. 实际应用场景

| 场景 | 解析的"语言" | 复杂度 |
|------|-------------|--------|
| 配置文件解析 | YAML/TOML/自定义格式 | 低 |
| SQL查询引擎 | SQL子集 | 中 |
| 规则引擎 | 布尔表达式DSL | 中 |
| 模板引擎 | Mustache/Jinja语法 | 中 |
| 着色器编译器 | GLSL/HLSL | 高 |
| 编程语言实现 | 完整语言 | 极高 |

---

### 总结

编译器前端的核心：

1. **Lexer将字符→Token**：正则匹配、关键字识别、跳过空白
2. **Parser将Token→AST**：递归下降是最实用的方法，优先级通过函数嵌套表达
3. **AST是中间表示**：树结构，每个节点代表一个语法结构
4. **递归下降≈手写状态机**：每个语法规则对应一个解析函数
5. **优先级爬升处理运算符**：低优先级的先解析（外层函数），高优先级后解析（内层函数）
6. **错误恢复很重要**：好的解析器在第一个错误后还能继续发现更多错误

掌握编译器前端，你就拥有了"定义新语言"的能力——这在需要DSL的后端系统中是极有价值的技能。
