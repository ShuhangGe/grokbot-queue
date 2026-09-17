# 开放问题

> ⚙️ 自动生成 · 2026-09-14 · 共 4 个待验证问题

把知识库从「参考资料」变成「工作队列」。
来源是各条目 front-matter 的 `open_questions`，按**谁能回答**分组。

```yaml
# 在条目里这样声明（由模型在写入时判定 answerable_by）
open_questions:
  - q: "流水已上亿实际来自支付还是博彩生态？"
    answerable_by: internal        # internal | research | expert
    priority: high                 # 可选
```

## ▸ 内部可验证（问同事 / 查内部数据就能答）  <sub>2 个</sub>

- [ ] Bot 数量增加到 4–8 个时加速比如何？有没有测过？  `medium`
      ↳ 来自 [`fact-gbq-measured-throughput`](facts/entity/fact-gbq-measured-throughput.md)
- [ ] 对方前端改版后这几条还成立吗？有没有办法让 CI 定期验一遍？  `medium`
      ↳ 来自 [`playbook-ui-automation-traps`](reference/playbooks/playbook-ui-automation-traps.md)

## ▸ 需要外部调研  <sub>1 个</sub>

- [ ] Cursor 后续是否会开放 Grok Bot 的 API？有没有公开路线图或表态？  `high`
      ↳ 来自 [`fact-grok-bot-no-api`](facts/vendor/fact-grok-bot-no-api.md)

## ▸ 需要专业意见  <sub>1 个</sub>

- [ ] 调用方是【弱模型】时这个取向还成立吗？那时它需要的恰恰是配置化的护栏  `high`
      ↳ 来自 [`judgment-primitives-not-framework`](judgments/judgment-primitives-not-framework.md)

## 📝 待结构化

以下条目正文里有「失效条件 / 待确认 / 未核实」章节，但没有把问题固化进 `open_questions`。
**这是设计要求：语义判断要在写入时做掉，维护路径才能保持零模型。**

✅ 全部已结构化。
