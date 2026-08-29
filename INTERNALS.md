# 实现细节与踩过的坑

给维护者看。使用方法见 [README.md](README.md)，agent 用法见 [AGENTS.md](AGENTS.md)。

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

**上下文同步**（2.1MB / 250 文件）：首次 9.6s，增量 3.0s，无变化 1.7s —— 增量比切一个 Bot（4s）还快。

**上下文有效性验证**：给 Bot 派了两个「只有读了代码才答得出」的问题（问代码注释里的内容），两个 Bot 都答对：

```
Q: lib/botctl.sh 实现了几级降级？
A: L1 CDP+精确选择器；L2 CDP+启发式；L3 computer use   ✓

Q: slugify 为什么必须加某个参数？
A: -E。不加时 BSD sed(macOS) 不支持 \+，空格不会被替换   ✓
```

---

## 设计取向：原语，不是框架

gbq 只提供原语，**不内置角色/profile 配置**。怎么分配任务、哪个 Bot 干什么，交给调用方（通常是本地 Agent）判断 —— 它本来就有判断力，用配置文件固化反而限制灵活性。

```bash
gbq ask  -b <bot> '问题'      # 一问一答
gbq send -b <bot> '消息'
gbq read -b <bot> [-n N]     # 读对话，可用来判断该派给谁
gbq submit -b <bot> '任务'    # 进队列
```

`gbq read` 让 Agent 能先看某个 Bot 最近在干什么，再决定派给谁 —— **动态判断，而不是静态配置**。这也顺着 Grok Bot 有持久记忆的特性：让 Bot 自然形成专长，比预先分配角色更合适。

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

### 三级降级（抗 Grok Bot 升级）

控制 Bot 没有官方 API，只能操作界面，所以做了自动降级：

| 级别 | 手段 | 何时生效 |
|---|---|---|
| L1 | CDP + 精确选择器 | 默认，最快 |
| L2 | CDP + 启发式：最宽的 contenteditable 当输入框；按「同父节点重复兄弟结构」认 Bot 列表 | Grok Bot 改了 class |
| L3 | computer use（cua-driver 截图+点击） | DOM 整个不可用 |

L2 不依赖任何 `sand-*` class，实测输出与 L1 完全一致。
L3 **要求窗口在当前 Space** —— off-Space 时点击会返回成功但静默无效（实测过），所以会先检测并明确报 `L3_WINDOW_OFF_SPACE`。

`gbq doctor` 逐项报告哪级可用；`GBQ_FORCE_LEVEL=n` 强制指定。

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
| BSD sed 不支持 `\+` `\?` | slug 里空格没被替换产出带空格目录名；`--help` 的 `#` 前缀没被剥掉。**这个坑踩了两次** | 一律用 `sed -E` |
| `$var` 紧跟中文 | bash 把 UTF-8 字节当变量名 → unbound variable | 写成 `${var}` |
| `set -e` + inspector.close() | 关闭连接必然非零退出，带崩脚本 | `|| true` |
| `while read` 的退出码 | 读到 EOF 时 `read` 返回 1，成了整条命令的退出码，`gbq ctx list` 误报失败 | 循环后加 `\|\| true` |
| `ask` 把静默期当结束 | 用「N 秒没新消息=答完」，Bot 做浏览器搜索时的静默被误判，拿到「正在搜索」而非结果 | 改用 UI 的 `<bot> is working` 状态判定 |
| `read` 过滤过头 | Grok Bot 把 agent-loop 系统提示追加在消息**尾部**，和真正产出同属一条消息；按整条过滤会把结果一起丢掉 | 从标记处**截断**，不整条丢弃 |
| zsh 不做词分割 | 测试脚本里 `./bin/gbq $c`（c="ctx list"）在 zsh 下传的是单个参数，误判成退出码 bug | 测试时用 `"$@"` 传参 |

---

## 三级降级的实现要点

**L2 不能靠位置猜。** 第一版按「侧边栏区域 + 尺寸」筛选可点击元素，结果 Search / Plugins / 账号入口全混进来，切换会选错 Bot。改用两个结构特征才干净：

1. **同一父节点下的重复兄弟结构** —— 这是「列表」的本质，孤立的功能入口自动被排除
2. **aria-label 语义** —— 功能按钮的 aria 是动词短语（`Open account menu`、`Add reaction`），Bot 项的 aria 是名字本身

单 Bot 时没有重复结构，退回「带头像元素的可点击项」。

**L3 必须先检测 Space。** 窗口不在当前 Space 时，`cua-driver click` 会返回 `✅ Posted` 但**完全无效**，`type_text` 的字符也被丢弃 —— 返回值是假阳性。所以 `_l3_available` 先查 `on_current_space`，不满足就报 `L3_WINDOW_OFF_SPACE`，不进入执行。

## Bot 侧的关键路径

```
~/sand-data/agents/<uuid>/            每个 Bot 的数据
  ├── profile.json                    含 name
  ├── memory/                         持久记忆
  ├── automations/                    routines
  └── conversation-blobs.db
~/sand-data/agents/active-agent.json  当前活跃 Bot（投递串行的根因）
~/sand-data/agent-transcripts/<uuid>/<uuid>.jsonl   对话记录，gbq read 读这个
~/.sand-window-assignments.json       Bot → X display 映射（按需分配）
```

transcript 的 jsonl 结构：`{"role": "...", "message": {"content": [{"type":"text","text":"..."}]}}`
