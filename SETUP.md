# gbq 安装与配置

把一批任务分发给多个 Grok Bot 并行执行。**本地内存开销恒定**（不随 Bot 数量增长），因为任务全在云端跑，你的电脑上只有一个 Electron UI。

---

## 它解决什么问题

想并行跑 N 个任务时，通常要在本地开 N 个 agent 进程，内存线性增长。gbq 把任务推给云端的 Grok Bot：

| | 本地开 N 个 agent | gbq |
|---|---|---|
| 本地内存 | 150–335MB × N | **≈400MB 固定** |
| 执行位置 | 你的电脑 | 云端（8 核 / 15Gi） |

实测 2 Bot 并行加速比 **1.88x**。

---

## 前置条件

1. **Cursor Grok Bot 桌面应用**，已登录，至少有 1 个 Bot
2. **Tailscale**，你的电脑和 Grok Bot 的云端机器登录**同一个账号**
3. 本机有 `ssh` `node` `python3` `curl` `lsof`（macOS 自带除 node 外全部）

### 让 Grok Bot 的机器加入你的 Tailscale

在 Grok Bot 对话里让任意一个 Bot 装 Tailscale 并登录。它会给你一个授权链接，**用你自己的 Tailscale 账号点开授权**。

完成后本机执行 `tailscale status`，应该能看到一台 `linux` 节点。

---

## 安装

```bash
git clone <这个仓库> ~/grokbot_team
cd ~/grokbot_team
chmod +x bin/gbq

# 加进 PATH（可选）
echo 'export PATH="$HOME/grokbot_team/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

## 配置

```bash
gbq setup
```

向导会：检查依赖 → 确认 Grok Bot 在跑 → 自动探测 Tailscale 上的 Linux 节点 → 测试 SSH → 列出你的 Bot。

**首次跑大概率会卡在 SSH 这步**，因为云端机器默认没有 sshd。向导会打印一段命令，**把它贴给任意一个 Bot 执行**，然后重跑 `gbq setup`。

那段命令做四件事：装 openssh-server、写入你的公钥、关掉 Tailscale SSH（它会劫持 22 端口）、启动 sshd **只监听 Tailscale 地址**（不暴露公网）。

如果本机没有 SSH 密钥，先生成一把专用的：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/grokbot_ed25519 -N ''
```

> 建议用专用密钥而不是你的主力 `id_rsa` —— 那台机器是托管的，别把主力密钥的信任扩散过去。

---

## 用法

gbq 是一组**原语**，怎么分配、发什么由你（或你的 Agent）判断，工具不替你决策。

```bash
gbq bots                              # 列出可用 Bot

# 一问一答（最常用）
gbq ask  -b <bot> '问题'               # 发消息 + 等回复 + 打印
gbq send -b <bot> '消息'               # 只发不等
gbq read -b <bot> [-n N]              # 读某 Bot 最近对话

# 批量并行：一条龙
gbq run '任务A' '任务B' '任务C'

# 或者分步
gbq submit '任务A' '任务B'             # 轮流分配给各 Bot
gbq submit -f tasks.txt               # 从文件读，每行一个任务（# 开头为注释）
gbq submit -b my-bot '只给这个 Bot 的任务'
gbq dispatch                          # 唤醒有待办的 Bot
gbq status                            # 看队列
gbq wait --timeout 600                # 等完成
gbq collect -o ./results              # 取回结果
gbq clean                             # 清空队列
```

结果落到 `./gbq-results/<bot>/<任务id>.json`。

**什么时候用哪个**：一问一答用 `ask`；3 个以上互相独立的任务才值得走队列（队列的价值是投递成本按 Bot 数而非任务数，任务少时不划算）。

`ask` 的完成判定靠 UI 的 `<bot> is working` 状态，而不是「多久没新消息」—— 后者会把 Bot 搜索/思考时的静默期误判成结束。

### 让 Bot 看到你的项目代码

Bot 的云端机器上默认没有你的项目。注册并同步之后，Bot 就能直接读、grep 你的真实代码，而不用你在 prompt 里描述：

```bash
gbq ctx add ~/work/my-service          # 注册（名字默认取目录名）
gbq ctx add ~/work/other-repo api      # 或指定名字
gbq ctx list
gbq run --ctx my-service '分析 xxx 模块的调用链'
```

`--ctx` 会在派发前自动增量同步，并在唤醒提示词里告诉 Bot 代码在 `/workspace/ctx/<名字>/`。

实测速度（2.1MB / 250 文件）：首次全量 9.6s，增量 3.0s，无变化 1.7s。**增量比切换一个 Bot（4s）还快。**

排除规则 = 项目自己的 `.gitignore` + 内置兜底（`.git`、`node_modules`、`__pycache__`、`dist`、`build` 等）。两者都用，因为 `.gitignore` 通常不排除 `.git` 本身。

> 代码会被传到 Cursor 托管的机器上。那台机器的生命周期和快照策略不在你控制内 —— 敏感项目请自行评估。

### 体检

```bash
gbq doctor
```

逐项报告本地依赖、SSH、远端 rsync、以及三级控制通道各自是否可用。**出任何问题先跑这个**。

### 装成 Claude Code skill（可选）

```bash
ln -s "$PWD/.claude/skills/grokbot" ~/.claude/skills/grokbot
```

之后在任意 session 里说"派几个任务给 grokbot"，Claude 会自动加载用法，不用记命令。

---

## 工作原理

```
本地                          云端（一台机器，多个 Bot 共享）
 │
 ├─ submit  ──ssh──────────>  /workspace/gbq/<bot>/inbox/*.task
 │                             （一次 SSH 写完所有任务）
 │
 ├─ dispatch ─Electron CDP─>  给每个 Bot 发一条唤醒消息
 │                             （每 Bot 一次，不是每任务一次）
 │                                    │
 │                             Bot 们并行读各自 inbox、执行、写 outbox
 │                                    │
 └─ collect ──ssh──────────<  /workspace/gbq/<bot>/outbox/*.json
```

**关键：投递按 Bot 数计费，不按任务数。** 每个 Bot 切换会话约 4 秒，所以 100 个任务分给 4 个 Bot，投递总共 16 秒。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 投递串行 | 同一时刻只有一个 activeAgent，切换约 4 秒/Bot |
| 上限 4–8 个 Bot | 再多，投递开销和 8 核 CPU 争抢会吃掉收益 |
| Bot 共享一台机器 | 不是每 Bot 一台。共享 CPU / 内存 / 文件系统 |
| 依赖 UI 自动化 | 靠 Electron inspector 操作 Grok Bot 界面。升级后 DOM 选择器可能失效，已做三级降级兜底（见下） |
| sshd 不抗重启 | 云端容器重启后 sshd 会丢，需重跑那段安装命令 |
| 云端网络有屏蔽 | 实测 `theblock.co` / `cointelegraph.com` / Google News 返回 `ERR_BLOCKED_BY_RESPONSE`，CoinDesk 正常。调研类任务要让 Bot 说明数据来自哪个站，并留意它是否被挡 |

---

## 三级降级

控制 Grok Bot 没有官方 API，只能操作它的界面。为了扛住升级，做了三级兜底，自动切换：

| 级别 | 手段 | 何时生效 |
|---|---|---|
| L1 | CDP + 精确选择器 | 默认，最快 |
| L2 | CDP + 启发式（最宽的 contenteditable、按重复兄弟结构认列表） | Grok Bot 改了 class |
| L3 | computer use（截图 + 点击） | DOM 整个不可用 |

`gbq doctor` 会告诉你当前走哪一级。`GBQ_FORCE_LEVEL=2` 可强制某级（调试用）。

**L3 有硬前提：Grok Bot 窗口必须在当前 Space。** 窗口在别的桌面时点击会返回成功但静默无效 —— 这是实测过的坑，所以 L3 会先检测并明确报错，不会假装成功。

---

## 安全说明

- **Electron inspector**：投递期间会在 `127.0.0.1:9229` 开一个调试端口，本机任何进程都能借它完全控制 Grok Bot。gbq 每次用完**自动关闭**。
- **sshd 只监听 Tailscale 地址**，公网扫不到；仅公钥认证，密码登录已关。
- **别在云端机器上放长期凭证** —— 它的生命周期和快照策略不在你控制内。
- `/workspace` 里的内容所有 Bot 都能看见。

---

## 排错

**`gbq bots` 说连不上**
Grok Bot 应用没开，或者窗口被关了（最小化没关系）。

**`gbq setup` 卡在 SSH**
按向导提示把那段命令贴给 Bot 执行。若之前配过、现在突然不通，多半是**云端容器重启**导致 sshd 没了 —— 重跑那段命令即可。

```bash
nc -z <你的tailnet-ip> 22 && echo "sshd 在" || echo "sshd 没了"
```

**Bot 唤醒了但不干活**
看一眼 Grok Bot 界面里那个 Bot 的对话，可能它在问问题或撞上了权限确认卡。

**延迟很高**
Tailscale 走 DERP 中继时 RTT 约 245ms。`~/.ssh/config` 里给这台主机加连接复用能省掉大部分握手：

```
Host <你的别名>
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
```

实测冷启动 2.38s → 复用 0.47s。
