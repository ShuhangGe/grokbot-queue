# gbq — 把活派给云端的 Grok Bot

让 Cursor Grok Bot 替你干活，**本地内存开销恒定 ≈400MB，不随任务数或 Bot 数增长** —— 执行全在云端。

```bash
gbq ask -b walle '查一下最近一周 crypto 圈有什么大新闻，注明来源和日期'
```

Bot 会真的开浏览器去查，回来给你带 URL 和日期的结果。

---

## 能干什么

| 想做的事 | 命令 |
|---|---|
| 问一句、要个调研 | `gbq ask -b <bot> '问题'` |
| 让它读你的项目代码干活 | `gbq ctx add ~/my-project` → `gbq run --ctx my-project '任务'` |
| 一批独立任务并行跑 | `gbq run '任务A' '任务B' '任务C'` |
| 看某个 Bot 最近在忙什么 | `gbq read -b <bot>` |

实测：2 个 Bot 并行加速比 **1.88x**；4 个任务 26 秒跑完。

**为什么不直接在本地多开几个 agent** —— 本地每个 agent 实例吃 150–335MB 且线性增长；gbq 固定 400MB，从第 3 个任务起就开始净赚。

---

## 5 分钟上手

**前置**：Grok Bot 桌面应用在跑、Tailscale 两端登录同一账号、本机有 `ssh node python3 curl lsof`。

```bash
git clone https://github.com/ShuhangGe/grokbot-queue ~/gbq
cd ~/gbq && chmod +x bin/gbq
export PATH="$HOME/gbq/bin:$PATH"      # 建议写进 ~/.zshrc

gbq setup      # 引导式，会自动探测 Tailscale 上的 Linux 节点
gbq doctor     # 体检 —— 以后出任何问题都先跑这个
gbq bots       # 看有哪些 Bot
gbq ask -b <bot名> '报一下你所在机器的内核版本'
```

⚠️ **`gbq setup` 第一次大概率卡在 SSH** —— 云端机器默认没装 sshd，这是正常的。向导会打印一段命令，**贴给任意一个 Bot 执行**，然后重跑 setup。完整说明见 [SETUP.md](SETUP.md)。

---

## 命令速查

```bash
gbq bots                          # 列出 Bot
gbq ask  -b <bot> '问题'           # 发消息 + 等回复 + 打印（最常用）
gbq send -b <bot> '消息'           # 只发不等
gbq read -b <bot> [-n N] [-A]     # 读最近对话（-A 只看 Bot 回复）

gbq ctx add <本地目录> [名字]       # 注册项目上下文
gbq ctx list | sync | rm
gbq run --ctx <名字> '任务'...      # 同步代码 + 派任务 + 等待 + 取回

gbq submit [-b <bot>] '任务'...    # 只写队列不唤醒
gbq dispatch                      # 唤醒有待办的 Bot
gbq status | wait | collect | clean

gbq doctor                        # 体检
```

退出码：成功 `0`，失败非 `0`。

---

## 给 AI Agent 用

让 Claude / Cursor / 其他 agent 驱动 gbq 的话，**读 [AGENTS.md](AGENTS.md)** —— 那里有原语的精确语义、该在什么情况下用哪个、以及失败模式速查。

Claude Code 用户可以直接装成 skill：

```bash
ln -s "$PWD/.claude/skills/grokbot" ~/.claude/skills/grokbot
```

之后说一句「派几个任务给 grokbot」就行，不用记命令。

---

## 原理

```
本地                          云端（一台机器，多个 Bot 共享）
 │
 ├─ submit  ──SSH─────────>  /workspace/gbq/<bot>/inbox/*.task
 │                            任务内容一次 SSH 批量写入
 │
 ├─ dispatch ─Electron CDP─> 每个 Bot 一条唤醒消息
 │                                   │
 │                            Bot 们并行读 inbox、执行、写 outbox
 │                                   │
 └─ collect ──SSH─────────<  /workspace/gbq/<bot>/outbox/*.json
```

**投递成本按 Bot 数算，不按任务数。** 100 个任务分给 4 个 Bot，投递也只要约 16 秒。

Cursor 没有公开 Grok Bot API，控制靠操作它的 Electron 界面。为了扛住版本升级做了三级自动降级（L1 精确选择器 → L2 启发式 → L3 computer use），`gbq doctor` 会告诉你当前走哪级。细节见 [INTERNALS.md](INTERNALS.md)。

---

## 限制

| 限制 | 说明 |
|---|---|
| 投递串行 | 同一时刻只有一个 activeAgent，切换约 4 秒/Bot |
| 上限 4–8 个 Bot | 再多，投递开销和 8 核 CPU 争抢会吃掉收益 |
| 多 Bot 共享一台机器 | 不是每 Bot 一台，共享 CPU / 内存 / `/workspace` |
| Bot 有持久记忆 | 不像一次性 worker，跨任务会累积 —— 适合当「驻场同事」 |
| sshd 不抗容器重启 | 重启后要重新拉起，见 SETUP.md |
| 依赖 UI 自动化 | Grok Bot 升级可能打断 L1，有 L2/L3 兜底 |
| 云端网络有屏蔽 | 实测 `theblock.co`、`cointelegraph.com`、Google News 被挡，CoinDesk 可用 |

---

## 安全

- **`--ctx` 会把项目代码传到 Cursor 托管的机器上**，敏感项目请自行评估
- 云端机器的生命周期和快照策略不由你控制，**别在上面放长期凭证**
- `/workspace` 内容所有 Bot 都能看见
- Electron inspector 开启期间 `127.0.0.1:9229` 对本机任何进程开放，gbq **每次用完自动关闭**
- sshd 只监听 Tailscale 地址，公网扫不到；仅公钥认证，密码登录已关

---

## 文档

| 文件 | 给谁看 |
|---|---|
| [SETUP.md](SETUP.md) | 安装、配置、排障 |
| [AGENTS.md](AGENTS.md) | AI agent —— 原语语义、判断指引、失败模式 |
| [INTERNALS.md](INTERNALS.md) | 维护者 —— 实现细节、实测数据、踩过的坑 |
| `.claude/skills/grokbot/` | Claude Code skill |
