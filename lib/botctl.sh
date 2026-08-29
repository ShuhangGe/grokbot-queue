#!/bin/bash
# Bot 层控制的三级降级。被 lib/common.sh source。
#
#   L1  CDP + 精确选择器      最快，默认
#   L2  CDP + 启发式          选择器失效时（Grok Bot 升级改了 class）
#   L3  computer use          DOM 整个不可用时（需窗口在当前 Space）
#
# 每一级都返回 SENT / SWITCHED 才算成功，否则落到下一级。
# GBQ_FORCE_LEVEL=1|2|3 可强制指定级别（doctor 和调试用）。

# ---------- L1：精确选择器 ----------
_sel_input='.sand-prompt-field'
_sel_item='button.sand-agent-item'
_sel_name='[class*=agent-item__name]'
_sel_send='Send message'   # aria-label

_l1_send() {
  local b64; b64=$(printf '%s' "$1" | base64)
  render_js "
    (() => {
      const txt = new TextDecoder().decode(Uint8Array.from(atob('$b64'), c => c.charCodeAt(0)));
      const el = document.querySelector('$_sel_input');
      if (!el) return 'L1_NO_INPUT';
      el.focus();
      const r = document.createRange(); r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.execCommand('insertText', false, txt);
      return (async () => {
        for (let i = 0; i < 50; i++) {
          const b = [...document.querySelectorAll('button')]
            .find(x => (x.getAttribute('aria-label')||'') === '$_sel_send');
          if (b && !b.disabled) { b.click(); return 'SENT'; }
          await new Promise(r => setTimeout(r, 100));
        }
        return 'L1_NO_SEND_BTN';
      })();
    })()
  "
}

_l1_list() {
  render_js "
    (() => {
      const items = [...document.querySelectorAll('$_sel_item')];
      if (!items.length) return 'L1_NO_ITEMS';
      return items.map(el => ((el.querySelector('$_sel_name')||{}).innerText||'').trim())
                  .filter(Boolean).join('\\\\n');
    })()
  "
}

_l1_switch() {
  local b64; b64=$(printf '%s' "$1" | base64)
  render_js "
    (() => {
      const want = new TextDecoder().decode(Uint8Array.from(atob('$b64'), c => c.charCodeAt(0)));
      const items = [...document.querySelectorAll('$_sel_item')];
      if (!items.length) return 'L1_NO_ITEMS';
      const t = items.find(el => ((el.querySelector('$_sel_name')||{}).innerText||'').trim() === want);
      if (!t) return 'BOT_NOT_FOUND';
      t.click(); return 'SWITCHED';
    })()
  "
}

# ---------- L2：启发式 ----------
# 不依赖任何 sand-* class：
#   输入框 = 页面下半部、可见、最宽的 contenteditable
#   发送键 = 输入框之后、同一区域内、无文字的小按钮（图标按钮），取最右那个
#           找不到就退回按 Enter（多数聊天框支持）
_l2_send() {
  local b64; b64=$(printf '%s' "$1" | base64)
  render_js "
    (() => {
      const txt = new TextDecoder().decode(Uint8Array.from(atob('$b64'), c => c.charCodeAt(0)));
      const vh = window.innerHeight;
      const eds = [...document.querySelectorAll('[contenteditable=\\\\'true\\\\']')]
        .map(el => ({el, r: el.getBoundingClientRect()}))
        .filter(o => o.r.width > 80 && o.r.height > 10 && o.r.top > vh * 0.4)
        .sort((a,b) => b.r.width - a.r.width);
      if (!eds.length) return 'L2_NO_INPUT';
      const el = eds[0].el, box = eds[0].r;
      el.focus();
      const r = document.createRange(); r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.execCommand('insertText', false, txt);
      return (async () => {
        for (let i = 0; i < 40; i++) {
          // 输入框所在行附近的图标按钮，取最靠右且启用的
          const cands = [...document.querySelectorAll('button')]
            .map(b => ({b, r: b.getBoundingClientRect()}))
            .filter(o => !o.b.disabled && o.r.width > 0 && o.r.width < 80
                      && o.r.top > box.top - 40 && o.r.top < box.bottom + 60)
            .sort((a,b) => b.r.left - a.r.left);
          const hit = cands.find(o => {
            const a = (o.b.getAttribute('aria-label')||'').toLowerCase();
            return /send|submit|发送/.test(a);
          }) || cands[0];
          if (hit) { hit.b.click(); return 'SENT'; }
          await new Promise(r => setTimeout(r, 100));
        }
        // 最后手段：往输入框敲回车
        el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', keyCode:13, bubbles:true, cancelable:true}));
        return 'SENT';
      })();
    })()
  "
}

_l2_list() { _l2_items list ""; }
_l2_switch() { _l2_items switch "$1"; }

# L2 的 Bot 列表识别：不靠 class，靠「列表」的本质特征 —— 同一父节点下的
# 重复兄弟结构。Search / Plugins / 账号入口都是孤立元素，会被自动排除。
_l2_items() {
  local mode="$1"
  local b64; b64=$(printf '%s' "${2:-}" | base64)
  render_js "
    (() => {
      const want = new TextDecoder().decode(Uint8Array.from(atob('$b64'), c => c.charCodeAt(0)));
      const vw = window.innerWidth;
      const clickable = [...document.querySelectorAll('button,[role=button],a')]
        .map(b => ({b, r: b.getBoundingClientRect()}))
        .filter(o => o.r.left < vw * 0.4 && o.r.width > 100 && o.r.height > 28 && o.r.height < 140);

      // 按父节点分组，找出成员最多的那组 —— 那就是列表
      const groups = new Map();
      for (const o of clickable) {
        const key = o.b.parentElement;
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
      }
      let best = [];
      for (const [, arr] of groups) if (arr.length > best.length) best = arr;

      // 单 Bot 时没有重复结构，退回：带头像(img/svg/背景图)的可点击项
      if (best.length < 2) {
        best = clickable.filter(o =>
          o.b.querySelector('img,svg') ||
          [...o.b.querySelectorAll('*')].some(e => (getComputedStyle(e).backgroundImage||'none') !== 'none'));
      }
      // 功能按钮的 aria-label 多是动词短语(Open account menu / Add reaction)，
      // Bot 项的 aria 则是名字本身。据此排掉非 Bot 项。
      const UI_WORDS = /^(search|plugins?|settings?|new|add|home|inbox|更多|设置|搜索)$/i;
      const UI_ARIA  = /^(open|view|add|create|show|toggle|close|reply|start)\\\\b|account|setting|plugin|profile|help|update|channel/i;
      const rows = best
        .filter(o => !UI_ARIA.test(o.b.getAttribute('aria-label')||''))
        .sort((a,b) => a.r.top - b.r.top)
        .map(o => ({ el: o.b, name: (o.b.innerText||'').trim().split('\\\\n')[0].trim() }))
        .filter(x => x.name && x.name.length < 40 && !UI_WORDS.test(x.name));

      if (!rows.length) return 'L2_NO_ITEMS';
      if ('$mode' === 'list') {
        return [...new Set(rows.map(x => x.name))].join('\\\\n');
      }
      const hit = rows.find(x => x.name === want);
      if (!hit) return 'BOT_NOT_FOUND';
      hit.el.click(); return 'SWITCHED';
    })()
  "
}

# ---------- L3：computer use（cua-driver）----------
# 前提：窗口必须在当前 Space。off-Space 时 click 会返回成功但静默无效
# （实测过，键盘输入也会被丢弃），所以这里先检测，不满足就明确报错。
_l3_available() {
  command -v cua-driver >/dev/null 2>&1 || { echo "L3_NO_CUA_DRIVER"; return 1; }
  cua-driver status >/dev/null 2>&1 || open -n -g -a CuaDriver --args serve 2>/dev/null
  local pid; pid=$(_app_pid)
  [ -z "$pid" ] && { echo "L3_APP_NOT_RUNNING"; return 1; }
  local onspace
  onspace=$(cua-driver list_windows "{\"pid\":$pid}" 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('err'); sys.exit()
ws=[w for w in d.get('windows',[]) if w.get('title')]
print('yes' if any(w.get('on_current_space') for w in ws) else 'no')
" 2>/dev/null)
  if [ "$onspace" != "yes" ]; then
    echo "L3_WINDOW_OFF_SPACE"; return 1
  fi
  echo "$pid"
}

_l3_send() {
  local pid; pid=$(_l3_available) || { echo "$pid"; return 1; }
  local wid
  wid=$(cua-driver list_windows "{\"pid\":$pid}" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
ws=[w for w in d.get('windows',[]) if w.get('title') and w.get('on_current_space')]
ws.sort(key=lambda w:-(w['bounds']['width']*w['bounds']['height']))
print(ws[0]['window_id'] if ws else '')
")
  [ -z "$wid" ] && { echo "L3_NO_WINDOW"; return 1; }
  cua-driver get_window_state "{\"pid\":$pid,\"window_id\":$wid}" >/dev/null 2>&1
  # 输入框在窗口底部中间，点一下聚焦
  local h w
  read -r w h < <(cua-driver list_windows "{\"pid\":$pid}" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for x in d['windows']:
    if x['window_id']==$wid: print(x['bounds']['width'], x['bounds']['height'])
")
  cua-driver click "{\"pid\":$pid,\"window_id\":$wid,\"x\":$((w*2/3)),\"y\":$((h-40))}" >/dev/null 2>&1
  cua-driver type_text "{\"pid\":$pid,\"text\":$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" >/dev/null 2>&1 || { echo "L3_TYPE_FAILED"; return 1; }
  cua-driver press_key "{\"pid\":$pid,\"key\":\"return\"}" >/dev/null 2>&1 || { echo "L3_ENTER_FAILED"; return 1; }
  echo "SENT"
}

# ---------- 对外：自动降级 ----------
_try_levels() {
  local kind="$1"; shift
  local want_level="${GBQ_FORCE_LEVEL:-0}"
  local res lvl
  for lvl in 1 2 3; do
    [ "$want_level" != 0 ] && [ "$want_level" != "$lvl" ] && continue
    case "${kind}_${lvl}" in
      send_1)   res=$(_l1_send "$1" 2>/dev/null || true) ;;
      send_2)   res=$(_l2_send "$1" 2>/dev/null || true) ;;
      send_3)   res=$(_l3_send "$1" 2>/dev/null || true) ;;
      list_1)   res=$(_l1_list 2>/dev/null || true) ;;
      list_2)   res=$(_l2_list 2>/dev/null || true) ;;
      list_3)   res="L3_LIST_UNSUPPORTED" ;;
      switch_1) res=$(_l1_switch "$1" 2>/dev/null || true) ;;
      switch_2) res=$(_l2_switch "$1" 2>/dev/null || true) ;;
      switch_3) res="L3_SWITCH_UNSUPPORTED" ;;
    esac
    case "$res" in
      SENT|SWITCHED)  GBQ_USED_LEVEL=$lvl; echo "$res"; return 0 ;;
      BOT_NOT_FOUND)  echo "BOT_NOT_FOUND"; return 1 ;;   # 确定性失败，别再降级
      L*_*|"")        continue ;;                          # 该级不可用 → 下一级
      *)              GBQ_USED_LEVEL=$lvl; echo "$res"; return 0 ;;  # list 的正常输出
    esac
  done
  echo "ALL_LEVELS_FAILED:${res:-empty}"
  return 1
}
