---
id: playbook-ui-automation-traps
type: reference
title: 无 API 时驱动别人家 UI 的四个陷阱
summary: 返回值会撒谎、截图帧会过期、受控编辑器不认 innerText、渲染有竞态 —— 一律以 DOM 查询为准
asserted_at: 2026-09-03
volatility: medium
domain: tech
tags: [automation, cdp, playbook]
confidence: high
status: active
sources:
  - url: INTERNALS.md
    tier: T1
    accessed: 2026-09-03
depends_on: []
related: [fact-grok-bot-no-api]
answers: [CDP 自动化有哪些坑, 为什么点击成功了却没生效, 怎么可靠地往输入框写字]
open_questions:
  - q: 对方前端改版后这几条还成立吗？有没有办法让 CI 定期验一遍？
    answerable_by: internal
    priority: medium
reviews: []
supersedes: null
superseded_by: null
---

## 四个陷阱，共同的教训是【别信反馈，去查状态】

| 陷阱 | 表现 | 处理 |
|---|---|---|
| **返回值撒谎** | 窗口不在前台时 `click` 返回 `✅ Posted`，实际静默无效 | 查 DOM 验证，不看返回值 |
| **截图帧过期** | 输入框显示 placeholder，而文字其实已写入 | 以 DOM 查询为准，不以截图为准 |
| **受控编辑器** | ProseMirror 改 `innerText` 不同步内部 state | 必须 `execCommand('insertText')` |
| **渲染竞态** | 插入文本后立刻找发送按钮 → 找不到 | 轮询等按钮出现 |

## ★ 还有一个更隐蔽的：把「静默」当「完成」

早期用「N 秒没有新消息 = 答完了」判定结束。Bot 做浏览器搜索时天然会静默一段，
于是拿到的是「正在搜索」而不是结果。
**修法是找一个明确的状态信号**（UI 的 `<bot> is working`），而不是猜。

## 为什么这条是 reference 而不是 fact

它描述的是**机制**（受控编辑器为什么不认 innerText、渲染为什么有竞态），
这些不随时间失真。但**具体选择器和 UI 行为会随对方改版失效** ——
所以 `volatility: medium`，改版后要重验。
