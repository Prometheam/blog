---
title: "容器化与Kubernetes实战：从Docker到生产级编排"
categories: [架构设计]
location: 西安
render_with_liquid: false
---

### 引言

"在我机器上能跑啊"——这句话终结于Docker。容器技术将应用和它的所有依赖打包在一起，保证了"构建一次，哪里都能跑"。而Kubernetes则解决了"我有100个容器，怎么管理它们"的问题。

我们的服务从单机部署迁移到K8s后，发布时间从"运维手动部署30分钟"缩短到"git push后3分钟自动上线"，回滚从"找运维拉旧版本重新部署"变成"kubectl rollout undo一条命令"。

本文从Docker最佳实践讲起，到Kubernetes核心概念与生产级配置，为C++后端开发者提供完整的容器化指南。

---

### 1. Docker 镜像最佳实践

#### 1.1 多阶段构建（减小镜像体积）

```dockerfile
# Stage 1: 编译阶段
FROM ubuntu:22.04 AS builder

RUN apt-get update && apt-get install -y \
    g++ cmake make libssl-dev libprotobuf-dev protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN cmake -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j$(nproc)

# Stage 2: 运行阶段（最小化镜像）
FROM ubuntu:22.04 AS runtime

# 只安装运行时依赖（不装编译工具）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 libprotobuf23 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -s /bin/false appuser

WORKDIR /app

# 只复制编译产物
COPY --from=builder /app/build/server ./server
COPY --from=builder /app/config/ ./config/

# 非root运行
USER appuser

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD ["/app/server", "--health-check"]

ENTRYPOINT ["/app/server"]
CMD ["--config", "/app/config/prod.yaml"]
```

#### 1.2 镜像优化对比

```
  ┌────────────────────────────┬──────────────┬────────────────────────┐
  │         方式               │   镜像大小    │         说明           │
  ├────────────────────────────┼──────────────┼────────────────────────┤
  │ 单阶段(含编译工具)         │ ~1.5 GB      │ ❌ 巨大，含gcc/cmake   │
  ├────────────────────────────┼──────────────┼────────────────────────┤
  │ 多阶段(ubuntu runtime)    │ ~120 MB      │ ✅ 只有运行时依赖      │
  ├────────────────────────────┼──────────────┼────────────────────────┤
  │ 多阶段(alpine)            │ ~30 MB       │ ✅✅ 最小(需musl兼容) │
  ├────────────────────────────┼──────────────┼────────────────────────┤
  │ distroless                 │ ~25 MB       │ ✅✅ 无shell，最安全   │
  └────────────────────────────┴──────────────┴────────────────────────┘
```

#### 1.3 Dockerfile 优化清单

| 实践 | 原因 |
|------|------|
| 多阶段构建 | 编译工具不进入最终镜像 |
| `.dockerignore` | 排除.git、build、测试数据 |
| 合并RUN层 | 减少镜像层数 |
| 先COPY依赖文件再COPY源码 | 利用层缓存（依赖不变时不重新安装） |
| 非root用户运行 | 安全最佳实践 |
| HEALTHCHECK | K8s探针依赖 |
| 固定版本号 | `FROM ubuntu:22.04` 非 `ubuntu:latest` |

---

### 2. Kubernetes 核心概念

```
  K8s 核心对象关系：

  ┌─────────────────────────────────────────────────────────────────┐
  │                        Cluster                                   │
  │                                                                  │
  │  ┌────────────────────────────────────────────────────────────┐ │
  │  │                    Namespace (逻辑隔离)                      │ │
  │  │                                                             │ │
  │  │  ┌──────────────┐         ┌───────────────┐               │ │
  │  │  │  Deployment  │────────▶│  ReplicaSet   │               │ │
  │  │  │ (声明期望状态)│         │ (维护Pod副本数)│               │ │
  │  │  └──────────────┘         └───────┬───────┘               │ │
  │  │                                    │                        │ │
  │  │                     ┌──────────────┼──────────────┐        │ │
  │  │                     ▼              ▼              ▼        │ │
  │  │              ┌─────────┐    ┌─────────┐    ┌─────────┐   │ │
  │  │              │   Pod   │    │   Pod   │    │   Pod   │   │ │
  │  │              │┌───────┐│    │┌───────┐│    │┌───────┐│   │ │
  │  │              ││Container│    ││Container│    ││Container│   │ │
  │  │              │└───────┘│    │└───────┘│    │└───────┘│   │ │
  │  │              └─────────┘    └─────────┘    └─────────┘   │ │
  │  │                     ▲              ▲              ▲        │ │
  │  │                     └──────────────┼──────────────┘        │ │
  │  │                                    │                        │ │
  │  │                           ┌────────┴────────┐              │ │
  │  │                           │    Service      │              │ │
  │  │                           │ (负载均衡+服务发现)│              │ │
  │  │                           └─────────────────┘              │ │
  │  └────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────┘
```

#### 核心对象速查

| 对象 | 作用 | 类比 |
|------|------|------|
| Pod | 最小调度单位，1+容器 | "一个进程" |
| Deployment | 管理Pod副本、滚动更新 | "进程管理器" |
| Service | 稳定网络入口+负载均衡 | "DNS + LB" |
| ConfigMap | 配置文件(非敏感) | "环境变量/配置文件" |
| Secret | 敏感配置(密码/密钥) | "加密的配置" |
| Ingress | HTTP路由（域名→Service） | "Nginx反向代理" |
| HPA | 自动水平扩缩容 | "Auto Scaling" |
| PVC | 持久存储 | "云盘挂载" |

---

### 3. 生产级 Deployment 配置

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
  labels:
    app: order-service
    version: v2.1.0
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1        # 滚动更新时最多多1个Pod
      maxUnavailable: 0  # 更新期间不允许不可用Pod
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
        version: v2.1.0
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      # 优雅终止
      terminationGracePeriodSeconds: 30

      containers:
        - name: order-service
          image: registry.example.com/order-service:v2.1.0
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9090
              name: metrics

          # 资源限制（必须设置！）
          resources:
            requests:
              cpu: "250m"       # 请求0.25核
              memory: "256Mi"   # 请求256MB
            limits:
              cpu: "1000m"     # 最多1核
              memory: "512Mi"  # 最多512MB（超出被OOMKill）

          # 存活探针（失败则重启容器）
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3

          # 就绪探针（失败则从Service摘除，不接受流量）
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 2

          # 启动探针（慢启动服务用）
          startupProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 30  # 最多等150秒启动

          # 环境变量
          env:
            - name: DB_HOST
              valueFrom:
                configMapKeyRef:
                  name: order-service-config
                  key: db_host
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: order-service-secrets
                  key: db_password
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name

          # 优雅关闭
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
                # sleep 5秒让Service先摘除Pod，再收到SIGTERM

      # Pod反亲和：分散在不同节点
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: order-service
                topologyKey: kubernetes.io/hostname
```

---

### 4. Service 与 Ingress

```yaml
# Service: 集群内负载均衡
apiVersion: v1
kind: Service
metadata:
  name: order-service
spec:
  selector:
    app: order-service
  ports:
    - name: http
      port: 80
      targetPort: 8080
  type: ClusterIP  # 集群内部访问

---
# Ingress: 外部HTTP路由
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/rate-limit: "100"
spec:
  tls:
    - hosts: [api.example.com]
      secretName: api-tls-cert
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /v1/orders
            pathType: Prefix
            backend:
              service:
                name: order-service
                port:
                  number: 80
          - path: /v1/users
            pathType: Prefix
            backend:
              service:
                name: user-service
                port:
                  number: 80
```

---

### 5. 自动扩缩容（HPA）

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  minReplicas: 3
  maxReplicas: 20
  metrics:
    # CPU利用率超过70%时扩容
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    # 自定义指标：QPS超过1000时扩容
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "1000"
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30   # 扩容决策窗口
      policies:
        - type: Percent
          value: 50                    # 每次最多扩50%
          periodSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 300  # 缩容等5分钟再决定
      policies:
        - type: Pods
          value: 1                     # 每次最多缩1个
          periodSeconds: 60
```

---

### 6. 发布策略

```
  ┌──────────────────┬───────────────────────────────┬──────────────┐
  │     策略         │          适用场景             │    风险       │
  ├──────────────────┼───────────────────────────────┼──────────────┤
  │ 滚动更新        │ 日常发布（默认策略）           │ 低            │
  │ (RollingUpdate)  │ 逐步替换旧Pod                │              │
  ├──────────────────┼───────────────────────────────┼──────────────┤
  │ 蓝绿部署        │ 需要瞬间切换、快速回滚        │ 资源消耗2倍  │
  │ (Blue-Green)    │ 两套环境同时存在              │              │
  ├──────────────────┼───────────────────────────────┼──────────────┤
  │ 金丝雀发布      │ 高风险变更、大流量系统        │ 较低          │
  │ (Canary)        │ 先导入5%流量验证              │              │
  └──────────────────┴───────────────────────────────┴──────────────┘
```

常用运维命令：
```bash
# 查看发布状态
kubectl rollout status deployment/order-service

# 查看历史版本
kubectl rollout history deployment/order-service

# 回滚到上一版本（1条命令，30秒内生效）
kubectl rollout undo deployment/order-service

# 回滚到指定版本
kubectl rollout undo deployment/order-service --to-revision=3

# 暂停/恢复发布（金丝雀验证时）
kubectl rollout pause deployment/order-service
kubectl rollout resume deployment/order-service
```

---

### 7. C++ 服务容器化要点

| 要点 | 具体建议 |
|------|---------|
| 信号处理 | 捕获SIGTERM实现优雅关闭（释放连接、完成在途请求） |
| 健康检查 | 暴露 `/healthz`（存活）和 `/readyz`（就绪）HTTP端点 |
| 资源限制 | 必须设置memory limit，C++内存泄漏时被OOMKill比hang住好 |
| 日志输出 | 输出到stdout/stderr（不写文件），由K8s日志系统收集 |
| 配置外部化 | 通过环境变量或挂载ConfigMap获取配置，不硬编码 |
| 无状态设计 | Pod随时可能被杀重建，状态存到DB/Redis |
| 启动速度 | 控制在10秒内，否则配置startupProbe |

---

### 总结

容器化与K8s的核心价值：

1. **Docker多阶段构建**：编译产物独立于编译环境，最终镜像仅含运行时
2. **K8s声明式管理**：你描述"期望状态"，K8s负责达到并维持
3. **探针三件套**：liveness防止僵死、readiness控制流量、startup处理慢启动
4. **资源限制必须设**：没有limit的Pod是定时炸弹
5. **滚动更新+一键回滚**：发布不再需要停机窗口，出问题30秒回滚
6. **HPA自动扩缩**：流量高峰自动扩容，低谷自动缩容省钱

K8s不是银弹，但它是目前微服务部署的最优解。学会这套体系，"部署"从此不再是运维的专属领域。
