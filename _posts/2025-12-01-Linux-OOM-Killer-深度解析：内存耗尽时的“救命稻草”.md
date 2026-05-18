---
layout: post_layout
title: "Linux OOM Killer 深度解析：内存耗尽时的“救命稻草”"
date: 2025-12-01 16:28:14 +0800
categories: [Linux系统]
location: 西安
excerpt_separator: "```"
---

<p style="text-indent: 2em"><span style="font-size: 16px; color: rgb(15, 17, 21)">当 Linux 系统内存耗尽时，谁会决定哪个进程该被牺牲？这篇文章带你深入理解 OOM Killer 的工作原理、配置方法和最佳实践。</span></p><hr><h4 style="" id="%E4%B8%80%E3%80%81%E4%BB%80%E4%B9%88%E6%98%AFoom-killer%EF%BC%9F">一、什么是OOM Killer？</h4><p style="text-indent: 2em"><strong>OOM（Out Of Memory）Killer</strong>&nbsp;是 Linux 内核中的一个内置机制，它的作用类似于系统的“消防员”。当系统物理内存和交换空间（swap）都耗尽，无法满足新的内存分配请求时，OOM Killer 会被激活，自动选择一个或多个进程终止，释放内存资源，防止整个系统崩溃。</p><p style="text-indent: 2em">想象一下这样的场景：你的服务器上运行着数十个服务，突然间内存使用量飙升，系统开始变得异常缓慢，甚至无响应。这时，OOM Killer 就会介入，做出那个艰难的抉择——牺牲一个进程，拯救整个系统。</p><p style=""></p><h4 style="" id="%E4%BA%8C%E3%80%81oom-killer%E4%BD%95%E6%97%B6%E8%A2%AB%E8%A7%A6%E5%8F%91%EF%BC%9F">二、OOM Killer何时被触发？</h4><p style="">触发条件：</p><p style="text-indent: 2em">OOM Killer 的触发不是随意的，它只在特定条件下才会被激活：</p><ol><li><p style="">系统内存耗尽：物理内存和 swap 空间都无法满足新的内存请求</p></li><li><p style="">内核分配失败：无法分配连续的内存页</p></li><li><p style="">内存碎片严重：虽然有足够的总内存，但无法组成连续的内存块</p></li></ol><p style=""></p><pre><code>#可以通过以下命令检查当前内存状态

# 查看内存使用概况
$ free -h
              total        used        free      shared  buff/cache   available
Mem:           7.6G        3.2G        1.2G        456M        3.2G        3.7G
Swap:          2.0G        512M        1.5G

# 查看详细内存信息
$ cat /proc/meminfo
MemTotal:        7982348 kB
MemFree:         1287564 kB
MemAvailable:    3876544 kB
SwapTotal:       2097148 kB
SwapFree:        1572864 kB</code></pre><p style=""></p><p style="">内存分配策略：</p><p style="text-indent: 2em"><span style="font-size: 16px; color: rgb(15, 17, 21)">Linux 的内存分配策略由&nbsp;</span><code>vm.overcommit_memory</code><span style="font-size: 16px; color: rgb(15, 17, 21)">&nbsp;参数控制：</span></p><pre><code># 查看当前策略
$ sysctl vm.overcommit_memory
vm.overcommit_memory = 0

# 三种策略说明：
# 0: 启发式overcommit（默认）- 基于当前内存使用情况判断
# 1: 总是overcommit - 允许分配超过物理内存+swap的内存
# 2: 禁止overcommit - 严格限制，分配不能超过 CommitLimit</code></pre><p style=""></p><p style=""></p><h4 style="" id="%E4%B8%89%E3%80%81oom-killer%E7%9A%84%E5%B7%A5%E4%BD%9C%E5%8E%9F%E7%90%86%EF%BC%9A">三、OOM Killer的工作原理：</h4><p style=""><strong>选择流程：谁是“最佳”牺牲者？</strong></p><p style="">当内存严重不足时，OOM Killer 不会随机选择进程终止，而是通过一套复杂的算法计算每个进程的"坏分数"（badness score），选择分数最高的进程作为牺牲品。</p><h4 style="" id="1.-%E8%AE%A1%E7%AE%97-oom_score">1. 计算 oom_score</h4><p style="">每个进程都有一个&nbsp;<code>oom_score</code>，这个值决定了它被选中的概率：</p><pre><code># 查看进程的OOM分数
$ cat /proc/1234/oom_score
187

# 查看进程的OOM调整值
$ cat /proc/1234/oom_score_adj
0  # 范围：-1000 到 1000</code></pre><p style="">计算公式简化版：</p><pre><code>oom_score = (进程内存使用量 × oom_score_adj) / 调整因子</code></pre><h4 style="" id="2.-%E8%AF%84%E5%88%86%E7%AE%97%E6%B3%95%E8%80%83%E8%99%91%E7%9A%84%E5%9B%A0%E7%B4%A0">2. 评分算法考虑的因素</h4><p style="">OOM Killer 在选择目标时会综合考虑多个因素：</p><ul><li><p style="">内存使用量：RSS（常驻内存集） + swap 使用量</p></li><li><p style="">进程运行时间：运行时间越短，越容易被选</p></li><li><p style="">进程优先级：低优先级（高 nice 值）进程风险更高</p></li><li><p style="">进程重要性：内核线程、硬件访问进程等有保护</p></li><li><p style="">用户调整：通过&nbsp;<code>oom_score_adj</code>&nbsp;手动调整</p></li></ul><h4 style="" id="3.-%E5%8F%97%E4%BF%9D%E6%8A%A4%E7%9A%84%E8%BF%9B%E7%A8%8B">3. 受保护的进程</h4><p style="">某些进程几乎不会被 OOM Killer 选中：</p><ul><li><p style="">init 进程（PID 1）：系统基石，杀死它等于重启系统</p></li><li><p style="">内核线程：内核自身的关键组件</p></li><li><p style="">持有硬件锁的进程：避免硬件状态不一致</p></li><li><p style="">容器中的 init 进程：在容器环境中受保护</p></li></ul><p style=""></p><h4 style="" id="%E5%9B%9B%E3%80%81%E5%A6%82%E4%BD%95%E8%AF%8A%E6%96%ADoom-killer%E4%BA%8B%E4%BB%B6%EF%BC%9F">四、如何诊断OOM Killer事件？</h4><p style="">1. 查看内核日志：OOM Killer 的每次行动都会在内核日志中留下记录</p><pre><code># 搜索OOM相关日志
$ dmesg | grep -i "oom\|killed"
[123456.789] Out of memory: Kill process 5678 (java) score 899 or sacrifice child
[123456.790] Killed process 5678 (java) total-vm:12345678kB, anon-rss:5678901kB, file-rss:1234kB, shmem-rss:0kB

# 使用journalctl查看系统日志
$ journalctl -k --since "1 hour ago" | grep -i "out.of.memory"</code></pre><p style="">2. 分析详细的 OOM 报告</p><pre><code># 查看完整的OOM报告
$ dmesg -T | grep -A 30 "Out of memory"
[Thu Mar 14 10:23:45 2024] Out of memory: Killed process 5678 (java) score 899 or sacrifice child
[Thu Mar 14 10:23:45 2024] Memory cgroup out of memory: Kill process 5678 (java) score 899 or sacrifice child
[Thu Mar 14 10:23:45 2024] oom_kill_process: killing victim 5678</code></pre><p style="">报告中的关键信息：</p><ul><li><p style="">total-vm：进程使用的虚拟内存总量</p></li><li><p style="">anon-rss：匿名页的常驻内存（堆、栈等）</p></li><li><p style="">file-rss：文件映射的常驻内存</p></li><li><p style="">score：进程的 OOM 分数</p></li></ul><p style=""></p><h4 style="" id="%E4%BA%94%E3%80%81%E9%85%8D%E7%BD%AE%E5%92%8C%E8%B0%83%E4%BC%98-oom-killer">五、配置和调优 OOM Killer</h4><p style="">1.系统级配置</p><pre><code># 设置内存分配策略
$ sudo sysctl -w vm.overcommit_memory=0

# 设置overcommit比例（默认50%）
$ sudo sysctl -w vm.overcommit_ratio=50

# 控制OOM时的行为
# 0: 启用OOM killer（默认）
# 1: 系统panic，不启用OOM killer
# 2: 触发内核panic
$ sudo sysctl -w vm.panic_on_oom=0

# 使配置永久生效
$ echo "vm.overcommit_memory = 0" &gt;&gt; /etc/sysctl.conf
$ sysctl -p</code></pre><p style="">2.进程级保护</p><pre><code># 将进程的oom_score_adj设置为负值，降低被选概率
$ echo -1000 &gt; /proc/[PID]/oom_score_adj

# 对于systemd管理的服务
$ sudo systemctl edit important-service
[Service]
OOMScoreAdjust=-500
MemoryAccounting=yes
MemoryMax=1G</code></pre><p style="">标记可牺牲进程</p><pre><code># 将进程标记为优先被终止
$ echo 1000 &gt; /proc/[PID]/oom_score_adj</code></pre><p style="">3.使用cgroup</p><pre><code># 创建cgroup
$ sudo cgcreate -g memory:/limited_group

# 设置内存限制
$ echo "500M" &gt; /sys/fs/cgroup/memory/limited_group/memory.limit_in_bytes

# 将进程加入cgroup
$ echo [PID] &gt; /sys/fs/cgroup/memory/limited_group/cgroup.procs</code></pre><h4 style="" id="%E5%85%AD%E3%80%81%E9%A2%84%E9%98%B2oom%E6%80%9D%E8%B7%AF">六、预防OOM思路</h4><p style="">1.合理配置swap空间</p><pre><code># 检查当前swap
$ swapon --show
NAME      TYPE SIZE USED PRIO
/swapfile file   2G 512M   -2

# 创建swap文件（如果缺少）
$ sudo fallocate -l 2G /swapfile
$ sudo chmod 600 /swapfile
$ sudo mkswap /swapfile
$ sudo swapon /swapfile

# 永久生效
$ echo '/swapfile none swap sw 0 0' &gt;&gt; /etc/fstab</code></pre><p style="text-indent: 2em"></p><p style="">2.实施内存监控</p><pre><code>#!/bin/bash
# 内存监控脚本
THRESHOLD=90  # 内存使用阈值百分比

while true; do
    # 获取内存使用率
    MEM_USED=$(free | awk '/^Mem:/{print $3/$2 * 100}')
    
    if (( $(echo "$MEM_USED &gt; $THRESHOLD" | bc -l) )); then
        # 发出警告
        echo "警告：内存使用率 ${MEM_USED}% 超过阈值 ${THRESHOLD}%"
        echo "时间: $(date)"
        echo "内存使用前10的进程:"
        ps aux --sort=-%mem | head -11
        
        # 可以添加邮件或API通知
        # send_alert "内存使用率过高: ${MEM_USED}%"
    fi
    
    sleep 60  # 每分钟检查一次
done</code></pre><p style="">3.优化应用程序</p><ul><li><p style="">设置合理的内存限制：Java 应用的&nbsp;<code>-Xmx</code>，Python 的内存管理等</p></li><li><p style="">实现优雅降级：在内存不足时主动释放资源</p></li><li><p style="">使用内存池：减少内存碎片</p></li><li><p style="">监控内存泄漏：定期检查应用的内存使用趋势</p></li></ul><p style="text-indent: 2em"></p><h4 style="" id="%E4%B8%83%E3%80%81%E5%AE%B9%E5%99%A8%E7%8E%AF%E5%A2%83%E4%B8%AD%E7%9A%84oom-killer">七、容器环境中的OOM Killer</h4><p style=""><span style="font-size: 16px; color: rgb(15, 17, 21)">在 Docker 和 Kubernetes 环境中，OOM Killer 的行为有所不同：</span></p><pre><code># Docker 容器 运行容器时设置内存限制
$ docker run -d \
  --name myapp \
  -m 512m \           # 硬限制512MB
  --memory-reservation 256m \  # 软限制256MB
  --oom-kill-disable=false \   # 启用OOM Killer
  myapp:latest

# 查看容器OOM状态
$ docker stats
CONTAINER   MEM USAGE / LIMIT   MEM %   OOM
myapp       450MiB / 512MiB     87.89%  false</code></pre><pre><code>#Kubernetes Pod
apiVersion: v1
kind: Pod
metadata:
  name: myapp-pod
spec:
  containers:
  - name: myapp
    image: myapp:latest
    resources:
      requests:
        memory: "256Mi"   # 请求内存，调度依据
      limits:
        memory: "512Mi"   # 限制内存，超限可能触发OOM
    securityContext:
      allowPrivilegeEscalation: false</code></pre><p style="">容器特有的 OOM 行为</p><ol><li><p style="">cgroup 级别的 OOM：每个容器有自己的 cgroup，OOM 在 cgroup 级别触发</p></li><li><p style="">优先级继承：容器内进程的 OOM 分数会考虑容器的限制</p></li><li><p style="">Kubernetes QoS 等级：</p><ul><li><p style="">Guaranteed：requests=limits，最后被 kill</p></li><li><p style="">Burstable：requests&lt;limits，其次被 kill</p></li><li><p style="">BestEffort：无限制，最先被 kill</p></li></ul></li></ol><p style=""></p><h4 style="" id="%E5%85%AB%E3%80%81%E6%9C%80%E4%BD%B3%E5%AE%9E%E8%B7%B5">八、最佳实践</h4><pre><code># 使用 journalctl 查看系统日志
# 查看系统服务被终止的记录
journalctl | grep -i "killed\|stopped\|terminated"

# 查看特定服务的状态变化
journalctl -u service_name

# 查看最近与进程终止相关的日志
journalctl --since "1 hour ago" | grep -E "(killed|stop|terminate|exit)"</code></pre><p style=""></p><pre><code># 使用 dmesg 查看内核消息
# 查看内核日志，可能包含OOM killer等信息
dmesg | grep -i "killed"
dmesg | grep -E "(oom|kill|terminate)"</code></pre><p style=""></p>