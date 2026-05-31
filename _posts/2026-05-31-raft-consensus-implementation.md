---
title: "Raft共识算法：从原理到C++完整实现"
categories: [架构设计]
location: 西安
render_with_liquid: false
---

### 引言

分布式系统的核心问题之一：多个节点如何就一个值达成一致？网络分区、节点崩溃、消息延迟——在这些混乱中保证所有节点看到相同的日志序列，这就是共识算法要解决的问题。

Paxos是第一个被证明正确的共识算法，但它以"难以理解和实现"著称。Raft（2014年）在保证与Paxos等价安全性的同时，通过分解为Leader选举、日志复制、安全性三个子问题，让共识算法变得可理解、可实现。

本文讲解Raft的完整机制，并给出核心数据结构和选举/复制的C++实现。

---

### 1. Raft 核心概念

```
  Raft 将共识分解为三个独立子问题：

  ┌─────────────────────────────────────────────────────────────┐
  │ 1. Leader 选举                                               │
  │    - 一个Term内最多一个Leader                                 │
  │    - Leader负责接收客户端请求并复制日志                        │
  │    - Leader挂了后通过超时触发新选举                           │
  ├─────────────────────────────────────────────────────────────┤
  │ 2. 日志复制                                                  │
  │    - Leader将日志条目复制到所有Follower                       │
  │    - 多数派(majority)确认后提交                               │
  │    - 已提交的日志不会丢失                                    │
  ├─────────────────────────────────────────────────────────────┤
  │ 3. 安全性                                                    │
  │    - 选举限制：只有日志最新的节点才能当选Leader                │
  │    - 保证：已提交的日志永远不会被覆盖                         │
  └─────────────────────────────────────────────────────────────┘

  节点角色（任一时刻只能是其中一种）：
  ┌──────────┐     超时        ┌───────────┐    获得多数票    ┌────────┐
  │ Follower │──────────────→ │ Candidate │───────────────→ │ Leader │
  └──────────┘                 └───────────┘                  └────────┘
       ↑                            │                             │
       │      发现更高Term           │     发现更高Term             │
       └────────────────────────────┘─────────────────────────────┘
```

---

### 2. 核心数据结构

```cpp
#include <vector>
#include <string>
#include <mutex>
#include <random>
#include <chrono>
#include <atomic>
#include <thread>
#include <functional>

// 日志条目
struct LogEntry {
    uint64_t term;       // 创建该条目时的Leader任期
    uint64_t index;      // 日志索引（从1开始）
    std::string command; // 状态机命令
};

// 节点角色
enum class Role { FOLLOWER, CANDIDATE, LEADER };

// 请求投票RPC
struct RequestVoteArgs {
    uint64_t term;           // 候选人任期
    std::string candidate_id; // 候选人ID
    uint64_t last_log_index; // 候选人最后日志条目索引
    uint64_t last_log_term;  // 候选人最后日志条目任期
};

struct RequestVoteReply {
    uint64_t term;        // 当前任期（让候选人更新自己）
    bool vote_granted;    // 是否投票给候选人
};

// 追加日志RPC（也用作心跳）
struct AppendEntriesArgs {
    uint64_t term;            // Leader任期
    std::string leader_id;     // Leader ID
    uint64_t prev_log_index;  // 新日志前一条的索引
    uint64_t prev_log_term;   // 新日志前一条的任期
    std::vector<LogEntry> entries;  // 要追加的日志（心跳时为空）
    uint64_t leader_commit;   // Leader已提交的最高索引
};

struct AppendEntriesReply {
    uint64_t term;     // 当前任期
    bool success;      // 是否成功追加
    uint64_t conflict_index;  // 冲突优化：冲突位置
    uint64_t conflict_term;   // 冲突优化：冲突任期
};

// Raft节点核心状态
class RaftNode {
public:
    // 持久化状态（必须写入磁盘后才能响应RPC）
    uint64_t current_term_ = 0;
    std::string voted_for_;        // 当前任期投票给了谁（空=未投票）
    std::vector<LogEntry> log_;    // 日志条目（索引从1开始）

    // 易失状态（重启后从日志恢复）
    uint64_t commit_index_ = 0;    // 已知被提交的最高索引
    uint64_t last_applied_ = 0;    // 已应用到状态机的最高索引

    // Leader专有易失状态
    std::vector<uint64_t> next_index_;   // 下一条要发给每个节点的索引
    std::vector<uint64_t> match_index_;  // 已知已复制到每个节点的最高索引

    // 运行时
    Role role_ = Role::FOLLOWER;
    std::string node_id_;
    std::vector<std::string> peers_;
    std::mutex mutex_;
    std::chrono::steady_clock::time_point last_heartbeat_;
};
```

---

### 3. Leader 选举

```cpp
// 选举超时（随机化，150-300ms）
std::chrono::milliseconds randomElectionTimeout() {
    static std::mt19937 rng(std::random_device{}());
    std::uniform_int_distribution<int> dist(150, 300);
    return std::chrono::milliseconds(dist(rng));
}

// 发起选举
void RaftNode::startElection() {
    std::lock_guard lock(mutex_);

    role_ = Role::CANDIDATE;
    current_term_++;
    voted_for_ = node_id_;   // 投票给自己
    persistState();           // 持久化

    uint64_t votes_received = 1;  // 自己的一票
    uint64_t votes_needed = (peers_.size() + 1) / 2 + 1;  // 多数派

    // 并行向所有peer发送RequestVote
    RequestVoteArgs args{
        current_term_,
        node_id_,
        lastLogIndex(),
        lastLogTerm()
    };

    for (auto& peer : peers_) {
        // 异步发送（实际用RPC框架）
        asyncSendRequestVote(peer, args, [&, this](RequestVoteReply reply) {
            std::lock_guard lock(mutex_);

            if (reply.term > current_term_) {
                // 发现更高任期，退回Follower
                becomeFollower(reply.term);
                return;
            }

            if (role_ != Role::CANDIDATE) return;  // 可能已经变了

            if (reply.vote_granted) {
                votes_received++;
                if (votes_received >= votes_needed) {
                    becomeLeader();
                }
            }
        });
    }
}

// 处理投票请求
RequestVoteReply RaftNode::handleRequestVote(const RequestVoteArgs& args) {
    std::lock_guard lock(mutex_);
    RequestVoteReply reply{current_term_, false};

    // 任期比我低，拒绝
    if (args.term < current_term_) return reply;

    // 发现更高任期，更新自己
    if (args.term > current_term_) {
        becomeFollower(args.term);
    }

    reply.term = current_term_;

    // 投票条件：未投票(或已投给该候选人) + 候选人日志至少和我一样新
    bool can_vote = (voted_for_.empty() || voted_for_ == args.candidate_id);
    bool log_is_up_to_date = isLogUpToDate(args.last_log_index, args.last_log_term);

    if (can_vote && log_is_up_to_date) {
        voted_for_ = args.candidate_id;
        reply.vote_granted = true;
        persistState();
        resetElectionTimeout();  // 投票后重置超时
    }

    return reply;
}

// 日志是否足够新（选举安全性的关键）
bool RaftNode::isLogUpToDate(uint64_t candidate_last_index, uint64_t candidate_last_term) {
    uint64_t my_last_term = lastLogTerm();
    uint64_t my_last_index = lastLogIndex();

    // 先比较最后条目的term，term大的更新
    if (candidate_last_term != my_last_term) {
        return candidate_last_term > my_last_term;
    }
    // term相同，index大的更新
    return candidate_last_index >= my_last_index;
}
```

---

### 4. 日志复制

```cpp
// Leader发送AppendEntries（日志复制 + 心跳）
void RaftNode::sendAppendEntries(const std::string& peer_id, int peer_index) {
    std::lock_guard lock(mutex_);
    if (role_ != Role::LEADER) return;

    uint64_t prev_index = next_index_[peer_index] - 1;
    uint64_t prev_term = (prev_index > 0) ? log_[prev_index - 1].term : 0;

    // 收集要发送的日志条目
    std::vector<LogEntry> entries;
    for (uint64_t i = next_index_[peer_index]; i <= lastLogIndex(); i++) {
        entries.push_back(log_[i - 1]);
    }

    AppendEntriesArgs args{
        current_term_,
        node_id_,
        prev_index,
        prev_term,
        entries,
        commit_index_
    };

    asyncSendAppendEntries(peer_id, args, [&, this, peer_index](AppendEntriesReply reply) {
        std::lock_guard lock(mutex_);
        if (role_ != Role::LEADER) return;

        if (reply.term > current_term_) {
            becomeFollower(reply.term);
            return;
        }

        if (reply.success) {
            // 更新该节点的复制进度
            match_index_[peer_index] = prev_index + entries.size();
            next_index_[peer_index] = match_index_[peer_index] + 1;

            // 检查是否可以提交新的日志
            advanceCommitIndex();
        } else {
            // 日志不一致，回退next_index重试
            next_index_[peer_index] = std::max(uint64_t(1), reply.conflict_index);
        }
    });
}

// 更新commit_index（多数派确认则提交）
void RaftNode::advanceCommitIndex() {
    for (uint64_t n = lastLogIndex(); n > commit_index_; n--) {
        if (log_[n-1].term != current_term_) continue;  // 只提交当前任期的日志

        int replicated = 1;  // 自己
        for (size_t i = 0; i < peers_.size(); i++) {
            if (match_index_[i] >= n) replicated++;
        }

        if (replicated > (int)(peers_.size() + 1) / 2) {
            commit_index_ = n;
            applyCommittedEntries();
            break;
        }
    }
}

// Follower处理AppendEntries
AppendEntriesReply RaftNode::handleAppendEntries(const AppendEntriesArgs& args) {
    std::lock_guard lock(mutex_);
    AppendEntriesReply reply{current_term_, false, 0, 0};

    if (args.term < current_term_) return reply;

    // 合法的Leader心跳/日志，重置选举超时
    resetElectionTimeout();
    if (args.term > current_term_ || role_ != Role::FOLLOWER) {
        becomeFollower(args.term);
    }
    reply.term = current_term_;

    // 一致性检查：prev_log位置的日志必须匹配
    if (args.prev_log_index > 0) {
        if (lastLogIndex() < args.prev_log_index) {
            reply.conflict_index = lastLogIndex() + 1;
            return reply;
        }
        if (log_[args.prev_log_index - 1].term != args.prev_log_term) {
            reply.conflict_term = log_[args.prev_log_index - 1].term;
            // 找到该term的第一条日志（快速回退）
            for (uint64_t i = 1; i <= args.prev_log_index; i++) {
                if (log_[i-1].term == reply.conflict_term) {
                    reply.conflict_index = i;
                    break;
                }
            }
            return reply;
        }
    }

    // 追加新日志（覆盖冲突的旧日志）
    for (size_t i = 0; i < args.entries.size(); i++) {
        uint64_t index = args.prev_log_index + 1 + i;
        if (index <= lastLogIndex() && log_[index-1].term != args.entries[i].term) {
            log_.resize(index - 1);  // 截断冲突日志
        }
        if (index > lastLogIndex()) {
            log_.push_back(args.entries[i]);
        }
    }
    persistState();

    // 更新commit_index
    if (args.leader_commit > commit_index_) {
        commit_index_ = std::min(args.leader_commit, lastLogIndex());
        applyCommittedEntries();
    }

    reply.success = true;
    return reply;
}
```

---

### 5. 安全性保证

```
  Raft 安全性定理：

  1. 选举安全性：每个任期最多选出一个Leader
     → 每个节点每个任期只投一票 + 需要多数票

  2. Leader完整性：已提交的日志不会丢失
     → 选举时只有日志最新的节点才能当选（isLogUpToDate检查）
     → 新Leader一定包含所有已提交的日志

  3. 日志匹配：如果两个日志相同位置term相同，则该位置之前所有日志都相同
     → AppendEntries的一致性检查保证

  4. Leader只提交当前任期的日志
     → 防止"幽灵"重新提交（Figure 8问题）
     → advanceCommitIndex中的 if (log_[n].term != current_term_) continue;
```

---

### 6. 实际应用

| 系统 | 使用方式 | 备注 |
|------|---------|------|
| etcd | Raft共识存储 | K8s的配置中心 |
| CockroachDB | 每个Range一个Raft组 | Multi-Raft |
| TiKV | 每个Region一个Raft组 | PingCAP |
| Consul | 服务发现的一致性存储 | HashiCorp |
| RethinkDB | 表级别Raft | 已停止维护 |

---

### 总结

Raft共识算法的核心：

1. **Leader唯一**：每个任期最多一个Leader，Leader负责所有写入
2. **多数派提交**：日志被多数节点确认后才提交，保证不丢失
3. **选举安全**：只有日志最新的节点能当选，保证新Leader包含所有已提交日志
4. **随机超时防活锁**：选举超时随机化，避免多个节点同时发起选举
5. **日志连续一致**：AppendEntries的一致性检查保证前缀匹配

Raft的可理解性是它最大的工程优势。相比Paxos，Raft让你能自信地说"我理解了这个算法在做什么"——这在需要Debug分布式系统时至关重要。
