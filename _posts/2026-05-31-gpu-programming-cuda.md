---
title: "GPU编程与CUDA：并行计算模型、内存层次与矩阵优化"
categories: [C++语言]
location: 西安
render_with_liquid: false
---

### 引言

GPU不只是用来打游戏和训练AI模型。在后端系统中，GPU可以加速很多计算密集型任务：密码学运算、数据压缩、正则匹配、JSON解析、图数据库遍历。一块RTX 4090有16384个CUDA核心，峰值82.6 TFLOPS——是CPU算力的50倍以上。

我在项目中用CUDA加速了向量相似度搜索，将100万向量的top-K查询从CPU的120ms降到GPU的3ms。关键不是"把代码搬到GPU"，而是理解GPU的并行模型和内存层次，写出与硬件匹配的代码。

本文从CUDA执行模型讲起，覆盖内存层次优化和矩阵乘法的逐步加速。

---

### 1. GPU vs CPU 架构差异

```
  CPU: 少量强核心 + 大缓存 + 复杂控制逻辑
  ┌─────────────────────────────────────────────────────┐
  │  Core 0    Core 1    Core 2    ...    Core 15       │
  │  [ALU]     [ALU]     [ALU]           [ALU]          │
  │  [FPU]     [FPU]     [FPU]           [FPU]          │
  │  [分支预测] [分支预测] [乱序执行]      [多级缓存]    │
  │                                                     │
  │  L1: 32KB/核  L2: 256KB/核  L3: 30MB共享            │
  │  适合: 复杂逻辑、分支多、延迟敏感                    │
  └─────────────────────────────────────────────────────┘

  GPU: 大量弱核心 + 小缓存 + 简单控制
  ┌─────────────────────────────────────────────────────┐
  │  SM 0          SM 1          ...       SM 127       │
  │  [32 cores]    [32 cores]              [32 cores]   │
  │  [32 cores]    [32 cores]              [32 cores]   │
  │  [32 cores]    [32 cores]              [32 cores]   │
  │  [32 cores]    [32 cores]              [32 cores]   │
  │  =128 cores    =128 cores              =128 cores   │
  │                                                     │
  │  总计: 128 SM × 128 cores = 16384 CUDA cores       │
  │  Shared Mem: 100KB/SM  L2: 72MB                    │
  │  适合: 大量相同操作、数据并行、吞吐优先              │
  └─────────────────────────────────────────────────────┘

  关键差异：
  ┌──────────────┬──────────────────┬──────────────────────┐
  │ 维度         │ CPU              │ GPU                   │
  ├──────────────┼──────────────────┼──────────────────────┤
  │ 核心数       │ 8-64             │ 1000-16000            │
  │ 单核性能     │ 强               │ 弱                    │
  │ 适合任务     │ 复杂逻辑/分支    │ 大量简单并行计算      │
  │ 内存带宽     │ ~50 GB/s         │ ~1000 GB/s            │
  │ 延迟         │ 低               │ 高（启动开销大）      │
  └──────────────┴──────────────────┴──────────────────────┘
```

---

### 2. CUDA 执行模型

```
  CUDA线程层次：

  Grid (网格) — 一次kernel调用的所有线程
  ├── Block 0 (线程块) — 最多1024个线程，共享Shared Memory
  │   ├── Warp 0 (32个线程，硬件调度单位，SIMT执行)
  │   ├── Warp 1
  │   └── ...
  ├── Block 1
  └── ...

  ┌─────────────────────────────────────────────────────┐
  │                    Grid                              │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐           │
  │  │ Block(0,0)│ │Block(1,0)│ │Block(2,0)│           │
  │  │ 256线程   │ │ 256线程  │ │ 256线程  │           │
  │  └──────────┘ └──────────┘ └──────────┘           │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐           │
  │  │Block(0,1)│ │Block(1,1)│ │Block(2,1)│           │
  │  └──────────┘ └──────────┘ └──────────┘           │
  └─────────────────────────────────────────────────────┘

  线程索引计算：
  int idx = blockIdx.x * blockDim.x + threadIdx.x;
  // blockIdx: 当前block在grid中的位置
  // blockDim: 每个block有多少线程
  // threadIdx: 当前线程在block中的位置
```

---

### 3. CUDA 基础：向量加法

```cpp
#include <cuda_runtime.h>
#include <stdio.h>

// GPU核函数（所有线程并行执行这段代码）
__global__ void vectorAdd(const float* A, const float* B, float* C, int N) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx < N) {
        C[idx] = A[idx] + B[idx];  // 每个线程处理一个元素
    }
}

int main() {
    int N = 1 << 20;  // 100万元素
    size_t size = N * sizeof(float);

    // 分配Host内存
    float *h_A = (float*)malloc(size);
    float *h_B = (float*)malloc(size);
    float *h_C = (float*)malloc(size);
    // 初始化...

    // 分配Device内存
    float *d_A, *d_B, *d_C;
    cudaMalloc(&d_A, size);
    cudaMalloc(&d_B, size);
    cudaMalloc(&d_C, size);

    // Host → Device 数据传输
    cudaMemcpy(d_A, h_A, size, cudaMemcpyHostToDevice);
    cudaMemcpy(d_B, h_B, size, cudaMemcpyHostToDevice);

    // 启动核函数（256线程/block，N/256个block）
    int threadsPerBlock = 256;
    int blocksPerGrid = (N + threadsPerBlock - 1) / threadsPerBlock;
    vectorAdd<<<blocksPerGrid, threadsPerBlock>>>(d_A, d_B, d_C, N);

    // Device → Host 取结果
    cudaMemcpy(h_C, d_C, size, cudaMemcpyDeviceToHost);

    // 释放
    cudaFree(d_A); cudaFree(d_B); cudaFree(d_C);
    free(h_A); free(h_B); free(h_C);
    return 0;
}
```

编译：
```bash
nvcc -O2 -o vector_add vector_add.cu
```

---

### 4. GPU 内存层次

```
  GPU内存层次（从快到慢）：

  ┌──────────────────────────────────────────────────────────────┐
  │  Register (寄存器)     ~1 cycle    每线程私有   64KB/SM      │
  │  最快，但数量有限（每线程~255个寄存器）                       │
  ├──────────────────────────────────────────────────────────────┤
  │  Shared Memory         ~5 cycles   Block内共享  100KB/SM     │
  │  程序员显式管理的"L1缓存"，用于线程间协作                    │
  ├──────────────────────────────────────────────────────────────┤
  │  L1 Cache              ~30 cycles  SM内        128KB/SM      │
  │  L2 Cache              ~200 cycles 全局        72MB          │
  │  硬件自动管理                                                │
  ├──────────────────────────────────────────────────────────────┤
  │  Global Memory (DRAM)  ~400 cycles 全局        24-80GB       │
  │  带宽高(~1TB/s)但延迟大，需要合并访问(Coalescing)            │
  └──────────────────────────────────────────────────────────────┘

  优化核心：
  1. 最大化Shared Memory使用（减少Global Memory访问）
  2. Global Memory访问要合并(连续线程访问连续地址)
  3. 避免Bank Conflict（Shared Memory的32个bank）
```

---

### 5. 矩阵乘法优化（逐步加速）

```cpp
// 版本1: 朴素实现（每线程算C的一个元素）
__global__ void matmul_naive(float* A, float* B, float* C, int N) {
    int row = blockIdx.y * blockDim.y + threadIdx.y;
    int col = blockIdx.x * blockDim.x + threadIdx.x;

    if (row < N && col < N) {
        float sum = 0;
        for (int k = 0; k < N; k++) {
            sum += A[row * N + k] * B[k * N + col];
        }
        C[row * N + col] = sum;
    }
}
// 性能: ~300 GFLOPS (N=4096)
// 瓶颈: 每个元素的计算需要2N次Global Memory读取

// 版本2: Shared Memory Tiling（分块）
#define TILE_SIZE 32

__global__ void matmul_tiled(float* A, float* B, float* C, int N) {
    __shared__ float tileA[TILE_SIZE][TILE_SIZE];
    __shared__ float tileB[TILE_SIZE][TILE_SIZE];

    int row = blockIdx.y * TILE_SIZE + threadIdx.y;
    int col = blockIdx.x * TILE_SIZE + threadIdx.x;
    float sum = 0;

    // 分块遍历K维度
    for (int t = 0; t < N / TILE_SIZE; t++) {
        // 协作加载：每个线程加载一个元素到Shared Memory
        tileA[threadIdx.y][threadIdx.x] = A[row * N + t * TILE_SIZE + threadIdx.x];
        tileB[threadIdx.y][threadIdx.x] = B[(t * TILE_SIZE + threadIdx.y) * N + col];
        __syncthreads();  // 等所有线程加载完毕

        // 在Shared Memory中计算部分和
        for (int k = 0; k < TILE_SIZE; k++) {
            sum += tileA[threadIdx.y][k] * tileB[k][threadIdx.x];
        }
        __syncthreads();  // 等所有线程用完再加载下一块
    }

    C[row * N + col] = sum;
}
// 性能: ~2000 GFLOPS (N=4096)
// 提升: 6-7倍！因为Global Memory访问减少了TILE_SIZE倍
```

性能对比（RTX 4090，N=4096矩阵乘法）：

```
  ┌───────────────────────────┬────────────┬──────────────────┐
  │ 实现                      │ GFLOPS     │ 占峰值比         │
  ├───────────────────────────┼────────────┼──────────────────┤
  │ CPU单线程                  │ 3          │ -                │
  ├───────────────────────────┼────────────┼──────────────────┤
  │ GPU朴素实现               │ 300        │ 0.4%             │
  ├───────────────────────────┼────────────┼──────────────────┤
  │ GPU Tiled (Shared Mem)   │ 2000       │ 2.4%             │
  ├───────────────────────────┼────────────┼──────────────────┤
  │ GPU优化(向量化+流水线)    │ 15000      │ 18%              │
  ├───────────────────────────┼────────────┼──────────────────┤
  │ cuBLAS (NVIDIA官方)       │ 60000      │ 73%              │
  └───────────────────────────┴────────────┴──────────────────┘
```

---

### 6. 后端场景的GPU加速

| 场景 | 加速比 | 适用条件 |
|------|--------|---------|
| 向量相似度搜索(余弦) | 40-100x | 向量维度>128，数据量>10万 |
| 密码学(AES/SHA批量) | 10-50x | 大量独立的加密操作 |
| 正则表达式匹配 | 5-20x | 大量文本并行匹配 |
| JSON解析(simdjson思路) | 3-10x | 大量独立JSON文档 |
| 图遍历(BFS/PageRank) | 10-50x | 百万+节点的图 |
| 数据压缩(LZ4/Snappy) | 5-15x | 大块连续数据 |

**何时不适合GPU**：
- 数据量小（GPU启动开销>计算收益）
- 大量分支逻辑（warp divergence严重）
- 频繁CPU-GPU数据传输（PCIe带宽瓶颈）
- 串行依赖强（无法并行化）

---

### 总结

GPU编程的核心：

1. **并行度是关键**：需要数千到数百万个独立计算任务才能喂饱GPU
2. **内存层次决定性能**：Shared Memory分块(Tiling)是最重要的优化
3. **合并访问(Coalescing)**：相邻线程访问相邻内存地址，利用宽总线
4. **避免Warp Divergence**：同一Warp内的if/else导致串行执行
5. **数据传输是瓶颈**：PCIe带宽远低于GPU计算能力，要最小化传输
6. **先用库再自己写**：cuBLAS/cuDNN/Thrust已经高度优化

GPU是"用大量简单并行核心换取吞吐"的计算范式。后端系统中凡是"对大量数据做相同操作"的场景，都值得考虑GPU加速。
