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
bot_list() {
  render_js "
    (() => {
      const items = [...document.querySelectorAll('button.sand-agent-item')];
      return items.map(el => ((el.querySelector('[class*=agent-item__name]')||{}).innerText||'').trim())
                  .filter(Boolean).join('\\\\n');
    })()
  "
}

# 切换到指定 Bot。$1 = Bot 名
bot_switch() {
  local b64; b64=$(printf '%s' "$1" | base64)
  render_js "
    (() => {
      const want = new TextDecoder().decode(Uint8Array.from(atob('$b64'), c => c.charCodeAt(0)));
      const items = [...document.querySelectorAll('button.sand-agent-item')];
      const t = items.find(el => ((el.querySelector('[class*=agent-item__name]')||{}).innerText||'').trim() === want);
      if (!t) return 'BOT_NOT_FOUND';
      t.click(); return 'SWITCHED';
    })()
  "
}

# 向当前 Bot 发消息。$1 = 文本
bot_send() {
  local b64; b64=$(printf '%s' "$1" | base64)
  render_js "
    (() => {
      const txt = new TextDecoder().decode(Uint8Array.from(atob('$b64'), c => c.charCodeAt(0)));
      const el = document.querySelector('.sand-prompt-field');
      if (!el) return 'NO_INPUT_FIELD';
      el.focus();
      const r = document.createRange(); r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.execCommand('insertText', false, txt);
      return (async () => {
        for (let i = 0; i < 50; i++) {
          const send = [...document.querySelectorAll('button')]
            .find(b => (b.getAttribute('aria-label')||'') === 'Send message');
          if (send && !send.disabled) { send.click(); return 'SENT'; }
          await new Promise(r => setTimeout(r, 100));
        }
        return 'SEND_BUTTON_TIMEOUT';
      })();
    })()
  "
}

# 切换 + 发送。$1 = Bot 名, $2 = 文本
bot_dispatch() {
  local res
  res=$(bot_switch "$1") || true
  case "$res" in
    *SWITCHED*) ;;
    *BOT_NOT_FOUND*) echo "BOT_NOT_FOUND"; return 1 ;;
    *) echo "SWITCH_FAILED:$res"; return 1 ;;
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
