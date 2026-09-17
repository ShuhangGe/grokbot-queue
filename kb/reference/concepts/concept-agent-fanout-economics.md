---
id: concept-agent-fanout-economics
type: reference
title: agent 扇出的成本结构：为什么本机开销可以不随并发增长
summary: 把执行放到远端、本机只留控制面，并发的边际成本就从「每个 agent 一份内存」变成「一条消息」
asserted_at: 2026-09-03
volatility: low
domain: tech
tags: [architecture, agents, orchestration]
confidence: high
status: active
sources: []
depends_on: []
related: [fact-gbq-measured-throughput]
answers: [并行跑多个 agent 为什么会吃爆内存, 怎么让 agent 并发不涨成本, agent 编排的成本结构是什么]
open_questions: []
reviews: []
supersedes: null
superseded_by: null
---

## 机制

```
本地扇出          每个 agent 一个进程 → N × 150–335MB，随任务数继续爬
远端扇出          执行在对方机器上，本机只留一个控制面 → 常数开销
```

关键不在「用了云」，而在**把「执行」和「控制」拆开**：

- **控制面**（本机）：派活、读状态、收结果 —— 都是消息，开销与并发数无关
- **执行面**（远端）：每个 agent 有自己的进程与持久上下文，互不干扰

## 三个跟着变化的性质

1. **成本与并发解耦** —— 加一个 agent 的边际成本是一条唤醒消息，不是一份内存
2. **上下文可复用** —— 远端 agent 有持久记忆，增量同步（3.0s）比冷启一个新 agent（4s）还快
3. **失败是局部的** —— 一个 agent 卡住不影响别的；本地扇出里一个 OOM 会拖垮全部

## 什么时候这个模型不成立

- 任务本身需要访问**只在本机存在**的东西（本地数据库、未推送的改动）
- 单个任务的**上下文传输成本**超过它的执行成本
- 对方的并发配额比你需要的低 —— 那时瓶颈从内存变成配额
