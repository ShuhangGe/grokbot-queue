#!/bin/bash
# 知识库周度保鲜检查。写日志 + macOS 通知。
# 路径自解析，不依赖安装位置。
#
# 安装（二选一）：
#   crontab:  (crontab -l 2>/dev/null; echo "0 9 * * 1 $(pwd)/kb/.scripts/weekly-check.sh") | crontab -
#   手动跑:    ./kb/.scripts/weekly-check.sh
set -euo pipefail
KB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$KB/.scripts/stale-history.log"
NODE="$(command -v node || echo /usr/local/bin/node)"

cd "$KB/.." || exit 1

# ★ 从这里起关闭 -e：build 失败【不能】让整个检查静默中止 ——
#   恰恰是知识库坏掉的时候，最需要提醒还能发出来。
set +e
BUILD_OUT="$("$NODE" "$KB/.scripts/build-index.mjs" 2>&1)"
BUILD_CODE=$?
OUT="$("$NODE" "$KB/.scripts/check-stale.mjs" 2>&1)"
CODE=$?

# ★ 从 build 的机器可读行里取出【地基松动】与【硬闹钟】计数。
#   check-stale.mjs 只认识 freshness，它的退出码永远反映不了这两项 ——
#   所以旗舰功能「主动告警」此前只写进了 STALE.md，从未到达通知通道。
STATS="$(echo "$BUILD_OUT" | grep '^KBSTATS ' | tail -1)"
get() { echo "$STATS" | sed -n "s/.*$1=\([0-9]*\).*/\1/p"; }
SHAKY="$(get shaky)";  SHAKY="${SHAKY:-0}"
ALARM="$(get alarms)"; ALARM="${ALARM:-0}"
OVERDUE="$(get overdue)"; OVERDUE="${OVERDUE:-0}"
# ★ 上层过期必须单独取。待复核队列收窄到本层之后，一条【上层】过期若恰好没有
#   本层判断依赖它，overdue 与 shaky 都是 0 —— 而 check-stale 仍会把它打进
#   同一封日志正文。报表和告警各说各话是最坏的一种，因为日志无人读、通知才有人看。
UPSTREAM="$(get upstream)"; UPSTREAM="${UPSTREAM:-0}"

# ★ build 失败时 KBSTATS 不存在，三个计数都会退化为 0。
#   但 check-stale 是独立跑的、结果有效 —— 用它的退出码（2=有过期）兜底，
#   否则「知识库坏掉」和「没有过期」会被混为一谈，恰恰丢掉最该发的提醒。
if [ "$BUILD_CODE" -ne 0 ] && [ "$CODE" -eq 2 ]; then
  OVERDUE="$(echo "$OUT" | grep -c '^🔴' || true)"
  [ "$OVERDUE" -eq 0 ] && OVERDUE=1
fi

{
  echo "═══ $(date '+%Y-%m-%d %H:%M') ═══"
  [ "$BUILD_CODE" -ne 0 ] && { echo "❌ build-index 失败（退出码 ${BUILD_CODE}）："; echo "$BUILD_OUT"; }
  echo "$OUT"
  echo "地基松动 ${SHAKY} · 90 天内闹钟 ${ALARM} · 上层过期 ${UPSTREAM}"
  echo
} >> "$LOG"

notify() { osascript -e "display notification \"$1\" with title \"$2\" sound name \"$3\"" 2>/dev/null || true; }

if [ "$BUILD_CODE" -ne 0 ]; then
  notify "build-index 失败，知识库索引可能已过时" "知识库告警" "Basso"
  echo "$BUILD_OUT" >&2
fi

# 汇总一条提醒，涵盖三类问题（此前只有过期会提醒）
MSG=""
[ "$OVERDUE" -gt 0 ] && MSG="${MSG}${OVERDUE} 条已过期 "
[ "$SHAKY"   -gt 0 ] && MSG="${MSG}${SHAKY} 条判断地基松动 "
[ "$ALARM"   -gt 0 ] && MSG="${MSG}${ALARM} 条 90 天内到闹钟 "
[ "$UPSTREAM" -gt 0 ] && MSG="${MSG}${UPSTREAM} 条上层依赖已过期（找该层 owner）"
if [ -n "$MSG" ]; then
  notify "${MSG}· 见 kb/STALE.md" "知识库保鲜提醒" "Ping"
  echo "$OUT"
  echo "地基松动 ${SHAKY} · 90 天内闹钟 ${ALARM} · 上层过期 ${UPSTREAM}"
fi
exit 0
