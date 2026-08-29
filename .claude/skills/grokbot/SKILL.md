---
name: grokbot
description: 把任务派给云端的 Cursor Grok Bot 执行，本地内存开销恒定。当用户想让 bot 干活、并行跑多个任务、把活外包出去、或提到 grokbot / gbq / 派任务给 bot 时使用。也用于排查 Grok Bot 控制通道故障。
---

# 用 Grok Bot 干活

`gbq` 是一组原语，**怎么分配、发什么，由你判断**。工具不替你做决策。

Bot 跑在云端一台 Debian 机器上（8 核 / 15Gi / 出网正常 / 有完整桌面和浏览器）。本地只有一个 Electron UI（约 400MB，**不随 Bot 数量增长**）。

`gbq` 在仓库的 `bin/gbq`，不在 PATH 就用绝对路径。

> 完整的原语语义、输出格式、退出码和失败模式表在仓库根目录的 **`AGENTS.md`**（相对本文件是 `../../../AGENTS.md`）。下面是够用的摘要。

## 工具箱

```bash
gbq bots                         # 有哪些 Bot
gbq ask  -b <bot> '问题'          # 发消息 + 等回复 + 打印   ← 一问一答，最常用
gbq send -b <bot> '消息'          # 只发不等
gbq read -b <bot> [-n N]         # 读某 Bot 最近对话（不经 UI，直接读云端 transcript）

# 批量场景
gbq submit [-b <bot>] [--ctx <名>] '任务'...   # 写进队列（不指定 -b 则轮流分配）
gbq dispatch                     # 唤醒有待办的 Bot
gbq status / wait / collect / clean

# 项目上下文
gbq ctx add <本地目录> [名字]      # 注册
gbq ctx list / sync / rm
gbq run --ctx <名> '任务'...       # submit+dispatch+wait+collect 一条龙

gbq doctor                       # 出任何问题先跑这个
```

## 怎么判断用哪个

**一问一答 → `gbq ask`。** 用户问个问题、要个调研结果、想看 Bot 怎么说，用这个。它会等到回复稳定才返回。

**批量并行 → 队列。** 有 3 个以上互相独立的任务时才值得。队列的价值是**投递成本按 Bot 数而不是任务数**（切换会话约 4 秒/Bot），任务少时开销不划算。

**要 Bot 读项目代码 → 先 `gbq ctx add` 再 `--ctx`。** 云端默认没有用户的项目。增量同步约 3 秒，比切一个 Bot 还快，所以不用吝啬。

## 怎么分配任务给 Bot

先想清楚这几点，再决定：

- **任务之间独立吗** → 独立才分给不同 Bot 并行；有依赖就串在同一个 Bot 上
- **需要项目代码吗** → 需要的话，相关任务尽量给同一个 Bot，省重复同步
- **是时效性调研吗** → 提醒 Bot 用浏览器实时查，别用训练数据回答

**利用 Bot 的持久记忆。** 这是 Grok Bot 跟 Claude subagent 最大的不同 —— 它不是用完即弃，有 `memory` 目录和完整对话历史。所以：

> 派任务前先 `gbq read -b <bot>` 看它最近在干什么。已经熟悉某个项目/领域的 Bot，继续给它同类任务，比换一个从零讲一遍强。

反过来，**别让同一个 Bot 频繁横跳不同领域**，它的记忆会互相污染。让每个 Bot 自然形成专长，是顺着这个产品的设计走。

## 写任务描述

任务由 Bot 的 AI 执行，不是 shell 脚本。

- 说清楚**要什么产出**
- 队列模式下结果要落进 JSON 的 `result` 字段，提醒它别在对话里长篇输出
- 时效性问题**明确要求实时查证**并注明来源日期
- Bot 能跑 shell、读写 `/workspace`、有 sudo 免密、能上网

## 三级降级

控制 Grok Bot 靠操作它的 Electron 界面，**没有官方 API**，所以 DOM 选择器是最脆弱的一环。已做自动降级：

| 级别 | 手段 | 何时生效 |
|---|---|---|
| L1 | CDP + 精确选择器 | 默认 |
| L2 | CDP + 启发式（最宽的 contenteditable、按重复兄弟结构认列表） | Grok Bot 改了 class |
| L3 | computer use（截图+点击） | DOM 整个不可用 |

自动切换，无需干预。`GBQ_FORCE_LEVEL=n` 强制某级（调试用）。

**L3 硬前提：Grok Bot 窗口必须在当前 Space。** 窗口在别的桌面时点击会返回成功但**静默无效**（实测过），所以 L3 会先检测并明确报 `L3_WINDOW_OFF_SPACE` —— 遇到这个要让用户把窗口挪到当前桌面。

## 限制（回答用户时如实说）

- **投递串行**：同一时刻只有一个 activeAgent，切换约 4 秒/Bot
- **上限 4–8 个 Bot**：再多，投递开销和 8 核 CPU 争抢吃掉收益
- **多 Bot 共享一台机器**：不是每 Bot 一台，共享 CPU / 内存 / 文件系统 / `/workspace`
- **sshd 不抗容器重启**
- **依赖 UI 自动化**：Grok Bot 升级可能打断 L1

## 安全

- Electron inspector 开启时 `127.0.0.1:9229` 对本机任何进程开放，等于完全控制 Grok Bot。gbq **每次用完自动关闭**，别手动开着不管
- 云端机器是 Cursor 托管的，**别放长期凭证**；`--ctx` 会把项目代码传上去，敏感项目要提醒用户
- `/workspace` 内容所有 Bot 都能看见

## 排障

先 `gbq doctor`。

| 症状 | 多半是 |
|---|---|
| SSH 连不上 | **云端容器重启，sshd 没了** —— 最常见，按 SETUP.md 重建，别重新调研 |
| `gbq bots` 空 | Grok Bot 应用没开（最小化没关系，关掉才不行） |
| doctor 说 L1 失效 | Grok Bot 升级改了 DOM，L2 会接管；L2 也报错就要更新选择器 |
| Bot 不干活 | `gbq read -b <bot>` 看它在说什么，可能在问问题或撞上权限确认卡 |
| 任务完成但没结果文件 | Bot 没遵守协议，`gbq send -b <bot> '把结果写到 outbox'` 补救 |
