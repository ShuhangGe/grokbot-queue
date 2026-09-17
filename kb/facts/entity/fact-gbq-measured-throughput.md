---
id: fact-gbq-measured-throughput
type: fact
title: gbq 的实测吞吐与上下文同步开销
summary: 双 Bot 并行加速比 1.88x；上下文 2.1MB/250 文件首次 9.6s、增量 3.0s；本机常驻约 400MB 不随任务数增长
asserted_at: 2026-08-29
volatility: medium
domain: tech
tags: [performance, benchmark]
confidence: high
status: active
sources:
  - url: INTERNALS.md
    tier: T1
    accessed: 2026-09-03
depends_on: []
related: []
answers: [gbq 能有多快, 并行是真的吗, 上下文同步要多久, 本机内存占多少]
open_questions:
  - q: Bot 数量增加到 4–8 个时加速比如何？有没有测过？
    answerable_by: internal
    priority: medium
reviews: []
supersedes: null
superseded_by: null
---

## 实测（2026-08-29）

| 项 | 数值 |
|---|---|
| 双 Bot 并行加速比 | **1.88x**（重叠 28s / 墙钟 32s / 串行需 60s） |
| 端到端 4 任务 2 Bot | dispatch 23s · 执行 26s · 收集 4/4 |
| SSH 3 连接 | 2.65s（串行需 6s+）；连接复用 2.38s → 0.47s |
| 上下文同步 2.1MB/250 文件 | 首次 9.6s · 增量 3.0s · 无变化 1.7s |
| 本机常驻 | **约 400MB，不随 Bot/任务数增长** |

## 为什么本机内存不涨

执行发生在云端——每个 Bot 有自己的 `exec-daemon` 进程，本机只有一个 Electron UI 壳。
对比：本地跑 N 个 agent 是 N × 150–335MB 且随任务数继续爬。

## 为什么 volatility 是 medium

这是**自家系统的实测**，但它依赖对方云端的性能，对方一次调整就可能改写。
90 天复核一次。
