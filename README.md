# gbq — Grok Bot 任务队列

把一批任务分发给多个 Cursor Grok Bot 并行执行。**本地内存开销恒定**，不随 Bot 数量增长。

```bash
gbq run '任务A' '任务B' '任务C' '任务D'
```

→ 任务轮流分给各 Bot，它们在云端并行跑，结果落到 `./gbq-results/<bot>/*.json`。

**安装配置看 [SETUP.md](SETUP.md)。**

---

## 为什么有用

并行跑 N 个任务，通常要在本地开 N 个 agent，内存线性增长。gbq 把执行推到云端：

| | 本地开 N 个 agent | gbq |
|---|---|---|
| 本地内存 | 150–335MB × N | **≈400MB 固定** |
| 执行位置 | 你的电脑 | 云端 8 核 / 15Gi |
| 交叉点 | — | N=2 打平，N≥3 净赚 |

本地之所以是常数：Bot 在云端各有独立 `exec-daemon` 进程，你机器上那个 Electron 只是 UI 壳 —— 多一个 Bot 只是侧边栏多一行。

---

## 实测数据（2026-08-29）

**并行验证** —— 两个 Bot 各跑 30 秒任务，时间戳重叠即真并行：

```
bot-a    04:24:03 → 04:24:33  (30s)
bot-b    04:24:01 → 04:24:31  (30s)
重叠 28s ｜ 墙钟 32s ｜ 串行需 60s ｜ 加速比 1.88x
```

**端到端** —— 4 个任务分给 2 个 Bot：

```
submit    4 个任务一次 SSH 写入
dispatch  23s（2 个 Bot 各一条唤醒消息）
执行      26s 全部完成，完成顺序交错（bot-b→bot-a→bot-a→bot-b）
collect   4/4 成功
```

**SSH 并发**：3 连接 2.65s（串行需 6s+）。
**连接复用**：冷启动 2.38s → 复用 0.47s。

---

## 架构

```
本地                          云端（一台机器，多个 Bot 共享）
 │
 ├─ submit  ──ssh──────────>  /workspace/gbq/<bot>/inbox/*.task
 │                             一次 SSH 写完所有任务
 │
 ├─ dispatch ─Electron CDP─>  每个 Bot 一条唤醒消息
 │                                    │
 │                             Bot 们并行读 inbox、执行、写 outbox
 │                                    │
 └─ collect ──ssh──────────<  /workspace/gbq/<bot>/outbox/*.json
```

**投递按 Bot 数计费，不按任务数。** 100 个任务分给 4 个 Bot，投递总共约 16 秒。

### 两条控制通道

| 通道 | 控制什么 | 怎么实现 |
|---|---|---|
| **SSH** | 机器（文件、命令） | sshd 只监听 tailnet 地址，公钥认证 |
| **Electron CDP** | Bot 的 AI（发消息、切换会话） | `kill -USR1` 开 inspector → `webContents.executeJavaScript` |

SSH 进去干活时 Bot 并不知情 —— 它控制的是机器，不是 Bot。要让 Bot 的 AI 干活必须走 CDP 通道。

### 多 Bot 是共享一台机器

tailnet 上只有一个节点、一个 `box` 用户、一个 SSH 端点。隔离发生在机器内部：

- **数据**：`~/sand-data/agents/<uuid>/`，各有 `profile.json` / `memory` / `automations` / `conversation-blobs.db`
- **屏幕**：按需分配 X display（`~/.sand-window-assignments.json`），每个是完整 XFCE 桌面
- **活跃态**：`active-agent.json` —— **同一时刻只有一个 activeAgentId**，这是投递必须串行的根因

---

## 踩过的坑

| 坑 | 表现 | 处理 |
|---|---|---|
| Grok Bot 无官方 API | Cursor 9 个 API 面均不含它 | 只能走 CDP + SSH |
| 自定义 MCP 拒绝 localhost | 官方明确不接受本机 MCP server | SSH 通道让这条路没必要 |
| Tailscale SSH 劫持 22 端口 | `RunSSH=true` 时不转发给 sshd | 必须 `tailscale set --ssh=false` |
| Tailscale SSH 的 ACL check | 要求浏览器 OAuth | 改用 sshd + 公钥，零交互 |
| off-Space 窗口 | `click` 返回 `✅ Posted` 但静默无效 | 别信返回值，查 DOM 验证 |
| 截图帧过期 | 输入框显示 placeholder 但文字已写入 | 以 DOM 查询为准 |
| ProseMirror 受控编辑器 | 改 `innerText` 不同步内部 state | 必须 `execCommand('insertText')` |
| React 渲染竞态 | 插入文本后立刻找发送按钮 → 找不到 | 轮询等按钮出现 |
|  BSD sed 不支持 `\+` `\?` | slug 里空格没被替换，产出带空格目录名 | `sed -E` |
| `$var` 紧跟中文 | bash 把 UTF-8 字节当变量名 → unbound variable | 写成 `${var}` |
| `set -e` + inspector.close() | 关闭连接必然非零退出，带崩脚本 | `|| true` |

---

## 已知限制

1. **投递串行** —— `activeAgentId` 唯一，切换约 4 秒/Bot
2. **上限 4–8 个 Bot** —— 再多，投递开销和 8 核 CPU 争抢吃掉收益
3. **依赖 UI 自动化** —— Grok Bot 升级后 DOM 选择器（`.sand-prompt-field`、`button.sand-agent-item`、`aria-label="Send message"`）可能失效
4. **sshd 不抗容器重启** —— 手动 `nohup` 拉起的，不是 systemd 服务
5. **文件系统不隔离** —— 所有 Bot 都能读写 `/workspace`，gbq 按 Bot 分子目录规避

---

## 文件

```
bin/gbq              主 CLI
lib/common.sh        配置、SSH、Bot 层控制（CDP）
lib/cdp.js           极简 CDP 客户端
tasks.example.txt    批量任务示例
SETUP.md             安装配置（给新用户）
```
