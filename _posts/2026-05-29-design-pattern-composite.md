---
title: "设计模式详解：组合模式（Composite）"
categories: [设计模式]
location: 西安
render_with_liquid: false
---

#### 组合模式
一、核心思想

  将对象组合成树形结构，统一处理个别对象和组合对象。

  客户端统一接口
        │
        ▼
  ┌─────────────────────────────────────────┐
  │  Component (统一对待单个对象和组合对象)   │
  └─────────────────────────────────────────┘
        │
        ├─► Leaf (叶子节点 - 无子节点)
        │
        └─► Composite (组合节点 - 可包含子节点)
                │
                ├─► Leaf
                ├─► Leaf
                └─► Composite
                        │
                        └─► Leaf

---
  二、模式结构

  ┌─────────────────────────────────────────────────────────────────┐
  │                   Component (抽象组件)                           │
  │  ┌─────────────────────────────────────────────────────────┐   │
  │  │ + operation()          // 业务操作                        │   │
  │  │ + add(Component)       // 添加子节点                      │   │
  │  │ + remove(Component)    // 移除子节点                      │   │
  │  │ + getChild(int)        // 获取子节点                      │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────┘
              ▲                               ▲
              │                               │
  ┌───────────┴───────────┐       ┌───────────┴───────────┐
  │        Leaf           │       │      Composite        │
  │      (叶子节点)        │       │     (组合节点)         │
  │                       │       │ ┌───────────────────┐ │
  │ + operation()         │       │ │ - children[]      │ │
  │ + add()  { 空/异常 }   │       │ │ + operation()     │ │
  │ + remove() { 空/异常 } │       │ │ { 遍历children    │ │
  │                       │       │ │   调用operation } │ │
  │                       │       │ │ + add(c)          │ │
  │                       │       │ │ + remove(c)       │ │
  │                       │       │ └───────────────────┘ │
  └───────────────────────┘       └───────────────────────┘

---
  三、标准实现

  // 抽象组件
  class Component {
  public:
      virtual ~Component() = default;
      virtual void operation() = 0;

      // 默认实现（叶子节点不需要重写）
      virtual void add(Component* c) { throw std::runtime_error("不支持"); }
      virtual void remove(Component* c) { throw std::runtime_error("不支持"); }
      virtual Component* getChild(int i) { return nullptr; }
  };

  // 叶子节点
  class Leaf : public Component {
  public:
      Leaf(const std::string& name) : m_name(name) {}

      void operation() override {
          std::cout << "Leaf " << m_name << " 执行操作\n";
      }

  private:
      std::string m_name;
  };

  // 组合节点
  class Composite : public Component {
  public:
      Composite(const std::string& name) : m_name(name) {}

      void operation() override {
          std::cout << "Composite " << m_name << " 开始执行:\n";
          for (auto* child : m_children) {
              child->operation();  // 递归调用子节点
          }
      }
    
      void add(Component* c) override {
          m_children.push_back(c);
      }
    
      void remove(Component* c) override {
          m_children.remove(c);
      }

  private:
      std::string m_name;
      std::list<Component*> m_children;
  };

  // 使用示例
  int main() {
      Component* root = new Composite("Root");
      Component* branch1 = new Composite("Branch1");
      Component* branch2 = new Composite("Branch2");

      branch1->add(new Leaf("Leaf1"));
      branch1->add(new Leaf("Leaf2"));
    
      branch2->add(new Leaf("Leaf3"));
    
      root->add(branch1);
      root->add(branch2);
    
      root->operation();  // 统一调用，递归执行所有节点
  }

  输出：
  Composite Root 开始执行:
  Composite Branch1 开始执行:
  Leaf Leaf1 执行操作
  Leaf Leaf2 执行操作
  Composite Branch2 开始执行:
  Leaf Leaf3 执行操作

---
  四、VQRS 组合模式实现

  1. 基础框架 (VQRS/Utility/Handler.h)

  // 抽象组件 - 分析任务组件
  class AnComponent {
  public:
      AnComponent() {}
      virtual ~AnComponent() {}

      virtual int handleComponent(CMsg &msg) = 0;
    
      virtual int add(AnComponent *pComponent) = 0;
      virtual int remove(AnComponent *pComponent) = 0;
  };

  // 组合节点 - 可包含子任务
  class AnComposite : public AnComponent {
  public:
      virtual int handleComponent(CMsg &msg) {
          // 遍历所有子组件，逐一处理
          for (std::list<AnComponent*>::iterator it = m_Chlid.begin();
               it != m_Chlid.end(); it++) {
              (*it)->handleComponent(msg);
          }
          return 0;
      }

      virtual int add(AnComponent *pComponent) {
          m_Chlid.push_back(pComponent);
          return 0;
      }
    
      virtual int remove(AnComponent *pComponent) {
          m_Chlid.remove(pComponent);
          return 0;
      }

  private:
      std::list<AnComponent*> m_Chlid;  // 子组件列表
  };

  // 叶子节点 - 不可包含子任务
  class AnLeaf : public AnComponent {
  public:
      virtual int handleComponent(CMsg &msg) = 0;

      virtual int add(AnComponent *pComponent) { return 0; }
      virtual int remove(AnComponent *pComponent) { return 0; }
  };

  2. 分析任务组合 (VQRS/VideoAnalyzeManage/AnalyzeManager.h)

  // 具体叶子节点 - 各种分析任务
  class CAnalyzeTaskVideoDia : public AnLeaf, public CSubject {
  public:
      virtual int handleComponent(CMsg &msg);
      int DealMainAnalyzeProcesses(DaoVideoRoutingInfo &stVideoRoutingInfo);
      int DealResultMessage(DaoVideoRoutingInfo &stVideoRoutingInfo);
  };

  class CAnalyzeTaskAudioDia : public AnLeaf, public CSubject { /* ... */ };
  class CAnalyzeTaskOsd : public AnLeaf, public CSubject { /* ... */ };
  class CAnalyzeTaskBitStream : public AnLeaf, public CSubject { /* ... */ };
  class CAnalyzeTaskVideoBigDia : public AnLeaf, public CSubject { /* ... */ };
  class CAnalyzeTaskNetworDia : public AnLeaf, public CSubject { /* ... */ };
  class CAnalyzeTaskLinkDia : public AnLeaf, public CSubject { /* ... */ };
  class CAnalyzeTaskPullStream : public AnLeaf, public CSubject { /* ... */ };

  // 结果聚合节点（叶子，但作为观察者）
  class CAnalyzeTaskBaseEnd : public AnLeaf, public CObserver {
  public:
      virtual int handleComponent(CMsg &msg);
      int update(CMsg &msg);  // 收集各任务结果
  };

  // 组合节点 - 整合所有分析任务
  class CAnalyzeTask : public AnComposite, public CObserver {
  public:
      CAnalyzeTask() {
          // 组合所有子任务
          add(&m_oTaskAudioDia);      // 音频诊断
          add(&m_oTaskPullStream);    // 拉流任务
          add(&m_oTaskVideoDia);      // 视频诊断
          add(&m_oTaskVideoBigDia);   // 大模型诊断
          add(&m_oTaskOsdCaption);    // OSD检测
          add(&m_oTaskBitStream);     // 码流分析
          add(&m_oTaskNetworkDia);    // 网络诊断
          add(&m_oTaskLinkDia);       // 链路诊断
      }

  private:
      CAnalyzeTaskAudioDia    m_oTaskAudioDia;
      CAnalyzeTaskPullStream  m_oTaskPullStream;
      CAnalyzeTaskVideoDia    m_oTaskVideoDia;
      CAnalyzeTaskVideoBigDia m_oTaskVideoBigDia;
      CAnalyzeTaskOsd         m_oTaskOsdCaption;
      CAnalyzeTaskBitStream   m_oTaskBitStream;
      CAnalyzeTaskNetworDia   m_oTaskNetworkDia;
      CAnalyzeTaskLinkDia     m_oTaskLinkDia;
      CAnalyzeTaskBaseEnd     m_oAnlyzeTaskResult;  // 结果聚合
  };

  3. 任务树结构

  ┌─────────────────────────────────────────────────────────────────────┐
  │                       CAnalyzeTask (Composite)                       │
  │                           分析任务总控                               │
  └─────────────────────────────────────────────────────────────────────┘
      │
      ├── add() ─────────────────────────────────────────────────────┐
      │                                                              │
      ▼                                                              ▼
  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
  │CAnalyzeTask     │  │CAnalyzeTask     │  │CAnalyzeTask     │
  │  AudioDia       │  │  VideoDia       │  │  VideoBigDia    │
  │   (Leaf)        │  │   (Leaf)        │  │   (Leaf)        │
  │  音频诊断        │  │  视频诊断        │  │  大模型诊断      │
  └─────────────────┘  └─────────────────┘  └─────────────────┘

  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
  │CAnalyzeTask     │  │CAnalyzeTask     │  │CAnalyzeTask     │
  │  OsdCaption     │  │  BitStream      │  │  NetworkDia     │
  │   (Leaf)        │  │   (Leaf)        │  │   (Leaf)        │
  │  OSD字幕检测     │  │  码流分析        │  │  网络诊断        │
  └─────────────────┘  └─────────────────┘  └─────────────────┘

  ┌─────────────────┐  ┌─────────────────┐
  │CAnalyzeTask     │  │CAnalyzeTask     │
  │  LinkDia        │  │  PullStream     │
  │   (Leaf)        │  │   (Leaf)        │
  │  链路诊断        │  │  拉流任务        │
  └─────────────────┘  └─────────────────┘

---
  五、组合模式的两种形态

  1. 透明式

  // 所有方法都在 Component 中定义（默认实现或抛异常）
  class Component {
  public:
      virtual void operation() = 0;
      virtual void add(Component* c) { /* 默认空实现 */ }
      virtual void remove(Component* c) { /* 默认空实现 */ }
  };

  // 优点：客户端统一对待
  // 缺点：Leaf 可能收到无意义的 add/remove 调用

  2. 安全式

  // add/remove 只在 Composite 中定义
  class Component {
  public:
      virtual void operation() = 0;
  };

  class Composite : public Component {
  public:
      void add(Component* c);
      void remove(Component* c);
  };

  // 使用时需要类型判断
  Composite* comp = dynamic_cast<Composite*>(component);
  if (comp) {
      comp->add(new Leaf());
  }

  // 优点：类型安全
  // 缺点：需要类型转换

  VQRS 采用透明式：add/remove 在基类声明，Leaf 返回空值。

---
  六、组合模式 + 观察者模式

  VQRS 中组合了多种设计模式：

  // 叶子节点同时是 Subject（被观察者）
  class CAnalyzeTaskVideoDia : public AnLeaf, public CSubject {
      // 完成分析后通知观察者
  };

  // 结果聚合节点是 Observer（观察者）
  class CAnalyzeTaskBaseEnd : public AnLeaf, public CObserver {
      // 接收各任务的结果通知
  };

  // 组合节点也是 Observer
  class CAnalyzeTask : public AnComposite, public CObserver {
      // 监听任务完成事件
  };

  数据流：

  ┌───────────────────────────────────────────────────────────────┐
  │                    Subject (被观察者)                          │
  │  ┌─────────────────────────────────────────────────────────┐ │
  │  │ CAnalyzeTaskVideoDia / AudioDia / Osd ...               │ │
  │  │                                                          │ │
  │  │ 完成分析 → notify() → 通知观察者                          │ │
  │  └─────────────────────────────────────────────────────────┘ │
  └───────────────────────────────────────────────────────────────┘
                            │
                            │ notify(CMsg)
                            ▼
  ┌───────────────────────────────────────────────────────────────┐
  │                    Observer (观察者)                           │
  │  ┌─────────────────────────────────────────────────────────┐ │
  │  │ CAnalyzeTaskBaseEnd                                      │ │
  │  │                                                          │ │
  │  │ update(CMsg) → 聚合所有诊断结果                           │ │
  │  └─────────────────────────────────────────────────────────┘ │
  └───────────────────────────────────────────────────────────────┘

---
  七、组合模式 vs 其他模式

  ┌────────┬───────────────┬──────────┬────────────────────┐
  │  模式  │     目的      │   结构   │      典型场景      │
  ├────────┼───────────────┼──────────┼────────────────────┤
  │ 组合   │ 部分-整体层次 │ 树形结构 │ 文件系统、组织架构 │
  ├────────┼───────────────┼──────────┼────────────────────┤
  │ 装饰器 │ 动态添加职责  │ 链式包装 │ I/O流、功能增强    │
  ├────────┼───────────────┼──────────┼────────────────────┤
  │ 责任链 │ 请求传递处理  │ 链式传递 │ 审批流程、事件处理 │
  ├────────┼───────────────┼──────────┼────────────────────┤
  │ 迭代器 │ 遍历集合      │ 线性访问 │ 列表遍历           │
  └────────┴───────────────┴──────────┴────────────────────┘

  组合：      Composite ← add ─ Leaf     (树形，整体-部分)
  装饰器：    Decorator ← wraps ─ Component (链式，增强功能)
  责任链：    Handler ← next ─ Handler    (链式，请求传递)

---
  八、设计要点

  ┌──────────┬────────────────────────────────────┐
  │   要点   │                说明                │
  ├──────────┼────────────────────────────────────┤
  │ 统一接口 │ Leaf 和 Composite 实现相同接口     │
  ├──────────┼────────────────────────────────────┤
  │ 递归结构 │ Composite 的操作通常递归调用子节点 │
  ├──────────┼────────────────────────────────────┤
  │ 父子关系 │ 子节点可持有父节点引用（便于遍历） │
  ├──────────┼────────────────────────────────────┤
  │ 内存管理 │ 明确子节点的生命周期归属           │
  ├──────────┼────────────────────────────────────┤
  │ 引用计数 │ 子节点可能被多个 Composite 共享    │
  └──────────┴────────────────────────────────────┘

---
  九、适用场景

  适合使用：
  - 表示部分-整体的层次结构
  - 希望用户统一对待单个对象和组合对象
  - 树形菜单、文件系统、组织架构

  不适合使用：
  - 层次结构简单或固定
  - 叶子和组合差异很大
  - 不需要递归遍历

---
  十、实际应用示例

  文件系统

  class FileSystemNode {
  public:
      virtual std::string getName() = 0;
      virtual int getSize() = 0;
      virtual void add(FileSystemNode* node) { }
      virtual void remove(FileSystemNode* node) { }
  };

  class File : public FileSystemNode {
      std::string m_name;
      int m_size;
  public:
      File(const std::string& name, int size)
          : m_name(name), m_size(size) {}
      std::string getName() { return m_name; }
      int getSize() { return m_size; }
  };

  class Directory : public FileSystemNode {
      std::string m_name;
      std::vector<FileSystemNode*> m_children;
  public:
      Directory(const std::string& name) : m_name(name) {}

      std::string getName() { return m_name; }
    
      int getSize() {
          int total = 0;
          for (auto* child : m_children) {
              total += child->getSize();  // 递归计算
          }
          return total;
      }
    
      void add(FileSystemNode* node) { m_children.push_back(node); }
      void remove(FileSystemNode* node) { /* ... */ }
  };

  // 使用
  Directory* root = new Directory("root");
  root->add(new File("file1.txt", 100));
  root->add(new File("file2.txt", 200));

  Directory* subdir = new Directory("subdir");
  subdir->add(new File("file3.txt", 300));
  root->add(subdir);

  std::cout << root->getSize();  // 600

  组织架构

  class Employee {
  public:
      virtual void print() = 0;
      virtual void add(Employee* e) { }
  };

  class IndividualEmployee : public Employee {
      std::string m_name;
  public:
      IndividualEmployee(const std::string& name) : m_name(name) {}
      void print() { std::cout << "员工: " << m_name << "\n"; }
  };

  class Manager : public Employee {
      std::string m_name;
      std::vector<Employee*> m_subordinates;
  public:
      Manager(const std::string& name) : m_name(name) {}

      void print() {
          std::cout << "经理: " << m_name << "\n";
          for (auto* sub : m_subordinates) {
              sub->print();  // 递归打印下属
          }
      }
    
      void add(Employee* e) { m_subordinates.push_back(e); }
  };

---
  十一、组合模式的遍历

  1. 深度优先遍历

  void traverse(Component* node, int depth = 0) {
      std::cout << std::string(depth * 2, ' ') << node->getName() << "\n";
      for (int i = 0; i < node->getChildCount(); i++) {
          traverse(node->getChild(i), depth + 1);
      }
  }

  2. 广度优先遍历

  void bfs(Component* root) {
      std::queue<Component*> q;
      q.push(root);

      while (!q.empty()) {
          Component* node = q.front();
          q.pop();
    
          std::cout << node->getName() << "\n";
    
          for (int i = 0; i < node->getChildCount(); i++) {
              q.push(node->getChild(i));
          }
      }
  }

  3. 使用迭代器模式

  class CompositeIterator {
  public:
      CompositeIterator(Component* root) { m_stack.push(root); }

      bool hasNext() { return !m_stack.empty(); }
    
      Component* next() {
          Component* current = m_stack.top();
          m_stack.pop();
    
          // 将子节点压栈（逆序保证顺序）
          for (int i = current->getChildCount() - 1; i >= 0; i--) {
              m_stack.push(current->getChild(i));
          }
    
          return current;
      }

  private:
      std::stack<Component*> m_stack;
  };
