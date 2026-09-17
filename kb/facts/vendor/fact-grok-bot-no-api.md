---
id: fact-grok-bot-no-api
type: fact
title: Grok Bot 没有官方 API，且拒绝本机 MCP
summary: Cursor 的 9 个 API 面均不含 Grok Bot；官方明确不接受 localhost MCP server —— 只能走 CDP + SSH
asserted_at: 2026-09-03
volatility: medium
domain: tech
tags: [vendor, cursor, grok-bot, api]
confidence: high
status: active
sources:
  - url: INTERNALS.md
    tier: T2
    accessed: 2026-09-03
depends_on: []
related: []
answers: [为什么不用官方 API, 能不能用 MCP 接 Grok Bot, 为什么要走 SSH]
open_questions:
  - q: Cursor 后续是否会开放 Grok Bot 的 API？有没有公开路线图或表态？
    answerable_by: research
    priority: high
reviews: []
supersedes: null
superseded_by: null
---

## 事实

- Cursor 的 **9 个 API 面**均不包含 Grok Bot
- 官方**明确不接受本机（localhost）MCP server**

因此控制通道只能走 **CDP + SSH**。

## ★ 这条为什么必须按时钟复核

**整个架构建立在「没有官方 API」这个外部事实上。**
一旦 Cursor 开放 API，CDP 三级降级、SSH 通道、DOM 校验这一整套
都从「唯一可行」变成「不必要的复杂度」。

这是典型的**别人的决定决定你的架构**——所以 `volatility: medium`（90 天），
而不是当成永远成立的前提写死在代码注释里。
