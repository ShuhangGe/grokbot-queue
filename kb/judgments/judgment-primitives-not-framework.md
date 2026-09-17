---
id: judgment-primitives-not-framework
type: judgment
title: 只给原语，把分配judgment交给调用方
summary: 不内置角色/profile 配置；调用方（通常是本地 Agent）本来就有判断力，用配置固化反而限制灵活性
asserted_at: 2026-09-03
volatility: low
domain: tech
tags: [design, agents]
confidence: medium
status: active
sources:
  - url: INTERNALS.md
    tier: T1
    accessed: 2026-09-03
depends_on: [fact-grok-bot-no-api, fact-gbq-measured-throughput]
related: [concept-agent-fanout-economics]
answers: [为什么不做角色配置, 任务该怎么分配给不同的 Bot, gbq 的设计取向是什么]
open_questions:
  - q: 调用方是【弱模型】时这个取向还成立吗？那时它需要的恰恰是配置化的护栏
    answerable_by: expert
    priority: high
reviews: []
supersedes: null
superseded_by: null
---

## 判断

**gbq 只提供原语，不内置角色/profile 配置。**
怎么分配任务、哪个 Bot 干什么，交给调用方判断。

```bash
gbq read -b <bot> -n 5     # 先看某个 Bot 最近在干什么
gbq submit -b <bot> '…'    # 再决定派给谁
```

## 依据

- `fact-grok-bot-no-api`：没有官方 API，控制面本来就薄 ——
  在一层薄控制面上再堆一层配置抽象，收益低而耦合高
- `fact-gbq-measured-throughput`：Bot 有**持久上下文**（增量同步 3.0s），
  让它自然形成专长，比预先分配角色更贴合这个特性

## ★ 这个取向有个我答不了的前提

它假设**调用方有判断力**。调用方是一个强模型时成立；
如果是弱模型或纯脚本，它需要的恰恰是配置化的护栏，
而「动态判断」会退化成「随机分配」。

这个前提没有被验证过，标记为 `answerable_by: expert`。

## 什么条件下这个判断会失效

- Cursor 开放官方 API → 控制面变厚，配置抽象的成本下降
- 出现「调用方无判断力」的真实用法 → 需要一层可选的角色配置
