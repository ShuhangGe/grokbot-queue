#!/bin/sh
# 知识库一致性检查。安装：
#   git init                                   # 若尚未初始化
#   cp kb/.scripts/pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#
# ★ 自己找库，不写死 kb/：git 钩子在仓库顶层跑，而库可能是
#     kb/            普通项目
#     .              库根就是仓库根
#     shared/ portfolio/   一个仓库放几个中央层（mindlink-central 的形态）
#   逐个跑。哪个库都不该被另一个的失败挡住 —— 所以先全跑完，最后统一退出码。
set -u
found=""
[ -f kb/.scripts/validate.mjs ] && found="kb"
[ -f .scripts/validate.mjs ] && found="$found ."
for d in */; do
  d="${d%/}"
  [ "$d" = "kb" ] && continue
  [ -f "$d/.scripts/validate.mjs" ] && found="$found $d"
done
if [ -z "$found" ]; then
  echo "pre-commit: 没找到任何知识库（kb/.scripts/validate.mjs 之类），跳过。"
  exit 0
fi

rc=0
for lib in $found; do
  echo "══ 知识库 $lib"
  if [ "$lib" = "." ]; then abs="$(pwd)"; else abs="$(pwd)/$lib"; fi
  export MINDLINK_KB="$abs"
  echo "→ 校验 front-matter…";     node "$abs/.scripts/validate.mjs"        || rc=1
  echo "→ 序列化收敛回归…";       node "$abs/.scripts/roundtrip-test.mjs"  || rc=1
  echo "→ 检索可发现性…";         node "$abs/.scripts/retrieval-test.mjs"  || rc=1
  echo "→ 重建索引…";             node "$abs/.scripts/build-index.mjs"     || rc=1
  git add "$lib/ROUTE.md" "$lib/INDEX.md" "$lib/index.json" "$lib/STALE.md" "$lib/GRAPH.md" "$lib/OPEN.md" 2>/dev/null || true
done
exit $rc
