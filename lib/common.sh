#!/bin/bash
# gbq 公共库：配置加载、环境探测、Bot 层控制
# 被 bin/gbq source，不单独执行。

if [ -z "${GBQ_ROOT:-}" ]; then
  GBQ_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
fi
GBQ_CONFIG_DIR="${GBQ_CONFIG_DIR:-$HOME/.config/gbq}"
GBQ_CONFIG="$GBQ_CONFIG_DIR/config"

# ---------- 输出 ----------
_c_red=$'\033[31m'; _c_grn=$'\033[32m'; _c_ylw=$'\033[33m'
_c_dim=$'\033[2m';  _c_bld=$'\033[1m'; _c_off=$'\033[0m'
die()  { echo "${_c_red}错误:${_c_off} $*" >&2; exit 1; }
warn() { echo "${_c_ylw}警告:${_c_off} $*" >&2; }
ok()   { echo "${_c_grn}✓${_c_off} $*"; }
info() { echo "${_c_dim}$*${_c_off}"; }

# ---------- 配置 ----------
load_config() {
  [ -f "$GBQ_CONFIG" ] || die "尚未配置。先运行: gbq setup"
  # shellcheck disable=SC1090
  . "$GBQ_CONFIG"
  : "${GBQ_SSH_HOST:?config 缺少 GBQ_SSH_HOST}"
  : "${GBQ_REMOTE_ROOT:=/workspace/gbq}"
  : "${GBQ_APP_PROC:=MacOS/Grok Bot}"
  : "${GBQ_INSPECT_PORT:=9229}"
}

save_config() {
  mkdir -p "$GBQ_CONFIG_DIR"; chmod 700 "$GBQ_CONFIG_DIR"
  cat > "$GBQ_CONFIG" <<EOF
# gbq 配置 — 由 'gbq setup' 生成，可手工编辑
GBQ_SSH_HOST="$GBQ_SSH_HOST"
GBQ_REMOTE_ROOT="${GBQ_REMOTE_ROOT:-/workspace/gbq}"
GBQ_APP_PROC="${GBQ_APP_PROC:-MacOS/Grok Bot}"
GBQ_INSPECT_PORT="${GBQ_INSPECT_PORT:-9229}"
EOF
  chmod 600 "$GBQ_CONFIG"
}

# ---------- SSH ----------
gssh() { ssh -o BatchMode=yes -o ConnectTimeout="${GBQ_SSH_TIMEOUT:-25}" "$GBQ_SSH_HOST" "$@"; }

check_ssh() {
  gssh 'echo ok' >/dev/null 2>&1
}

# ---------- Bot 层（Electron inspector）----------
_app_pid() { pgrep -f "$GBQ_APP_PROC" 2>/dev/null | head -1; }

# 确保 inspector 开启，回显 ws url
_inspector_ws() {
  local pid; pid=$(_app_pid)
  [ -z "$pid" ] && { echo "GROKBOT_NOT_RUNNING"; return 1; }
  if ! lsof -a -p "$pid" -iTCP:"$GBQ_INSPECT_PORT" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    kill -USR1 "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      lsof -a -p "$pid" -iTCP:"$GBQ_INSPECT_PORT" -sTCP:LISTEN -P -n >/dev/null 2>&1 && break
      sleep 0.4
    done
  fi
  curl -s --max-time 5 "http://127.0.0.1:$GBQ_INSPECT_PORT/json/list" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['webSocketDebuggerUrl'])" 2>/dev/null \
    || { echo "INSPECTOR_UNAVAILABLE"; return 1; }
}

# 关闭 inspector（投递完就该关，减少本机敞口）
inspector_close() {
  local ws
  ws=$(curl -s --max-time 3 "http://127.0.0.1:$GBQ_INSPECT_PORT/json/list" 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['webSocketDebuggerUrl'])" 2>/dev/null) || true
  # close() 会立刻切断 CDP 连接，cdp.js 必定超时非零退出 —— 这是预期行为，吞掉
  [ -n "$ws" ] && node "$GBQ_ROOT/lib/cdp.js" "$ws" 'require("inspector").close(), "CLOSED"' >/dev/null 2>&1 || true
  return 0
}

# 在渲染进程执行 JS。$1 = JS 源码（会被放进模板字符串，注意别用反引号）
render_js() {
  local ws; ws=$(_inspector_ws) || { echo "$ws"; return 1; }
  node "$GBQ_ROOT/lib/cdp.js" "$ws" "
(async () => {
  const { BrowserWindow } = require('electron');
  const ws = BrowserWindow.getAllWindows();
  if (!ws.length) return 'NO_WINDOW';
  return await ws[0].webContents.executeJavaScript(\`$1\`);
})()
"
}

# 列出 Bot 名（每行一个）
# ---------- 三级降级实现 ----------
# shellcheck disable=SC1091
. "$GBQ_ROOT/lib/botctl.sh"

# 对外接口保持不变，内部自动 L1 → L2 → L3 降级。
# 实际用到的级别记在 GBQ_USED_LEVEL。
bot_list()   { _try_levels list; }
bot_switch() { _try_levels switch "$1"; }
bot_send()   { _try_levels send "$1"; }

# 切换 + 发送。$1 = Bot 名, $2 = 文本
bot_dispatch() {
  local res
  res=$(bot_switch "$1") || true
  case "$res" in
    *SWITCHED*)      ;;
    *BOT_NOT_FOUND*) echo "BOT_NOT_FOUND"; return 1 ;;
    *)               echo "SWITCH_FAILED:$res"; return 1 ;;
  esac
  sleep "${GBQ_SWITCH_WAIT:-2}"
  bot_send "$2"
}

# Bot 名 → 目录 slug（小写、空格转 -、去掉非法字符）
slugify() {
  # -E 让 BSD sed(macOS) 和 GNU sed 都认 '+'；不加 -E 时 BSD sed 不支持 \+，
  # 空格不会被替换，会产出带空格的目录名。
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

# ---------- 项目上下文（多项目）----------
GBQ_CTX_FILE="$GBQ_CONFIG_DIR/contexts"     # 每行: name<TAB>本地绝对路径
GBQ_CTX_REMOTE="${GBQ_CTX_REMOTE:-/workspace/ctx}"

ctx_list_raw() { [ -f "$GBQ_CTX_FILE" ] && cat "$GBQ_CTX_FILE" || true; }

ctx_path_of() {
  ctx_list_raw | awk -F'\t' -v n="$1" '$1==n{print $2; exit}'
}

ctx_add() {
  local path name
  path=$(cd "$1" 2>/dev/null && pwd) || { echo "路径不存在: $1"; return 1; }
  name="${2:-$(basename "$path")}"
  mkdir -p "$GBQ_CONFIG_DIR"; touch "$GBQ_CTX_FILE"
  # 同名覆盖
  local tmp; tmp=$(mktemp)
  awk -F'\t' -v n="$name" '$1!=n' "$GBQ_CTX_FILE" > "$tmp" 2>/dev/null || true
  printf '%s\t%s\n' "$name" "$path" >> "$tmp"
  mv "$tmp" "$GBQ_CTX_FILE"; chmod 600 "$GBQ_CTX_FILE"
  echo "$name"
}

ctx_rm() {
  [ -f "$GBQ_CTX_FILE" ] || return 0
  local tmp; tmp=$(mktemp)
  awk -F'\t' -v n="$1" '$1!=n' "$GBQ_CTX_FILE" > "$tmp"
  mv "$tmp" "$GBQ_CTX_FILE"; chmod 600 "$GBQ_CTX_FILE"
}

# 生成 rsync 排除清单：项目自己的 .gitignore + 内置兜底
# （.gitignore 通常不排除 .git 本身，所以两者都要）
_ctx_exclude_file() {
  local src="$1" f; f=$(mktemp)
  cat > "$f" <<'EOF'
.git/
node_modules/
__pycache__/
.venv/
venv/
dist/
build/
target/
.next/
.DS_Store
*.pyc
*.log
EOF
  [ -f "$src/.gitignore" ] && grep -vE '^\s*($|#)' "$src/.gitignore" >> "$f" 2>/dev/null || true
  echo "$f"
}

# 同步一个上下文到云端。$1 = name
ctx_sync() {
  local name="$1" src exc
  src=$(ctx_path_of "$name")
  [ -z "$src" ] && { echo "未注册的上下文: $name"; return 1; }
  [ -d "$src" ] || { echo "本地目录已不存在: $src"; return 1; }
  gssh "command -v rsync >/dev/null 2>&1" || { echo "远端缺 rsync，跑 gbq doctor 看提示"; return 1; }
  exc=$(_ctx_exclude_file "$src")
  gssh "mkdir -p '$GBQ_CTX_REMOTE/$name'" >/dev/null
  rsync -az --delete --exclude-from="$exc" \
        -e "ssh -o BatchMode=yes -o ConnectTimeout=${GBQ_SSH_TIMEOUT:-25}" \
        "$src/" "$GBQ_SSH_HOST:$GBQ_CTX_REMOTE/$name/" 2>&1 | tail -3
  local rc=${PIPESTATUS[0]}
  rm -f "$exc"
  return "$rc"
}
