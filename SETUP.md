# 安装与排障

使用方法见 [README.md](README.md)；给 AI agent 的说明见 [AGENTS.md](AGENTS.md)。

---

## 前置条件

1. **Cursor Grok Bot 桌面应用**，已登录，至少有 1 个 Bot
2. **Tailscale**，你的电脑和 Grok Bot 的云端机器登录**同一个账号**
3. 本机有 `ssh` `node` `python3` `curl` `lsof`（macOS 除 node 外都自带）
4. 可选：`cua-driver`（只有降级到 L3 时才需要）

### 让 Grok Bot 的机器加入你的 Tailscale

在 Grok Bot 对话里让任意一个 Bot 装 Tailscale 并登录。它会给你一个授权链接，**用你自己的 Tailscale 账号点开授权**。

完成后本机 `tailscale status` 应该能看到一台 `linux` 节点。

---

## 安装

```bash
git clone https://github.com/ShuhangGe/grokbot-queue ~/gbq
cd ~/gbq && chmod +x bin/gbq
echo 'export PATH="$HOME/gbq/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
gbq setup
```

向导会：检查依赖 → 确认 Grok Bot 在跑 → 自动探测 Tailscale 上的 Linux 节点 → 测 SSH → 列出 Bot → 写配置到 `~/.config/gbq/config`。

### 第一次一定会卡在 SSH —— 这是正常的

云端机器默认**没装 sshd**。向导会打印一段命令，把它贴给任意一个 Bot 执行，然后重跑 `gbq setup`。

那段命令做四件事：

1. 装 `openssh-server`
2. 写入你的公钥到 `~/.ssh/authorized_keys`
3. **关掉 Tailscale SSH** —— `RunSSH=true` 时 tailscaled 会劫持 22 端口不转发给 sshd，这一步不能省
4. 启动 sshd，**只监听 Tailscale 地址**（不暴露公网），且禁用密码登录

本机没有 SSH 密钥的话先生成一把专用的：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/grokbot_ed25519 -N ''
```

> 用专用密钥而不是主力 `id_rsa` —— 那台机器是第三方托管的，别把主力密钥的信任扩散过去。

### 建议加连接复用

Tailscale 走 DERP 中继时 RTT 约 245ms，每条命令都握手很亏。在 `~/.ssh/config` 里：

```
Host <你的别名>
    HostName <tailnet-ip>
    User box
    IdentityFile ~/.ssh/grokbot_ed25519
    IdentitiesOnly yes
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
```

实测冷启动 2.38s → 复用 0.47s。

---

## 项目上下文

Bot 的云端机器上没有你的项目。注册并同步之后，Bot 就能直接读、grep 你的真实代码：

```bash
gbq ctx add ~/work/my-service          # 名字默认取目录名
gbq ctx add ~/work/other-repo api      # 也可以指定
gbq ctx list
gbq run --ctx my-service '分析 xxx 模块的调用链'
```

`--ctx` 在派发前自动增量同步，并在唤醒提示词里告诉 Bot 代码在 `/workspace/ctx/<名字>/`。

实测（2.1MB / 250 文件）：首次 9.6s，增量 **3.0s**，无变化 1.7s。增量比切换一个 Bot（4s）还快。

排除规则 = 项目自己的 `.gitignore` + 内置兜底（`.git`、`node_modules`、`__pycache__`、`dist`、`build`、`.venv` 等）。两者都用，因为 `.gitignore` 通常不排除 `.git` 本身。

> ⚠️ 代码会被传到 Cursor 托管的机器上，生命周期和快照策略都不在你控制内。敏感项目请自行评估。

---

## 装成 Claude Code skill

```bash
ln -s "$PWD/.claude/skills/grokbot" ~/.claude/skills/grokbot
```

之后在任意 session 里说「派几个任务给 grokbot」，Claude 会自动加载用法。

---

## 排障

**先跑 `gbq doctor`。** 它逐项检查本地依赖、配置、SSH、远端 rsync、以及三级通道各自是否可用，最后给出「当前将走 L$n 通道」的结论。

### SSH 连不上

**先看节点在不在线** —— 这个症状最有迷惑性：

```bash
tailscale status | grep linux
```

节点不在线时，`nc -z <ip> 22` 仍会显示**端口通**（DERP 中继接受了 TCP），但 SSH 会报：

```
kex_exchange_identification: Connection closed by remote host
```

密钥交换都没开始就断了 —— 这不是认证失败，也不是 sshd 的问题，**是云端机器整个下线了**。

实测观察到：**关闭 Grok Bot 桌面应用后，tailnet 上的云端节点也随之离线。** 想让 Bot 干活（或走 SSH），把桌面应用开着。

节点在线但仍连不上，才往下看 ↓

**第二常见的原因是云端容器重启，sshd 丢了** —— 它是手动 `nohup` 拉起的，不是 systemd 服务。先确认：

```bash
nc -z <你的tailnet-ip> 22 && echo "sshd 在" || echo "sshd 没了"
```

没了就把下面这段贴给任意一个 Bot（把公钥换成你自己的）：

```
执行下面命令并把输出贴回：sudo mkdir -p /run/sshd; TSIP=$(tailscale ip -4 | head -1); sudo tailscale set --ssh=false 2>/dev/null; sudo sh -c "nohup /usr/sbin/sshd -D -o ListenAddress=$TSIP -o PasswordAuthentication=no > /tmp/sshd.log 2>&1 &"; sleep 3; ss -tlnp | grep :22
```

如果连 `openssh-server` 都没了（容器被重建过），在前面加上安装步骤。**注意 apt 偶尔会撞上 502 Bad Gateway，先 `sudo apt-get update -qq` 再装通常就好。**

### `gbq bots` 报错或为空

Grok Bot 桌面应用没开。**最小化没关系，关掉才不行。**

### doctor 说 L1 选择器失效

Grok Bot 升级改了 DOM class。L2 启发式会自动接管，功能不受影响。只有 L2 也报错时才需要更新 `lib/botctl.sh` 里的选择器。

### doctor 说 `L3_WINDOW_OFF_SPACE`

Grok Bot 窗口在别的桌面（Space）。**这只影响 L3**，L1/L2 正常的话不用管。

真要用 L3 得把窗口挪到当前桌面 —— 窗口在别的 Space 时，点击会返回成功但**静默无效**，键盘输入也会被丢弃。

### `gbq ask` 超时

Bot 干得久（浏览器搜索经常要 1–2 分钟），或者卡在权限确认卡。看它在说什么：

```bash
gbq read -b <bot> -n 20
```

`ask` 的完成判定靠 UI 的 `<bot> is working` 状态，不是「多久没新消息」—— 后者会把搜索时的静默期误判成结束。

### 任务跑完了但 outbox 没结果文件

Bot 没遵守协议。补一句：

```bash
gbq send -b <bot> '把刚才的结果写到 outbox 对应的 json 文件里'
```

### Bot 用训练数据回答时效性问题

任务描述里没强调。重发时明确要求「用浏览器实时查证，注明来源和日期，不要用训练数据」。

### 远端缺 rsync

`gbq doctor` 会报。装一下：

```bash
ssh <你的别名> 'sudo apt-get update -qq && sudo apt-get install -y -qq rsync'
```

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 投递串行 | 同一时刻只有一个 activeAgent，切换约 4 秒/Bot |
| 上限 4–8 个 Bot | 再多，投递开销和 8 核 CPU 争抢会吃掉收益 |
| Bot 共享一台机器 | 不是每 Bot 一台，共享 CPU / 内存 / `/workspace` |
| Bot 有持久记忆 | 跨任务累积，适合当「驻场同事」而非一次性 worker |
| sshd 不抗重启 | 见上面排障 |
| 依赖 UI 自动化 | Grok Bot 升级可能打断 L1，有 L2/L3 兜底 |
| 云端网络有屏蔽 | 实测 `theblock.co`、`cointelegraph.com`、Google News 返回 `ERR_BLOCKED_BY_RESPONSE`，CoinDesk 正常 |

---

## 三级降级

控制 Grok Bot 没有官方 API，只能操作它的 Electron 界面。为了扛住升级做了三级兜底，自动切换：

| 级别 | 手段 | 何时生效 |
|---|---|---|
| L1 | CDP + 精确选择器 | 默认，最快 |
| L2 | CDP + 启发式（最宽的 contenteditable 当输入框；按「同父节点重复兄弟结构」认 Bot 列表） | Grok Bot 改了 class |
| L3 | computer use（截图 + 点击） | DOM 整个不可用 |

`GBQ_FORCE_LEVEL=2` 可强制某一级（调试用）。实现细节见 [INTERNALS.md](INTERNALS.md)。

---

## 安全

- **Electron inspector**：投递期间会在 `127.0.0.1:9229` 开调试端口，本机任何进程都能借它完全控制 Grok Bot。gbq **每次用完自动关闭**
- **sshd 只监听 Tailscale 地址**，公网扫不到；仅公钥认证
- **别在云端机器上放长期凭证** —— 生命周期不由你控制
- `/workspace` 内容所有 Bot 都能看见
