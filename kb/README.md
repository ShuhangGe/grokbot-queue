# 知识库 kb/

> ⚙️ **由 mindlink 生成**（`mindlink upgrade` 会覆盖）。想改措辞去上游改 `templates/kb-README.md`。

**外部世界的事实，以及我们对外部的判断。**

> ## ⚠️ 第一条规则
> **agent 起草并落盘，每批附一份摘要；人按摘要把关，不逐条确认。**
> 确认的单位是一批的摘要，不是一条条目 —— 逐条在真实用量下做不到，做不到的规则等于没有规则。
> commit message 就是摘要（每条一行：id · 一句话 · 会怎么坏）；有疑问点名那一条；错了走 supersede。
> 不变的是：写入必须可追溯（`derived_from` / `sources`）。

> ## 模型 / 脚本的分工
> **模型**从非结构化内容产生结构化数据（summary、type、volatility、domain、
> `depends_on`、`open_questions`、来源分级、复核时判断"变没变"）。
> **脚本**从已结构化数据推导确定性结论（日期算术、图遍历、地基传导、索引生成）。
>
> **模型只在【写入】和【复核】时介入；维护路径零模型。**
> 这不是省钱，是因为 `pre-commit` 和 `weekly-check`（cron）里根本没有模型可用。
>
> 推论：**发现某个自动化步骤需要模型，说明有个语义判断没被固化成字段。把它固化。**

```
docs/   我们【设计】的东西 —— 变化是因为【我们改了想法】
kb/     【外部世界】的事实与判断 —— 变化是因为【世界变了】
```

---

## 入口

| 文件 | 用途 | 手改？ |
|---|---|---|
| [`ROUTE.md`](ROUTE.md) | **无条件必读入口**。按问题找条目，一条目一行 | ⚙️ 自动生成 |
| [`INDEX.md`](INDEX.md) | 全部条目 + 摘要 + 新鲜度 + 按领域分组 | ⚙️ 自动生成 |
| [`index.json`](index.json) | 机器可读，含章节锚点、标签、反向链接 | ⚙️ 自动生成 |
| [`STALE.md`](STALE.md) | 待复核清单 | ⚙️ 自动生成 |
| [`GRAPH.md`](GRAPH.md) | 依赖图：哪些判断依赖哪些事实 | ⚙️ 自动生成 |
| [`OPEN.md`](OPEN.md) | **开放问题工作队列**，按「谁能回答」分组 | ⚙️ 自动生成 |

> **这六个文件永远不要手改。**改了会和内容漂移。真相来源是各 `.md` 的 front-matter。

---

## 四种条目

| type | 是什么 | 会怎样 |
|---|---|---|
| `fact` | 可证实的外部事实。有来源、有日期 | **会过期**，到期要复核 |
| `judgment` | 我们的判断 | **会被事实推翻**，必须声明 `depends_on` |
| `reference` | 稳定的领域知识（机制、原理、集成方式） | 低易变 |
| `decision` | 已定决策 | 不改，要变就新开一条 |

**为什么必须分开**：判断声明它依赖哪些事实，于是事实被推翻时，
`GRAPH.md` 能直接列出「哪些结论该被重新审视」。
没有这个机制，知识库更新了但结论不会更新——那是最危险的状态。

---

## Front-matter Schema

必填只有 6 个字段，其余可选。

```yaml
---
# ── 必填 ──
id: fact-mastercard-bvnk-acquisition   # 全局唯一，必须与文件名一致，稳定不变
type: fact                             # fact | judgment | reference | decision
title: Mastercard 收购 BVNK
summary: 一句话，进索引用，建议 ≤160 字
asserted_at: 2026-08-19                # 我们【核实】它的日期，不是事件发生日期
volatility: static                     # high | medium | low | static
domain: business                       # ★ business | tech | both

# ── 可选：时间 ──
event_at: 2026-03-01                   # 事件【实际发生】的日期（仅用于叙述）
effective_at: 2027-01-18               # ★ 内容【开始生效】的日期
wake_at: 2027-01-11                    # ★ 硬闹钟；不填则由 effective_at 提前 7 天推导

# ── 可选：工作队列 ──
open_questions:                        # ★ 汇总进 OPEN.md
  - q: "商户购买代币是市场买还是金库买？"
    answerable_by: internal            # internal | research | expert
    priority: high

reviews:                               # ★ 复核记录，由 review.mjs 追加
  - at: 2026-11-19
    outcome: unchanged                 # unchanged | updated

# ── 可选：其他 ──
tags: [ma, stablecoin, competitor]
entities: [Mastercard, BVNK]
confidence: high                       # high | medium | low
status: active                         # active | stale | superseded | archived | draft
sources:
  - url: https://...
    tier: T2                           # T1 一手 | T2 权威二手 | T3 一般二手
    accessed: 2026-08-19
depends_on: []                         # ★ judgment 必填：依赖哪些 fact 的 id
related: [fact-stripe-bridge]
supersedes: null
superseded_by: null
---
```

### 时间模型

时间在知识库里有**三种形态**，本系统三种都处理：

| 形态 | 是什么 | 机制 |
|---|---|---|
| **① 衰减** | 知识随时间失真 | `volatility` → 周期复核 |
| **② 到期** | 某个**确定的未来时点**会变化 | `effective_at` / `wake_at` → **硬闹钟** |
| **③ 传导** | 地基变了，上层结论跟着松动 | `depends_on` → **地基健康度** |

**volatility → 复核周期**

| volatility | 周期 | 典型内容 |
|---|---|---|
| `high` | **30 天** | 市场数据、竞品动态、监管进程、融资并购 |
| `medium` | **90 天** | 供应商能力与定价、产品状态、牌照要求 |
| `low` | **365 天** | 概念机制、技术原理、行业结构 |
| `static` | 不复核 | 已发生的历史事件 |

**推导规则**（脚本自动，不写进 front-matter）：

```
wake_at   = 显式 wake_at ?? (effective_at − 7 天)
            ★ 且必须晚于 asserted_at —— 核实时就已过去的生效日不产生闹钟
review_by = min(asserted_at + volatility周期, wake_at)
            ★ 硬闹钟优先
```

**状态**：`✅ 新鲜` · `🟡 7天内到期` · `🔴 已过期` · `⏳ 已核实但尚未生效` · `⚪️ 不复核`

### ★ 地基健康度传导

**判断的可信度不高于它所依赖的最差的那条事实。**

```
judgment 自己新鲜 + 依赖全部有效   → ✅ 地基稳固
judgment 自己新鲜 + 依赖有 1 条过期 → ⚠️ 地基松动
```

地基松动的判断会出现在 `STALE.md` 的专门一节。
**在地基修好之前，这些结论不应被直接引用。**

这解决了本文开头说的那个最危险的状态：知识库更新了，但结论没有跟着更新。

### 来源分级

| tier | 含义 | 例子 |
|---|---|---|
| **T1** | 一手 | 监管公告、法条、财报、公司官网、官方 API 文档 |
| **T2** | 权威二手 | 律所分析、主流财经媒体、审计报告 |
| **T3** | 一般二手 | 博客、评测站、聚合站 |

> **规则（校验强制）**：仅 T3 支撑的 `fact`，`confidence` 不得为 `high`。

---

## 四个操作

### 复核（推荐入口）

```bash
node kb/.scripts/review.mjs --due              # 列出所有该复核的
node kb/.scripts/review.mjs <id>               # 显示待核信息（来源、依赖它的判断、复核历史）
node kb/.scripts/review.mjs <id> --unchanged   # 没变 → 更新 asserted_at + 记录
node kb/.scripts/review.mjs <id> --updated     # 就地修正了 → 同上
node kb/.scripts/review.mjs <id> --supersede   # 世界变了 → 提示走 supersede，并列出受影响的判断
```

连续多次 `unchanged` 时，脚本会**建议**下调 volatility（只建议，人决定）。

### 增

```bash
node kb/.scripts/new.mjs                       # 交互式
node kb/.scripts/new.mjs --type fact --id fact-xxx --title "…" --volatility high --dir facts/market
node kb/.scripts/build-index.mjs               # 重建索引
```

### 改

**补充内容 / 复核后确认没变** → 直接编辑，把 `asserted_at` 更新为今天。

**我们当初记错了** → 原地修正，并在正文末尾追加：

```markdown
## 修订记录
- 2026-09-01：原记「$607M/年」有误，实为「$607M/月」。来源核对：…
```

### 取代（世界变了 —— 首选方式）

```bash
node kb/.scripts/new.mjs --supersedes <被取代的 id>
```

自动完成三件事：新建条目、把旧条目标为 `superseded` 并双向链接、
**列出依赖该事实的所有判断**。

> **为什么不直接改**：judgment 引用了它。原地改会丢失
> 「我们当时为什么那么想」，也无法追溯结论该不该跟着变。

### 删

```bash
git mv kb/facts/market/xxx.md kb/_archive/
```

改 `status: archived`，重建索引。**不硬删** —— 硬删会让依赖图断裂。

---

## 保鲜

```bash
node kb/.scripts/check-stale.mjs          # 列出过期 / 临期
node kb/.scripts/check-stale.mjs --json   # 机器可读
node kb/.scripts/validate.mjs             # 校验 front-matter（CI / pre-commit）
```

**当前做到第二层**：

| 层 | 机制 | 状态 |
|---|---|---|
| 一 · 被动可见 | `STALE.md` 每次 build 自动生成 | ✅ 已做 |
| 二 · 主动提醒 | 周度提醒把 `STALE.md` 前 N 条推给人 | ✅ 已做 |
| 三 · 自动复核 | 月度 agent 自动 WebSearch 重核 + 起草 supersede | ⏸ 暂缓，跑一个月看节奏再定 |

> ⚠️ 无论做到哪层，**都不让 agent 自动合并知识库变更**。
> 让 agent 直接改知识库是引入错误最快的方式——它只负责起草，人负责确认。

---

## 检索：为什么现在不上向量库

| 理由 | 说明 |
|---|---|
| 语料规模 | 目前几十条，可预见 1~2 年内几百条。远未到向量检索的必要规模 |
| 消费者是 agent | Claude Code 有 grep / glob / read。**结构良好的 markdown + 好索引，效果优于粗糙的向量库** |
| 隐藏成本 | 基建 + 同步 + **embedding 会随文档更新失效**，而核心需求正是频繁更新 |
| 可逆 | front-matter + 稳定 id + 章节化已留好接口，日后加向量层**零重构** |

**触发条件**（到点再做，不要提前）：

- 条目数 > 300，或
- 需要给**产品**（而非内部 agent）做语义搜索，或
- 「知道有这信息但想不起在哪条」每周超过 3 次

---

## 条目和原文档的关系：提炼，不是搬运

条目是从项目文档里**提炼**出来的可过期断言，原文档留在原地。两者之间用 `derived_from` 连接：

```yaml
derived_from:
  - path: docs/11-STORE-COMPLIANCE.md     # 相对项目根
    hash: 8f3a2c1d9e02                    # 起草时那份文档的内容指纹
```

`new.mjs --from docs/x.md` 自动填。之后每次 `build-index`（也就是每次 pre-commit）比对指纹：
原文改了 → `STALE.md`「🟠 出处已变动」；复核 `review.mjs <id> --unchanged` 会刷新指纹。

**没有 `derived_from` 的条目，原文改了 kb 不会知道** —— 只能等 `volatility` 到期。

### 勘察台账：每份文档都得有去向

`build-index` 还会扫一遍项目里的文档（排除 kb/、依赖目录、agent 入口文件）。
没有去向的挂在 `STALE.md`「📄 未处理的文档」里，直到有人决定：

| 去向 | 怎么记 |
|---|---|
| 进 kb | `new.mjs --from <path>`（自动记） |
| 不进 | `survey.mjs --skip <path> --why "规格文档，随代码变"`（支持 glob：`--skip 'probes/0*/FINDINGS.md'`） |
| 永远不看 | `kb/.kbignore` 里加一行（日报、实验产物这类每天新增的） |

**多数文档不该进。** 规格、流程、设计稿变化是因为「我们改了想法」，不是「世界变了」。
「不进」的理由记在 `kb/.survey.json`（入 git）；那份文档以后改了，会低优先级提一句。

## 反馈：你是这套工具的用户

这套系统是**面向 agent** 的 —— agent 是它的客户，所以改进方向应该由 agent 提。
用的过程中卡住了、缺什么、觉得哪条规则不对，一行命令记下来：

```bash
node kb/.scripts/feedback.mjs --kind friction --doing "给 store-compliance 建条目" "supersede 流程找了三分钟，new.mjs --help 里没提"
node kb/.scripts/feedback.mjs --list          # 提之前先看有没有人提过（含被拒的和原因）
```

| kind | 含义 |
|---|---|
| `bug` | 坏了：报错、产物不对、数据丢失 |
| `friction` | 能用，但别扭：找了很久、绕了弯、不确定该用哪个 |
| `missing` | 缺能力：想做的事没有命令 |
| `wrong` | 规则本身不对：照着做反而更差 |
| `question` | 不确定该怎么做，文档没说清 |
| `review` | **任务收尾的复盘**：`--verdict helped\|neutral\|hindered` 必填。不是抱怨，是数据 |

**门槛**：只记**真的挡住你**或**你有具体更好做法**的。一条一个文件。`--doing` 必填 ——
同一条意见附上任务背景，才分得清它是普遍的还是特定场景的。

**去向**：反馈文件住在 `kb/feedback/`，**不入 git**（`kb/.gitignore`）。中央 agent 用
`mindlink feedback` 把所有库的反馈聚起来看，**多个库独立提出同一件事**会被标出来 ——
那是「这个需求是真的」的结构信号。处理结果（accepted / rejected / done）连同理由
写回原文件，被拒的不删。

## 目录

```
kb/
├── facts/          可证实的外部事实
│   ├── market/       市场规模、竞品数据、交易量
│   ├── regulation/   各法域监管状态与进程
│   ├── vendor/       供应商的可核实事实
│   └── entity/       关联主体的公开信息
├── reference/      稳定的领域知识
│   ├── concepts/     术语与机制原理
│   ├── integration/  供应商集成方式
│   └── playbooks/    工程实践
├── judgments/      我们的判断与评估
├── <主题>/         主题文件夹（如 agent/）：某个领域的 fact / judgment / reference 混放，
│   └── research/     调研报告：原始笔记、来源、过程，不需要 front-matter。不是条目，是条目的出处
│                   各自的 type 字段带时间语义；共享层里用得最多，一个主题一个 owner
├── feedback/       agent 对【这套工具】的意见（不入 git，见下）
├── .survey.json    勘察台账：每份项目文档的去向（入 git）
├── .kbignore       排除规则：目录名或 glob，条目遍历与文档扫描都认（入 git；定制放这里，别改脚本）
└── _archive/       已取代 / 归档
```
