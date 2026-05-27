---
layout: post_layout
title: "Linux容器网络原理：从Namespace到Kubernetes CNI"
date: 2026-05-28 23:00:00 +0800
categories: [Linux系统]
location: 西安
excerpt_separator: "```"
---

### 引言

容器化部署已经是后端服务的标配，但"容器间怎么通信"这个问题，很多人停留在"Docker自动处理"的认知层面。去年排查一个跨节点服务超时问题时，我不得不深入Linux网络namespace、veth pair、bridge的底层机制才定位到根因——VXLAN封装的MTU未正确设置导致TCP分片重组超时。

这篇文章从Linux Network Namespace讲起，逐步构建出Docker单机网络和Kubernetes跨节点网络的完整图景。理解了这些原理，容器网络问题就不再是黑盒。

---

### 1. Network Namespace：网络隔离的基石

#### 1.1 什么是Network Namespace

```
Linux Network Namespace提供了完整的网络栈隔离：
每个Namespace拥有独立的：
  - 网络接口（eth0, lo）
  - 路由表
  - iptables规则
  - socket端口空间
  - /proc/net 视图

默认Namespace（主机）：
┌──────────────────────────────────┐
│ eth0: 10.0.0.1                   │
│ lo: 127.0.0.1                    │
│ 路由表: default via 10.0.0.254   │
│ iptables: ...                    │
└──────────────────────────────────┘

容器Namespace：
┌──────────────────────────────────┐
│ eth0: 172.17.0.2 (独立!)         │
│ lo: 127.0.0.1                    │
│ 路由表: default via 172.17.0.1   │
│ iptables: (空)                   │
└──────────────────────────────────┘

两者完全隔离：容器内的eth0和主机的eth0是不同的接口
```

#### 1.2 手动创建和操作

```bash
# 创建一个Network Namespace
ip netns add container1

# 在namespace中执行命令
ip netns exec container1 ip addr
# → 只有lo接口，且是DOWN状态

# 启用lo
ip netns exec container1 ip link set lo up

# 查看路由（空）
ip netns exec container1 ip route
```

---

### 2. Veth Pair：连接两个Namespace

#### 2.1 原理

veth（Virtual Ethernet）是成对出现的虚拟网卡——从一端发出的包会从另一端出来，类似一根虚拟网线：

```
┌──────────── 主机Namespace ────────────┐   ┌──── 容器Namespace ────┐
│                                        │   │                       │
│   ┌──────────┐                        │   │    ┌──────────┐       │
│   │ veth-host│◄═══════ veth pair ═════╪═══╪═══►│ veth-ctr │       │
│   │10.0.0.1  │        (虚拟网线)      │   │    │10.0.0.2  │       │
│   └──────────┘                        │   │    └──────────┘       │
│                                        │   │                       │
└────────────────────────────────────────┘   └───────────────────────┘

发送: 容器内往veth-ctr发包 → 包从veth-host出来（进入主机Namespace）
```

#### 2.2 动手实验

```bash
# 创建veth pair
ip link add veth-host type veth peer name veth-ctr

# 将一端移入容器namespace
ip link set veth-ctr netns container1

# 配置主机端IP
ip addr add 10.0.0.1/24 dev veth-host
ip link set veth-host up

# 配置容器端IP
ip netns exec container1 ip addr add 10.0.0.2/24 dev veth-ctr
ip netns exec container1 ip link set veth-ctr up

# 测试连通性
ip netns exec container1 ping 10.0.0.1  # ✓ 容器 → 主机
ping 10.0.0.2                            # ✓ 主机 → 容器
```

---

### 3. Linux Bridge：多容器通信

#### 3.1 为什么需要Bridge

一对veth只能连两个端点。多个容器之间互通需要一个"虚拟交换机"——Linux Bridge：

```
┌────────────────────────── 主机 ──────────────────────────────┐
│                                                              │
│  ┌──────────── docker0 Bridge (172.17.0.1) ──────────────┐  │
│  │                                                        │  │
│  │  port1    port2    port3                               │  │
│  └──┬─────────┬─────────┬────────────────────────────────┘  │
│     │         │         │                                    │
│   veth1     veth2     veth3                                  │
│     ║         ║         ║     (veth pair)                    │
│     ║         ║         ║                                    │
└─────╫─────────╫─────────╫────────────────────────────────────┘
      ║         ║         ║
┌─────╨───┐ ┌───╨───┐ ┌───╨───┐
│Container1│ │Container2│ │Container3│
│172.17.0.2│ │172.17.0.3│ │172.17.0.4│
└──────────┘ └──────────┘ └──────────┘

Bridge的工作方式：
  - 学习MAC地址（和物理交换机一样）
  - 同网段内直接转发（L2转发）
  - 对外通过主机路由+NAT
```

#### 3.2 Docker的默认网络

```bash
# Docker默认创建docker0网桥
brctl show docker0
# bridge name   bridge id           STP enabled   interfaces
# docker0       8000.0242ac110001   no            veth7a3b1f2
#                                                  vethd8c4e3a

# 每启动一个容器，Docker自动：
# 1. 创建veth pair
# 2. 一端放入容器（重命名为eth0）
# 3. 另一端接入docker0网桥
# 4. 给容器分配IP（DHCP或指定）

# 容器间通信：
# Container1(172.17.0.2) → docker0 bridge → Container2(172.17.0.3)
# 纯L2转发，不需要经过iptables
```

---

### 4. 容器访问外网：NAT

#### 4.1 SNAT（容器→外网）

```
容器要访问外网(如8.8.8.8)，需要做源地址转换(SNAT)：

Container(172.17.0.2) → docker0 → 主机路由 → eth0(10.0.0.1) → Internet

iptables规则（Docker自动配置）：
  -t nat -A POSTROUTING -s 172.17.0.0/16 -o eth0 -j MASQUERADE
  
  效果：
    源IP 172.17.0.2 → 替换为主机IP 10.0.0.1
    外网回包时自动反向转换（conntrack跟踪）
```

#### 4.2 DNAT（外网→容器，端口映射）

```bash
# docker run -p 8080:80 nginx
# 将主机8080端口映射到容器80端口

# Docker配置的iptables规则：
iptables -t nat -A PREROUTING -p tcp --dport 8080 \
         -j DNAT --to-destination 172.17.0.2:80

# 效果：
# 外部访问 主机IP:8080 → DNAT → 172.17.0.2:80 (容器内nginx)
```

---

### 5. 跨主机通信：Overlay网络

#### 5.1 问题

```
单机Bridge只能解决同一台主机上的容器通信。
跨主机的容器通信面临的挑战：

Host A 上的 Container1 (172.17.0.2) 想访问
Host B 上的 Container2 (172.17.0.3)

问题：172.17.0.0/16 是私有地址，物理网络不会路由它
解决：需要在物理网络之上建立Overlay网络
```

#### 5.2 VXLAN方案

```
VXLAN (Virtual eXtensible LAN)：在UDP中封装L2帧

┌───────────────── Host A (10.0.0.1) ─────────────────┐
│ Container1 (10.244.1.2)                              │
│   │                                                  │
│   ▼ 原始包: src=10.244.1.2, dst=10.244.2.3         │
│ ┌───────────────────────────────────────────────┐   │
│ │ cni0 Bridge                                    │   │
│ └──────────────────────┬────────────────────────┘   │
│                        ▼                             │
│ ┌───────────────────────────────────────────────┐   │
│ │ VXLAN (flannel.1 / vxlan0)                     │   │
│ │                                                │   │
│ │ 封装: 外层UDP + VXLAN header + 原始L2帧       │   │
│ │ 外层: src=10.0.0.1, dst=10.0.0.2, UDP:4789   │   │
│ └──────────────────────┬────────────────────────┘   │
│                        ▼                             │
│ ┌─────────────────────────────┐                     │
│ │ eth0 (10.0.0.1)             │ →→→ 物理网络 →→→    │
│ └─────────────────────────────┘                     │
└──────────────────────────────────────────────────────┘
                         │
                    物理网络传输(只看到外层UDP包)
                         │
                         ▼
┌───────────────── Host B (10.0.0.2) ─────────────────┐
│ ┌─────────────────────────────┐                     │
│ │ eth0 (10.0.0.2)             │ ←←← 物理网络 ←←←   │
│ └──────────────────────┬──────┘                     │
│                        ▼                             │
│ ┌───────────────────────────────────────────────┐   │
│ │ VXLAN (flannel.1)                              │   │
│ │ 解封装: 去掉外层UDP+VXLAN header              │   │
│ └──────────────────────┬────────────────────────┘   │
│                        ▼                             │
│ ┌───────────────────────────────────────────────┐   │
│ │ cni0 Bridge                                    │   │
│ └──────────────────────┬────────────────────────┘   │
│                        ▼                             │
│ Container2 (10.244.2.3)                              │
└──────────────────────────────────────────────────────┘

注意MTU问题！
  物理网络MTU: 1500
  VXLAN封装overhead: 50字节 (UDP+VXLAN header)
  容器网络有效MTU: 1450
  → 如果容器用1500 MTU发包 → 外层超过1500 → 需要分片 → 性能下降
  → 解决: 容器接口MTU设为1450
```

---

### 6. Kubernetes CNI

#### 6.1 CNI是什么

```
CNI (Container Network Interface): Kubernetes的网络插件标准

Kubernetes不自己实现网络，而是定义了CNI接口：
  ADD: 为Pod配置网络（创建veth、分配IP、配置路由）
  DEL: 清理Pod的网络配置
  CHECK: 检查网络是否正常

常见CNI插件：
┌──────────────┬───────────────────────┬───────────────────────┐
│ 插件         │ 网络模式              │ 特点                  │
├──────────────┼───────────────────────┼───────────────────────┤
│ Flannel      │ VXLAN / host-gw       │ 简单，适合入门        │
│ Calico       │ BGP / VXLAN / eBPF    │ 性能好，支持网络策略  │
│ Cilium       │ eBPF                  │ 最新，性能最强        │
│ Weave        │ VXLAN                 │ 简单，加密支持        │
└──────────────┴───────────────────────┴───────────────────────┘
```

#### 6.2 Pod网络模型

```
Kubernetes网络三大原则：
  1. 所有Pod都有独立IP，Pod间可以直接通过IP通信
  2. 不需要NAT（Pod看到的源IP就是对方Pod的真实IP）
  3. Node上的程序可以直接和Pod通信

一个Pod的网络栈：
┌────────────────── Pod ────────────────────────┐
│  ┌───────────┐    ┌───────────┐              │
│  │ Container1│    │ Container2│              │
│  │ (app)     │    │ (sidecar) │              │
│  └─────┬─────┘    └─────┬─────┘              │
│        │                 │                    │
│  ──────┴─────────────────┴──────────────────  │
│            共享 Network Namespace             │
│            eth0: 10.244.1.5                   │
│            lo: 127.0.0.1                      │
└────────────────────┬──────────────────────────┘
                     │ veth pair
                     ▼
              ┌────────────┐
              │ cni0 Bridge│  (Node上)
              └────────────┘

注意：同一个Pod内的容器共享Network Namespace
     → 它们共享IP，通过localhost互访
     → 这就是sidecar模式的网络基础
```

#### 6.3 Calico的BGP方案（无封装，性能最优）

```
Calico方案：不做封装，直接用三层路由

Host A (10.0.0.1):
  Pod1: 10.244.1.2
  路由表: 10.244.2.0/24 via 10.0.0.2 dev eth0  ← 直接路由到Host B

Host B (10.0.0.2):
  Pod2: 10.244.2.3
  路由表: 10.244.1.0/24 via 10.0.0.1 dev eth0  ← 直接路由到Host A

通信路径：
  Pod1(10.244.1.2) → Host A路由 → 物理网络 → Host B路由 → Pod2(10.244.2.3)
  
  纯三层路由，无封装开销！
  MTU = 物理网络MTU = 1500（无overhead）

路由信息通过BGP协议在节点间同步：
  每个Node运行一个BGP Agent (bird)
  当新Pod创建时，宣告该Pod子网的路由

限制：要求物理网络支持BGP或在同一个L2网段（host-gw模式）
```

---

### 7. 网络问题排查

```bash
# 1. 查看容器的network namespace
pid=$(docker inspect -f '{{.State.Pid}}' container_id)
nsenter -t $pid -n ip addr     # 进入容器网络namespace查看
nsenter -t $pid -n ip route    # 查看容器内路由
nsenter -t $pid -n iptables -L # 查看容器内iptables

# 2. 抓包排查
# 在veth主机端抓包
tcpdump -i veth7a3b1f2 -nn

# 在Bridge上抓包
tcpdump -i docker0 -nn

# 在VXLAN接口抓包（看封装/解封装）
tcpdump -i flannel.1 -nn

# 3. 常见问题诊断
# 容器无法访问外网：
ip netns exec container1 ip route  # 检查默认路由
iptables -t nat -L POSTROUTING     # 检查MASQUERADE规则

# 跨主机容器不通：
# 检查VXLAN接口是否UP
ip link show flannel.1
# 检查FDB(转发表)是否有对端MAC
bridge fdb show dev flannel.1
# 检查ARP是否正确
ip neigh show dev flannel.1

# 4. MTU问题排查（最常见的跨主机问题）
# 如果TCP小包能通但大包丢失：
ping -s 1400 10.244.2.3   # 1400字节能通
ping -s 1450 10.244.2.3   # 1450字节不通 → MTU问题！
# 修复：调小容器接口MTU
ip link set eth0 mtu 1450
```

---

### 8. 总结

```
┌──────────────────────────────────────────────────────────────────┐
│              容器网络知识体系                                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  单容器网络 = Network Namespace + veth pair + Bridge + NAT       │
│  多容器(单机) = Bridge + iptables                                │
│  多容器(跨主机) = Overlay(VXLAN) 或 路由(BGP)                    │
│  Kubernetes = CNI插件 + Pod网络模型                               │
│                                                                  │
│  性能排序（从高到低）：                                          │
│  ① Host网络（无隔离）                                            │
│  ② Calico BGP（纯路由，无封装）                                  │
│  ③ Cilium eBPF（内核态快速转发）                                 │
│  ④ Flannel host-gw（三层路由，同L2）                             │
│  ⑤ Flannel VXLAN（UDP封装，有overhead）                          │
│                                                                  │
│  排查思路：                                                      │
│  1. 确认是哪一层的问题（容器内→veth→Bridge→主机路由→物理网络）   │
│  2. 在每一跳抓包定位包丢在哪里                                   │
│  3. 检查MTU、路由、iptables规则                                  │
└──────────────────────────────────────────────────────────────────┘
```
