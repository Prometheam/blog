---
layout: post_layout
title: "大模型推理优化实战：从Transformer原理到昇腾部署"
date: 2026-05-27 12:00:00 +0800
categories: [昇腾AI]
location: 西安
excerpt_separator: "```"
---

### 引言

去年团队接到一个需求：在昇腾910集群上部署一个7B参数的LLM，要求首token延迟 < 200ms，吞吐 > 100 tokens/s。听起来不难？但从PyTorch模型到生产环境跑起来，中间经历了模型转换失败、显存OOM、量化精度损失、动态batching不稳定等一系列坑。

这篇文章把我踩过的坑系统化——从Transformer推理的计算特征讲起，到KV Cache管理、量化技术、算子融合，最后给出在昇腾上的完整部署方案。

---

### 1. Transformer推理：计算特征分析

#### 1.1 推理的两个阶段

大模型推理与训练不同，分为**Prefill（预填充）**和**Decode（解码）**两个阶段：

```
┌─────────────────────────────────────────────────────────────────────┐
│                   LLM推理的两阶段                                     │
│                                                                     │
│  ┌─────────── Prefill阶段 ────────────┐  ┌─── Decode阶段 ─────┐   │
│  │                                     │  │                     │   │
│  │  输入: "请解释量子计算的原理"        │  │  逐token生成        │   │
│  │  (一次性处理所有input tokens)        │  │  每步只计算1 token  │   │
│  │                                     │  │                     │   │
│  │  特点:                              │  │  特点:              │   │
│  │  - Compute Bound (计算密集)         │  │  - Memory Bound     │   │
│  │  - 大矩阵乘法(seq_len × hidden)    │  │  - 小矩阵(1×hidden) │   │
│  │  - 高算力利用率                     │  │  - 大量KV读取       │   │
│  │  - 延迟取决于prompt长度             │  │  - 低算力利用率     │   │
│  │                                     │  │  - 延迟=每token时间 │   │
│  └─────────────────────────────────────┘  └─────────────────────┘   │
│                                                                     │
│  时间占比:  ~5-10%                          ~90-95%                 │
│  优化重点:  算子融合,并行化                  KV Cache,量化,batching  │
└─────────────────────────────────────────────────────────────────────┘
```

#### 1.2 Attention计算的瓶颈

```
标准Self-Attention计算：

Q = X × W_q     [batch, seq, hidden] × [hidden, hidden]
K = X × W_k     
V = X × W_v     

Attention = softmax(Q × K^T / √d) × V

Decode阶段的问题：
  Q的shape: [batch, 1, hidden]        ← 只有当前token
  K的shape: [batch, all_seq, hidden]   ← 所有历史token的Key
  V的shape: [batch, all_seq, hidden]   ← 所有历史token的Value

  Q×K^T 的计算量很小(1 × all_seq)
  但需要从显存加载整个K和V矩阵 → Memory Bound!

  以LLaMA-7B为例（32层, 32头, hidden=4096）：
  KV Cache大小 = 2 × 32 × seq_len × 4096 × 2bytes(FP16)
  seq_len=2048时：KV Cache = 1GB per request!
```

---

### 2. KV Cache优化

#### 2.1 为什么KV Cache是关键

```
没有KV Cache（每次重新计算）：
  生成第N个token需要处理前N-1个token的完整attention
  时间复杂度: O(N²) → 生成1000个token需要约500000次attention计算

有KV Cache（增量计算）：
  每次只计算新token的K和V，历史的从Cache读取
  时间复杂度: O(N) → 1000个token只需1000次attention计算

代价：巨大的显存占用
  LLaMA-7B, batch=8, seq=2048:
  KV Cache = 2 × 32层 × 8 × 2048 × 4096 × 2B = 8GB
  模型权重本身才14GB(FP16)，KV Cache已经占了模型的57%!
```

#### 2.2 PagedAttention：解决显存碎片化

传统KV Cache为每个请求预分配最大长度的连续显存，利用率极低：

```
传统方式（连续分配）：
┌────────────────────────────────────────────────────────┐
│ Request 1 KV [████████░░░░░░░░░░░░]  实际用40%, 预分配100%  │
│ Request 2 KV [██████████████░░░░░░]  实际用70%, 预分配100%  │
│ 空闲         [░░░░░░░░░░░░░░░░░░░░]  想插入新请求？不够！  │
│                                                        │
│ 显存利用率: 55%  碎片化严重                             │
└────────────────────────────────────────────────────────┘

PagedAttention（分页管理）：
┌────────────────────────────────────────────────────────┐
│ 物理块:  [B0][B1][B2][B3][B4][B5][B6][B7][B8][B9]... │
│                                                        │
│ Request 1: 页表 → [B0][B3][B7]     (按需分配3个块)    │
│ Request 2: 页表 → [B1][B2][B5][B8] (按需分配4个块)    │
│ 空闲块:           [B4][B6][B9]...   (随时可分配)      │
│                                                        │
│ 显存利用率: >95%  几乎无碎片                           │
└────────────────────────────────────────────────────────┘
```

```cpp
// PagedAttention核心数据结构（简化）
struct KVBlock {
    static constexpr int BLOCK_SIZE = 16;  // 每块存16个token的KV
    float* key_data;    // [BLOCK_SIZE, num_heads, head_dim]
    float* value_data;  // [BLOCK_SIZE, num_heads, head_dim]
};

class PagedKVCache {
public:
    PagedKVCache(int num_blocks, int num_heads, int head_dim)
        : num_heads_(num_heads), head_dim_(head_dim) {
        // 预分配物理块池
        for (int i = 0; i < num_blocks; ++i) {
            free_blocks_.push(allocateBlock());
        }
    }

    // 为新请求分配KV存储
    std::vector<int> allocateSequence(int seq_len) {
        int num_needed = (seq_len + KVBlock::BLOCK_SIZE - 1) / KVBlock::BLOCK_SIZE;
        std::vector<int> block_ids;

        for (int i = 0; i < num_needed; ++i) {
            int block_id = free_blocks_.front();
            free_blocks_.pop();
            block_ids.push_back(block_id);
        }
        return block_ids;  // 返回页表
    }

    // Append新token的KV到最后一个块
    void appendToken(const std::vector<int>& page_table,
                     int seq_pos, const float* key, const float* value) {
        int block_idx = seq_pos / KVBlock::BLOCK_SIZE;
        int offset = seq_pos % KVBlock::BLOCK_SIZE;
        int block_id = page_table[block_idx];

        // 写入对应块的对应位置
        memcpy(blocks_[block_id].key_data + offset * num_heads_ * head_dim_,
               key, num_heads_ * head_dim_ * sizeof(float));
        memcpy(blocks_[block_id].value_data + offset * num_heads_ * head_dim_,
               value, num_heads_ * head_dim_ * sizeof(float));
    }

private:
    int num_heads_, head_dim_;
    std::vector<KVBlock> blocks_;
    std::queue<int> free_blocks_;

    KVBlock allocateBlock() { /* 分配设备内存 */ }
};
```

---

### 3. 量化技术

#### 3.1 为什么要量化

```
LLaMA-7B 显存需求：
┌──────────────┬──────────────┬───────────────────────────┐
│ 精度         │ 模型大小     │ 推理最低显存（batch=1）   │
├──────────────┼──────────────┼───────────────────────────┤
│ FP32         │ 28 GB        │ ~32 GB                    │
│ FP16         │ 14 GB        │ ~16 GB                    │
│ INT8         │ 7 GB         │ ~9 GB                     │
│ INT4         │ 3.5 GB       │ ~5 GB                     │
└──────────────┴──────────────┴───────────────────────────┘

量化的三重收益：
  1. 显存占用↓ → 能跑更大batch/更长序列
  2. 内存带宽需求↓ → Decode阶段速度提升（memory bound）
  3. 计算速度↑ → INT8/INT4有专用硬件加速
```

#### 3.2 PTQ（Post-Training Quantization）

训练后量化，不需要重新训练，直接对权重做映射：

```
量化原理：
  FP16权重: [-0.5, 0.3, -0.1, 0.8, ...]
  
  Per-tensor量化（最简单）：
    scale = max(|weights|) / 127  = 0.8 / 127 = 0.0063
    INT8权重 = round(FP16 / scale) = [-79, 48, -16, 127, ...]
    反量化: FP16_approx = INT8 × scale

  Per-channel量化（更精确）：
    每个输出channel独立计算scale
    精度损失更小，但需要更多元数据

  GPTQ（当前主流）：
    逐层量化，用少量校准数据最小化量化误差
    利用Hessian矩阵信息决定量化顺序
    INT4精度几乎无损

┌────────────────────────────────────────────────────────────┐
│              量化方案对比（LLaMA-7B, C-Eval准确率）           │
├──────────────────┬────────────┬───────────────────────────┤
│ 方案             │ 准确率     │ 对比FP16基线              │
├──────────────────┼────────────┼───────────────────────────┤
│ FP16（基线）     │ 52.3%      │ —                         │
│ INT8 Per-channel │ 52.1%      │ -0.2%（几乎无损）         │
│ INT8 Per-tensor  │ 51.5%      │ -0.8%                     │
│ INT4 GPTQ       │ 51.8%      │ -0.5%（推荐）             │
│ INT4 RTN        │ 49.2%      │ -3.1%（损失较大）         │
└──────────────────┴────────────┴───────────────────────────┘
```

#### 3.3 在昇腾上执行量化

```bash
# 使用CANN的量化工具amct（Ascend Model Compression Toolkit）

# 1. 准备校准数据集（约100-500条）
python prepare_calibration_data.py --output calib_data.npy

# 2. 执行PTQ量化（INT8）
amct_onnx calibration \
    --model llama_7b.onnx \
    --data_dir ./calib_data \
    --save_path ./quantized/ \
    --batch_size 1 \
    --quantize_type "INT8"

# 3. ATC转换量化模型为.om
atc --model=./quantized/llama_7b_quantized.onnx \
    --framework=5 \
    --output=llama_7b_int8 \
    --soc_version=Ascend910 \
    --precision_mode=allow_mix_precision
```

---

### 4. 算子融合：Flash Attention

#### 4.1 标准Attention的内存问题

```
标准实现（逐步计算）：

Step 1: S = Q × K^T           写入显存 [batch, heads, seq, seq]
Step 2: P = softmax(S / √d)   读S, 写P到显存
Step 3: O = P × V             读P和V, 写O到显存

问题：S和P矩阵很大（seq²），需要反复读写显存
  seq=2048: S的大小 = 2048×2048×2B = 8MB per head
  32 heads = 256MB 中间结果！

Flash Attention（融合实现）：

核心思想：分块计算，永远不实体化完整的S和P矩阵
  - 将Q, K, V按block切分
  - 每个block在片上(L1/SRAM)完成QK^T → softmax → ×V
  - 用在线softmax技巧避免需要全局max/sum

┌─────────────────────────────────────────────────────────────┐
│         标准Attention              Flash Attention            │
│                                                             │
│  HBM读写: O(N² × d)              HBM读写: O(N × d)         │
│  中间显存: O(N²)                  中间显存: O(block_size²)   │
│  速度:     1x                     速度:     2-4x             │
│  seq=2048: 256MB中间结果           seq=2048: <1MB SRAM        │
└─────────────────────────────────────────────────────────────┘
```

#### 4.2 在昇腾上的算子融合实现

```cpp
// 昇腾上通过GE（Graph Engine）实现自动算子融合

// 方式1：使用CANN内置的FlashAttention算子
#include "acl/acl.h"
#include "aclnn/acl_nn.h"

// CANN 7.0+ 内置FlashAttention
aclnnStatus status = aclnnFlashAttentionScore(
    workspace, workspaceSize,
    executor,
    query,         // [batch, heads, seq_q, head_dim]
    key,           // [batch, heads, seq_kv, head_dim]
    value,         // [batch, heads, seq_kv, head_dim]
    scale,         // 1/√d
    output,        // [batch, heads, seq_q, head_dim]
    stream
);

// 方式2：通过ATC工具在模型转换时自动融合
// atc会识别QKV→MatMul→Softmax→MatMul的模式并融合
// 配置fusion_switch.cfg开启：
// [FusionSwitch]
// FlashAttention=true
```

---

### 5. 模型并行

#### 5.1 Tensor Parallelism vs Pipeline Parallelism

```
单卡放不下7B模型？需要多卡并行：

Tensor Parallelism（张量并行）：
┌────────────────────────────────────────────────────────┐
│  一个MatMul切分到多张卡上：                              │
│                                                        │
│  Y = X × W   where W is [4096, 4096]                  │
│                                                        │
│  Card 0: Y₀ = X × W[:, :2048]    (计算前半部分)       │
│  Card 1: Y₁ = X × W[:, 2048:]    (计算后半部分)       │
│  AllGather: Y = concat(Y₀, Y₁)                        │
│                                                        │
│  优点: 每层都并行，延迟最低                             │
│  缺点: 每层需要AllReduce/AllGather通信                  │
│  适用: 卡间带宽高（NVLink/HCCS）                       │
└────────────────────────────────────────────────────────┘

Pipeline Parallelism（流水线并行）：
┌────────────────────────────────────────────────────────┐
│  不同层放在不同卡上：                                    │
│                                                        │
│  Card 0: Layer 0-15  (前16层)                          │
│  Card 1: Layer 16-31 (后16层)                          │
│                                                        │
│  Card 0处理完一个micro-batch → 发送激活值给Card 1      │
│  Card 0开始处理下一个micro-batch（流水线并行）          │
│                                                        │
│  优点: 通信量小（只在层边界传递激活值）                  │
│  缺点: Pipeline bubble（气泡），延迟较高                │
│  适用: 卡间带宽低（PCIe）                              │
└────────────────────────────────────────────────────────┘
```

#### 5.2 昇腾多卡部署配置

```python
# 在昇腾上使用2卡Tensor Parallelism部署LLaMA-7B
# 使用MindSpore的parallel推理接口

import mindspore as ms
from mindformers import LlamaForCausalLM, LlamaConfig

# 配置2卡TP
ms.set_context(mode=ms.GRAPH_MODE, device_target="Ascend")
ms.set_auto_parallel_context(
    parallel_mode=ms.ParallelMode.SEMI_AUTO_PARALLEL,
    full_batch=True
)

config = LlamaConfig(
    num_layers=32,
    hidden_size=4096,
    num_heads=32,
    # 关键：设置TP并行度
    parallel_config={
        "model_parallel": 2,  # 2卡张量并行
        "data_parallel": 1,
        "pipeline_stage": 1
    }
)

model = LlamaForCausalLM(config)
model.load_checkpoint("llama_7b_weights/")
```

---

### 6. 实战：在昇腾910上部署LLaMA-7B

#### 6.1 完整部署流程

```
Step 1: 模型转换
  PyTorch (.pth) → ONNX (.onnx) → ATC → 离线模型 (.om)

Step 2: 量化（可选）
  使用amct进行INT8/INT4量化

Step 3: 推理服务搭建
  AscendCL加载.om → 自研推理引擎 → HTTP/gRPC服务

Step 4: 性能优化
  Dynamic Batching → KV Cache管理 → Profiling调优
```

#### 6.2 推理引擎核心实现

```cpp
class LLMInferenceEngine {
public:
    LLMInferenceEngine(const std::string& model_path, const EngineConfig& config)
        : config_(config) {
        // 初始化设备
        aclInit(nullptr);
        aclrtSetDevice(config.device_id);
        aclrtCreateStream(&stream_);

        // 加载模型
        aclmdlLoadFromFile(model_path.c_str(), &model_id_);
        model_desc_ = aclmdlCreateDesc();
        aclmdlGetDesc(model_desc_, model_id_);

        // 初始化KV Cache池
        initKVCachePool();
    }

    // 生成接口（流式输出）
    void generate(const std::vector<int>& input_ids,
                  std::function<void(int)> token_callback,
                  const GenerateConfig& gen_config) {
        // 1. Prefill阶段：处理全部input tokens
        auto kv_blocks = kv_pool_->allocateSequence(input_ids.size());
        auto logits = prefill(input_ids, kv_blocks);

        // 2. Decode阶段：逐token生成
        int next_token = sampleToken(logits, gen_config);
        int generated = 0;

        while (next_token != eos_token_id_ && generated < gen_config.max_new_tokens) {
            token_callback(next_token);  // 流式返回

            // 扩展KV Cache（可能需要分配新块）
            if (needNewBlock(kv_blocks, generated + input_ids.size())) {
                kv_blocks.push_back(kv_pool_->allocateBlock());
            }

            // Decode一个token
            logits = decode(next_token, kv_blocks, input_ids.size() + generated);
            next_token = sampleToken(logits, gen_config);
            generated++;
        }

        // 释放KV Cache
        kv_pool_->freeSequence(kv_blocks);
    }

private:
    EngineConfig config_;
    uint32_t model_id_;
    aclmdlDesc* model_desc_;
    aclrtStream stream_;
    std::unique_ptr<PagedKVCache> kv_pool_;

    void initKVCachePool() {
        // 计算可用显存，分配KV Cache块
        size_t free_mem, total_mem;
        aclrtGetMemInfo(ACL_HBM_MEM, &free_mem, &total_mem);

        // 预留2GB给模型权重和中间tensor
        size_t kv_budget = free_mem - 2ULL * 1024 * 1024 * 1024;
        size_t block_size = /* 计算单个块大小 */;
        int num_blocks = kv_budget / block_size;

        kv_pool_ = std::make_unique<PagedKVCache>(num_blocks, config_.num_heads,
                                                   config_.head_dim);
    }

    std::vector<float> prefill(const std::vector<int>& input_ids,
                               const std::vector<int>& kv_blocks) {
        // 设置输入（一次处理所有input tokens）
        // 执行模型推理
        // 填充KV Cache
        // 返回最后一个位置的logits
        // ... 具体ACL调用省略
    }

    std::vector<float> decode(int token_id,
                              const std::vector<int>& kv_blocks,
                              int seq_pos) {
        // 设置输入（单个token）
        // 读取KV Cache
        // 执行模型推理
        // Append新KV到Cache
        // 返回logits
    }

    int sampleToken(const std::vector<float>& logits,
                    const GenerateConfig& config) {
        if (config.temperature == 0) {
            // Greedy: 取argmax
            return std::max_element(logits.begin(), logits.end()) - logits.begin();
        }
        // Top-p sampling
        // ... 省略采样逻辑
    }
};
```

#### 6.3 Dynamic Batching（连续批处理）

```cpp
// 动态batching：不同请求的decode步可以合并成一个batch执行
class ContinuousBatcher {
public:
    ContinuousBatcher(LLMInferenceEngine* engine, int max_batch)
        : engine_(engine), max_batch_(max_batch) {}

    void addRequest(Request req) {
        std::lock_guard<std::mutex> lock(mutex_);
        pending_queue_.push(std::move(req));
    }

    // 调度循环（独立线程运行）
    void schedulingLoop() {
        while (running_) {
            // 1. 收集可执行的请求
            auto batch = formBatch();
            if (batch.empty()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
                continue;
            }

            // 2. 区分prefill和decode请求
            std::vector<Request*> prefill_reqs, decode_reqs;
            for (auto& req : batch) {
                if (req->phase == Phase::PREFILL) prefill_reqs.push_back(req);
                else decode_reqs.push_back(req);
            }

            // 3. 优先执行prefill（新请求尽快开始生成）
            if (!prefill_reqs.empty()) {
                executePrefillBatch(prefill_reqs);
            }

            // 4. 执行decode batch
            if (!decode_reqs.empty()) {
                executeDecodeBatch(decode_reqs);
            }

            // 5. 移除已完成的请求，释放资源
            cleanupFinished(batch);
        }
    }

private:
    std::vector<Request*> formBatch() {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<Request*> batch;

        // 先加入正在decode的请求
        for (auto& req : active_requests_) {
            batch.push_back(&req);
        }

        // 如果还有空间，加入新请求
        while (batch.size() < max_batch_ && !pending_queue_.empty()) {
            active_requests_.push_back(std::move(pending_queue_.front()));
            pending_queue_.pop();
            batch.push_back(&active_requests_.back());
        }

        return batch;
    }
};
```

---

### 7. 性能优化结果

#### 7.1 优化前后对比

```
环境：昇腾910 (32GB HBM), LLaMA-7B
测试条件：input_len=256, output_len=128

┌──────────────────────────────────────────────────────────────────┐
│                    优化效果对比                                    │
├────────────────────────┬────────────┬────────────┬───────────────┤
│ 优化项                 │ 首token延迟│ 吞吐(tok/s)│ 显存占用      │
├────────────────────────┼────────────┼────────────┼───────────────┤
│ 基线(FP16, batch=1)    │ 450ms      │ 28         │ 16GB          │
│ + Flash Attention      │ 320ms      │ 35         │ 14.5GB        │
│ + INT8量化             │ 280ms      │ 52         │ 9GB           │
│ + PagedAttention       │ 280ms      │ 52         │ 高效利用      │
│ + Dynamic Batch(=8)    │ 310ms      │ 180        │ 12GB          │
│ + Prefix Cache         │ 180ms      │ 195        │ 12.5GB        │
├────────────────────────┼────────────┼────────────┼───────────────┤
│ 最终效果               │ 180ms      │ 195        │ 12.5GB        │
│ vs 基线提升            │ 2.5x↓      │ 7x↑        │ 22%↓          │
└────────────────────────┴────────────┴────────────┴───────────────┘
```

#### 7.2 关键经验总结

```
1. 量化是性价比最高的优化
   INT8几乎无精度损失，速度提升近2倍
   优先做量化，再考虑其他优化

2. Dynamic Batching是吞吐的关键
   单请求时AI Core利用率 < 10%（decode阶段太轻）
   batch=8时利用率提升到60%+

3. Prefill和Decode应该分离调度
   Prefill是compute bound → 适合大batch
   Decode是memory bound → 适合合并更多请求

4. KV Cache管理决定服务稳定性
   显存碎片化是长时间运行后OOM的主因
   PagedAttention + 主动GC是生产必备

5. 昇腾特有注意事项
   - DVPP可加速多模态模型的图像预处理
   - 某些算子需要5HD格式（注意数据layout转换）
   - Profiling用msprof，关注AI Core利用率和MTE占比
   - 多卡通信走HCCS（类似NVLink），TP效率高
```

---

### 8. 总结

大模型推理优化的核心思路可以归纳为：

```
┌─────────────────────────────────────────────────────────────────┐
│              LLM推理优化分层策略                                   │
├─────────────────┬───────────────────────────────────────────────┤
│ 层次            │ 优化手段                                       │
├─────────────────┼───────────────────────────────────────────────┤
│ 模型层          │ 量化(INT8/INT4) + 剪枝 + 蒸馏                 │
│ 算法层          │ Flash Attention + PagedAttention + Speculative │
│ 系统层          │ Dynamic Batching + 并行策略(TP/PP)            │
│ 硬件层          │ 算子融合 + 内存带宽优化 + 多Stream流水         │
│ 服务层          │ 负载均衡 + 请求调度 + 优雅降级                 │
└─────────────────┴───────────────────────────────────────────────┘
```

从后端工程师的视角看，大模型推理本质是一个**内存带宽和调度**问题——模型权重太大需要量化，KV Cache太大需要分页管理，单请求太轻需要batching，这些与我们熟悉的高性能服务器设计思路是相通的。掌握了底层原理，无论是CUDA还是昇腾，优化方法论是通用的。
