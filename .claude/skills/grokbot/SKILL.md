---
name: grokbot
description: 把一批任务派给多个 Cursor Grok Bot 并行执行，本地内存开销恒定。当用户想并行跑多个任务、把活外包给 Grok Bot、或提到 grokbot / gbq / 派任务给 bot 时使用。也用于排查 Grok Bot 控制通道故障。
---

# 用 Grok Bot 并行执行任务

`gbq` 把任务分发给多个 Grok Bot 在云端并行执行。本地只有一个 Electron UI（约 400MB，**不随 Bot 数量增长**），任务执行全在云端 8 核 / 15Gi 的机器上。

实测：2 Bot 并行加速比 1.88x；4 任务 26 秒完成。

## 先决条件

`gbq` 在 `<仓库>/bin/gbq`。若不在 PATH，用绝对路径调用。

**动手前先体检**，它会告诉你哪一级通道可用：

```bash
gbq doctor
```

若报 SSH 连不上 —— **最常见原因是云端容器重启导致 sshd 丢失**，不是配置错。按 SETUP.md 里那段命令让 Bot 重新拉起 sshd，不要重新调研。

## 标准流程

```bash
gbq bots                                  # 有哪些 Bot
gbq run '任务A' '任务B' '任务C'             # 提交→唤醒→等待→取回
```

结果在 `./gbq-results/<bot>/<任务id>.json`，格式 `{id, status, result, finished}`。

分步控制：

```bash
gbq submit '任务A' '任务B'      # 轮流分给各 Bot
gbq submit -b walle '指定 Bot'
gbq submit -f tasks.txt        # 每行一个任务
gbq dispatch                   # 唤醒有待办的 Bot
gbq status                     # 看队列
gbq wait --timeout 600
gbq collect -o ./results
gbq send -b walle '直接发消息'   # 不走队列
gbq clean
```

## 写任务描述的要点

任务会被 Bot 的 AI 执行，不是 shell 脚本。所以：

- **写清楚产出什么**，因为结果要落进 JSON 的 `result` 字段
- **一个任务一件事** —— 任务之间会分给不同 Bot 并行跑，有依赖关系的别拆开
- **别让 Bot 在对话里长篇输出** —— 唤醒提示词已经要求它写文件，但任务描述里再强调一次更稳
- Bot 能执行 shell、读写 `/workspace`、有 sudo 免密

## 三级降级（这是这套方案的关键设计）

控制 Grok Bot 靠的是操作它的 Electron UI，**没有官方 API**。所以有三级兜底：

| 级别 | 手段 | 何时生效 |
|---|---|---|
| L1 | CDP + 精确选择器 `.sand-prompt-field` 等 | 默认，最快 |
| L2 | CDP + 启发式（找最宽的 contenteditable、按重复兄弟结构认列表） | Grok Bot 升级改了 class |
| L3 | computer use（cua-driver 截图+点击） | DOM 整个不可用 |

自动降级，无需干预。`GBQ_FORCE_LEVEL=2` 可强制某一级（调试用）。

**L3 有硬前提：Grok Bot 窗口必须在当前 Space。** 窗口在别的桌面时，点击会返回成功但**静默无效**，键盘输入也被丢弃 —— 这是实测过的坑。`_l3_available` 会先检测并明确报 `L3_WINDOW_OFF_SPACE`，此时要让用户把窗口挪到当前桌面。

## 已知限制（回答用户时要如实说）

- **投递串行**：同一时刻只有一个 activeAgent，切换约 4 秒/Bot。所以投递成本 = 4 秒 × Bot 数，**与任务数无关**
- **上限 4–8 个 Bot**：再多，投递开销和 8 核 CPU 争抢会吃掉并行收益
- **多 Bot 共享一台机器**：不是每 Bot 一台，共享 CPU / 内存 / 文件系统
- **Bot 有持久记忆**：不像 Claude subagent 用完即弃。`~/sand-data/agents/<uuid>/memory` 会累积。适合当"驻场同事"，不适合当一次性 worker
- **sshd 不抗容器重启**
- **依赖 UI 自动化**：Grok Bot 升级可能打断 L1，这是最大长期风险

## 安全

- Electron inspector 开启期间，`127.0.0.1:9229` 对本机任何进程开放，等于完全控制 Grok Bot。**gbq 每次用完自动关闭**，不要手动开着不管
- 云端机器是 Cursor 托管的，**别在上面放长期凭证**
- `/workspace` 内容所有 Bot 都能看见

## 排障

先跑 `gbq doctor`，它会指出是哪一环坏了。

| 症状 | 多半是 |
|---|---|
| SSH 连不上 | 云端容器重启，sshd 没了 |
| `gbq bots` 空 | Grok Bot 应用没开，或窗口被关（最小化没关系） |
| doctor 说 L1 失效 | Grok Bot 升级改了 DOM，L2 会自动接管；若 L2 也报错需要更新选择器 |
| Bot 唤醒了不干活 | 看那个 Bot 的对话，可能在问问题或撞上权限确认卡 |
| 任务完成但没结果文件 | Bot 没遵守协议，用 `gbq send -b <bot> '把结果写到 outbox'` 补救 |

不用切 UI 也能看 Bot 在干什么：

```bash
ssh <host> 'tail -5 ~/sand-data/agent-transcripts/*/*.jsonl'
```
