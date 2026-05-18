---
layout: post_layout
title: "无锁编程之std::atomic"
date: 2025-09-01 21:59:44 +0800
categories: [并发编程]
location: 西安
excerpt_separator: "```"
---

<p style="text-indent: 2em">无锁编程是一种高级的并发编程范式，它通过使用原子操作和内存顺序来避免使用传统的互斥锁，从而在某些场景下可以实现更高的性能和可扩展性。</p><p style="text-indent: 2em"><strong>1.核心思想：</strong><code>std::atomic</code> </p><p style="text-indent: 2em">无锁编程的基石。它保证了对该对象的操作是原子的、不可分割的。这意味着一个线程写入<code>atomic</code> 变量的同时，另一个线程读取它，只会看到写入前或者写入后的完整值，绝不会看到一个半成品(例如：一个只写了一半的结构体)。</p><p style="text-indent: 2em">基础类型 ( 如<code>int</code> <code>bool</code> <code>pointer</code> )的<code>std::atomic</code> 特化通常会被编译器直接翻译为底层平台的原子指令( 如x86的<code>LOCK</code> 前缀指令)，这些特化是无锁的。你可以通过<code>is_always_lock_free()</code> 或者<code>is_lock_free()</code> 成员函数来检查。</p><pre><code class="language-auto">std::atomic&lt;int&gt; counter;
if (counter.is_lock_free())
{
  std::out&lt;&lt;"This atomic&lt;int&gt; is lock-free"&lt;&lt;std::endl  
}</code></pre><p style="text-indent: 2em"><strong>2."无锁"的真正含义</strong></p><p style="text-indent: 2em"><strong>“</strong>无锁<strong>”</strong>并不意味着<strong>“</strong>没有同步<strong>”。</strong>它的精确定义是：<span color="#dc2626" style="color: #dc2626">系统中至少有一个线程能够保持继续前进，而不管其他线程的状态如何。</span></p><p style="text-indent: 2em">这通常通过原子操作和循环（使用<code>compare_exchange_weak/compare_exchange_strong</code>）来实现。如果一个线程在操作时被挂起(例如：被操作系统调度中断)，它不会阻塞其他想要操作相同数据的线程。其他线程可以继续运行他们的循环并完成操作。</p><p style="text-indent: 2em">这与基于锁的编程形成鲜明对比：如果一个线程持有一把锁然后被挂起，其他视图获取该锁的线程都会被阻塞，整个系统可能因此停滞。</p><p style="text-indent: 2em"><span color="#b91c1c" style="color: #b91c1c">重要区别：</span></p><p style="text-indent: 2em">无锁：保证系统整体不会因为某个线程挂起而死锁，但个别线程可能会被“饿死”(一直循环失败);</p><p style="text-indent: 2em">无等待：一个更强的保证，每个线程都能在有限步内完成操作，不会饿死。实现起来及其复杂。</p><p style="text-indent: 2em"><strong>3.关键工具：</strong><code>compare_exchange</code> (CAS)</p><p style="text-indent: 2em">这是无锁编程中最重要的操作，全程是“比较并交换”。它是由一条硬件实现的原子指令。</p><p style="text-indent: 2em"><code>compare_exchange_weak</code>  / <code>compare_exchange_strong</code> </p><ul><li><p style="text-indent: 2em"><strong>工作原理</strong>：它会原子地完成以下步骤：</p></li></ul><p style="text-indent: 2em">1.比较原子变量的当前值是否与预期值相同</p><p style="text-indent: 2em">2.如果相同，则将原子变量的值设置为目标值，操作成功，返回<code>true</code> </p><p style="text-indent: 2em">3.如果不同，则将预期值更新为原子变量的当前值，操作失败，返回<code>false</code> </p><ul><li><p style="text-indent: 2em"><strong>Weak vs Strong:</strong><code>weak</code> 版本可能在即使值相等的情况下也失败（伪失败，通常发生在某些平台上），所以它必须在循环中。<code>strong</code> 版本则不会产生这种伪失败，但可能性能稍差。在大多数情况下，在循环里使用<code>weak</code> 是标准做法。</p></li></ul><pre><code>//无锁栈的Push操作

template&lt;typename T&gt;
class LockFreeStack {
private:
    struct Node {
        T data;
        Node* next;
        Node(const T&amp; data) : data(data), next(nullptr) {}
    };
    std::atomic&lt;Node*&gt; head;

public:
    void push(const T&amp; data) {
        Node* new_node = new Node(data);
        new_node-&gt;next = head.load(); // 1. 读取当前头节点

        // 2. 循环尝试更新 head
        // 如果 head 仍然等于我们之前读取的 new_node-&gt;next (期望值)
        // 则将 head 设置为我们的 new_node (目标值)
        while (!head.compare_exchange_weak(new_node-&gt;next, new_node)) {
            // 如果 CAS 失败，说明有其他线程修改了 head
            // compare_exchange_weak 自动将 new_node-&gt;next 更新为了最新的 head
            // 所以我们现在只需要重试即可
        }
    }
};</code></pre><p style="text-indent: 2em"></p><p style="text-indent: 2em"><strong>4.内存顺序</strong></p><p style="text-indent: 2em">这是无锁编程中最复杂、最微妙的地方。它规定了原子操作周围的内存访问（对非原子变量）的可见性顺序。<code>std::memory_order</code> 允许你放松默认的<strong>顺序一致性 </strong>（<code>std::memory_order_seq_cst</code>）约束，以获取更高的性能。</p><p style="text-indent: 2em"><code>std::memory_order_seq_cst:</code> 最严格的排序。所有线程看到的操作顺序都一致。性能开销最大。是<code>load</code> 和 <code>store</code> 的默认参数</p><p style="text-indent: 2em"><code>std::memory_order_acquire:</code> 通常用于读操作。保证当前线程中<strong>之后</strong>的所有读/写操作不会被重排到该Acquire操作之前</p><p style="text-indent: 2em"><code>std::memory_order_release:</code> 通常用于写操作。保证当前线程中<strong>之前</strong>的所有读/写操作不会被重排到该relase操作之后</p><p style="text-indent: 2em"><code>std::memory_order_relaxed:</code> 只保证原子性，不提供任何同步或者顺序保证。非常快，但是极难正确使用。</p><pre><code>//Acquire-Release 语义示例
std::atomic&lt;bool&gt; ready{false};
int data = 0;

// Thread 1 (Producer)
data = 42; // 1. 写入一些数据
ready.store(true, std::memory_order_release); // 2. 发布标志。第 1 步保证在第 2 步之后对其他线程可见

// Thread 2 (Consumer)
while (!ready.load(std::memory_order_acquire)) { // 3. 获取标志
    // spin...
}
std::cout &lt;&lt; data; // 4. 这里一定会看到 42
                   // 因为 acquire-load 同步了 release-store</code></pre><p style="text-indent: 2em"><span style="font-size: 16.002px; color: rgb(64, 64, 64)">除非你非常清楚自己在做什么，否则最好从 </span><code>memory_order_seq_cst</code><span style="font-size: 16.002px; color: rgb(64, 64, 64)"> 开始，只有在性能分析证明其是瓶颈后，才在极小的、精心验证的代码段中使用更宽松的内存顺序。</span></p><p style="text-indent: 2em"></p><p style="text-indent: 2em"></p><p style="text-indent: 2em"></p><p style="text-indent: 2em"></p><p style="text-indent: 2em"></p><p style="text-indent: 2em"></p><p style="text-indent: 2em"></p><p style="text-indent: 2em"></p>