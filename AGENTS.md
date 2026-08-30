# gbq — 给 AI Agent 的说明

你可以用 `gbq` 把任务派给云端的 Cursor Grok Bot 执行。**怎么分配、发什么，由你判断** —— 这个工具只提供原语，不替你决策。

执行环境：云端一台 Debian 13 机器，8 核 / 15Gi / 出网正常 / 有完整桌面和浏览器 / `box` 用户有 sudo 免密。本地只有一个 Electron UI（≈400MB，不随 Bot 数增长）。

可执行文件在仓库 `bin/gbq`。不在 PATH 就用绝对路径。

---

## 动手前

```bash
gbq doctor          # 退出 0 表示通道可用；任何异常都先看它的输出
gbq bots            # 每行一个 Bot 名，可能含空格（如 "New Bot"），务必加引号
```

`doctor` 的结论行会写明当前走 L1/L2/L3 哪一级通道。

---

## 原语

| 命令 | 阻塞 | stdout 格式 | 说明 |
|---|---|---|---|
| `gbq bots` | 否 | 每行一个 Bot 名 | |
| `gbq read -b <bot> [-n N] [-A]` | 否 | 每行 `[role] text` | 读云端 transcript，不经过 UI。`-A` 只看 Bot 回复；默认含双方（**Bot 的实际产出常在 user-role 的回灌消息里，别默认加 -A**） |
| `gbq ask -b <bot> '问题'` | **是** | 同 `read` | 发消息 → 等到 Bot 空闲 → 打印新增对话。默认超时 300s，`--timeout N` 可调 |
| `gbq send -b <bot> '消息'` | 否 | `✓ 已发送` | 只发不等 |
| `gbq submit [-b <bot>] [--ctx <名>] '任务'...` | 否 | 每行 `<任务id> -> <bot>` | 写队列。不给 `-b` 则轮流分配 |
| `gbq dispatch` | 否 | 每 Bot 一行 | 唤醒有待办的 Bot |
| `gbq status` | 否 | 表格 `BOT / INBOX / OUTBOX` | |
| `gbq wait [--timeout N]` | **是** | `✓ 全部完成` 或超时警告 | 默认 900s |
| `gbq collect [-o 目录]` | 否 | 取回的文件路径列表 | 默认落 `./gbq-results/` |
| `gbq run [--ctx <名>] '任务'...` | **是** | 以上串联 | submit+dispatch+wait+collect |
| `gbq ctx add <目录> [名字]` | 否 | `✓ 已注册…` | |
| `gbq ctx list / sync [名] / rm <名>` | sync 是 | | |

**退出码：成功 `0`，失败非 `0`。** 参数错误、Bot 不存在、通道不可用都返回非 0 并在 stderr 写原因。

任务结果 JSON：`{"id","status":"ok"|"error","result","finished"}`，失败时多一个 `"error"` 字段。

---

## 怎么选

**一问一答 → `ask`。** 用户要个调研、问个问题、想看 Bot 怎么说，用这个。它会等到 Bot 真的空闲才返回。

**批量并行 → 队列（`run` 或 submit+dispatch）。** 只有 **3 个以上互相独立**的任务才值得。队列的价值是投递成本按 Bot 数而非任务数（切换会话约 4 秒/Bot），任务少时这个开销不划算。

**要 Bot 读项目代码 → 先 `ctx add` 再 `--ctx`。** 云端默认没有用户的项目。增量同步约 3 秒，比切一个 Bot 还快，不用吝啬。⚠️ **这会把代码传到 Cursor 托管的机器上，敏感项目要先问用户。**

---

## 怎么分配任务

决定派给谁之前，先想清楚：

- **任务之间独立吗** —— 独立才分给不同 Bot 并行；有依赖就串在同一个 Bot 上
- **需要项目代码吗** —— 需要的话，相关任务尽量给同一个 Bot，省重复同步
- **是时效性问题吗** —— 明确要求 Bot 用浏览器实时查，并注明来源和日期，否则它可能用训练数据答

**利用 Bot 的持久记忆。** Grok Bot 跟一次性 subagent 不同 —— 它有 `memory` 目录和完整对话历史。所以：

> 派任务前先 `gbq read -b <bot>` 看它最近在干什么。已经熟悉某个项目或领域的 Bot，继续给它同类任务，比换一个从零讲一遍强。

反过来，**别让同一个 Bot 频繁横跳不同领域**，记忆会互相污染。让每个 Bot 自然形成专长。

---

## 写任务描述

任务由 Bot 的 AI 执行，不是 shell 脚本。

- 说清楚**要什么产出**
- 队列模式下结果要落进 JSON 的 `result` 字段，**提醒它别在对话里长篇输出**
- 时效性问题明确要求实时查证 + 注明来源日期
- Bot 能跑 shell、读写 `/workspace`、有 sudo、能上网

---

## 失败模式速查

| 现象 | 原因 | 处理 |
|---|---|---|
| SSH 报 `kex_exchange_identification: Connection closed` | **云端节点下线**（关掉 Grok Bot 桌面应用后会发生）。注意 `nc -z` 此时仍显示端口通，具有迷惑性 | `tailscale status \| grep linux` 确认；让用户打开 Grok Bot 应用 |
| SSH 连不上（节点在线） | 容器重启，sshd 丢了 | 按 SETUP.md 让 Bot 重新拉起 sshd。**不要重新调研通道方案** |
| `gbq bots` 报「应用未运行」+ SSH 也断 | **两条通道都依赖桌面应用**，它关了就都没了 | 让用户打开 Grok Bot |
| `gbq bots` 空/报错 | Grok Bot 应用没开（最小化没关系，关掉才不行） | 让用户打开 |
| doctor 报 L1 失效 | Grok Bot 升级改了 DOM | L2 会自动接管；L2 也失效才需要更新选择器 |
| doctor 报 `L3_WINDOW_OFF_SPACE` | Grok Bot 窗口在别的桌面 | 只影响 L3。真要用 L3 得让用户把窗口挪到当前桌面 |
| `ask` 超时 | Bot 干得久，或卡在权限确认卡 | `gbq read -b <bot>` 看它在说什么 |
| 任务完成但 outbox 没文件 | Bot 没遵守协议 | `gbq send -b <bot> '把结果写到 outbox'` 补救 |
| Bot 用训练数据答时效问题 | 任务描述没强调 | 重发并明确要求浏览器实时查 |

不切 UI 也能看 Bot 在干什么：

```bash
gbq read -b <bot> -n 20
```

---

## 注意

- **`dispatch` / `ask` / `send` 会切换 Grok Bot 的当前会话**，这是可见的 UI 副作用。用户正在手动用 Grok Bot 时要提一句
- **`--ctx` 上传代码**，敏感项目先问用户
- Electron inspector 在投递期间开放 `127.0.0.1:9229`（本机任何进程可完全控制 Grok Bot），gbq 每次用完自动关闭 —— **不要绕过 gbq 自己开着不管**
- 云端机器是 Cursor 托管的，**别往上放长期凭证**
- 所有 Bot 共享 `/workspace`，多 Bot 并发写同一路径要自己分目录
- 云端网络屏蔽了部分站点（实测 `theblock.co`、`cointelegraph.com`、Google News），调研任务要留意来源覆盖面

---

## 一个完整例子

```bash
gbq doctor || exit 1
gbq bots                                    # → walle / New Bot

gbq read -b walle -n 10                     # 看 walle 最近在干什么，决定派给谁

gbq ctx add ~/work/my-service               # 需要代码时先注册
gbq run --ctx my-service \
  '分析 src/api 的错误处理，列出没有 catch 的异步调用' \
  '统计各模块的测试覆盖情况'                  # 两个独立任务 → 并行

cat gbq-results/*/*.json                    # 取结果
```
