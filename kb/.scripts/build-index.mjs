#!/usr/bin/env node
// 重建 ROUTE.md / INDEX.md / index.json / STALE.md / GRAPH.md / OPEN.md
// ⚠️ 这六个文件全部自动生成，永远不要手改。
//
// 设计原则：本脚本【零模型】。所有语义判断（summary / type / volatility /
// domain / depends_on / open_questions）都在【写入条目时】由模型完成并固化进
// front-matter；此处只做确定性的日期算术、图遍历与聚合。
// 这样维护路径才能跑在 pre-commit 和 cron 里（那里没有模型）。
import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  loadEntries, freshness, foundation, wakeAt, stateIcon,
  ICON, FOUND_ICON, depIcon, today, daysBetween, KB_ROOT, ROOTS, LAYERS, REVIEW_DAYS, DOMAINS, ANSWERABLE, resolveRef, ownerOf, fingerprint,
  projectDirOf, derivedDrift, surveyOf,
} from './lib.mjs';

const now = today();
const entries = loadEntries();
const byId = new Map(entries.filter(e => e.qid).map(e => [e.qid, e]));

/** 目标层【看得见】的条目：它自己 + 它可以依赖的所有上层。
 *  ★ 一层的产物只能由这个范围构成。否则共享层的 INDEX 里会塞满
 *    ../projA/… 的链接：那份产物既不能被单独加载（离开这个项目就全是死链），
 *    又会被【每一个】跑 --all-layers 的项目反复覆盖成互相矛盾的内容。
 *  依赖只能向上，所以「本层及以上」恰好就是自洽闭包。 */
const visible = (target) => {
  const t = LAYERS.indexOf(target);
  return entries.filter(e => LAYERS.indexOf(e.layer) <= t);
};

// ── 预计算：新鲜度 + 地基健康度 ───────────────────────────────
// ★ 用【绝对路径】作键，不用 id：id 可能缺失或重复（validate 会报，但 build
//   必须先跑得动），而路径由文件系统保证唯一。
//   也不能再用 rel —— 多层之下 rel 是层内相对路径，两层都有
//   facts/market/x.md 时会撞键，静默丢掉一条。
const F = new Map(entries.map(e => [e.path, freshness(e, now)]));
const G = new Map(entries.map(e => [e.path, foundation(e, byId, now)]));
const fOf = e => F.get(e.path), gOf = e => G.get(e.path);
const fById = id => { const t = byId.get(id); return t ? F.get(t.path) : null; };

// ★ 链接必须从【产物所在位置】算起，不能用 e.rel ——
//   rel 是【层内】相对路径，指向上层条目时会解析到项目层里不存在的位置。
//   ⚠️ 上层条目的结果会逃出仓库（`../shared/…`）：本地能点开，GitHub 上打不开。
//      这是分层的固有代价 —— 上层本来就不在这个仓库里。index.json 因此
//      同时给出 layer 与层内 rel，消费方需要稳定标识时用那两个，别用 path。

// ★ 产物里的条目标签一律用【限定 id】：裸 id 跨层会重名，读者看到
//   `judgment-collision` 无从判断是共享层还是项目层那一条。
//   单层输出与改造前逐字节等价 —— project 层的 qid 就等于裸 id。

// ── 反向链接（按 scope 计算，见 visible 的说明）──────────────
function backlinksOf(scope, inScope) {
  const backlinks = new Map();
// ★ 键必须是【限定 id】：target 来自 depends_on，那里写的就是限定 id
//   （@shared/xxx）。而读取侧若用裸 data.id，上层条目永远查不到自己的
//   反向链接 —— GRAPH 会把一条被四处引用的共享事实宣布为「无人引用」，
//   报告在说假话而没有任何东西会发现。
  const addBack = (target, from, kind) => {
    // ★ 只收 scope 内的引用者：共享层的产物不该显示「被某个项目引用」，
    //   那份产物要能在没有那个项目的机器上单独成立。
    if (!inScope.has(target)) return;
    if (!backlinks.has(target)) backlinks.set(target, []);
    backlinks.get(target).push({ id: from, kind });
  };
  for (const e of scope) {
    for (const r of e.depsQ) addBack(r, e.qid, 'depends_on');
    for (const r of e.data.related || []) addBack(resolveRef(r, e.layer), e.qid, 'related');
  }
  return backlinks;
}

/** 表格单元格转义：未转义的 | 会把整行的列数撑破，后面所有列左移一格 */
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const dom = (e) => e.data.domain || null;

// ── 按层构建产物 ────────────────────────────────────────────
// ★ 每一层出自己的一套产物：导航类（INDEX / GRAPH / index.json）收录【全部
//   已加载】条目，因为找东西是跨层的；工作队列类（STALE 的三节、OPEN）只收
//   【本层】条目，因为复核责任是分层的。
function buildFor(target, outRoot) {
  const linkTo = e => relative(outRoot, e.path);
  const scope = visible(target);
  const inScope = new Set(scope.filter(e => e.qid).map(e => e.qid));
  const live = scope.filter(e => !['superseded', 'archived'].includes(e.data.status));
  const backlinks = backlinksOf(scope, inScope);
  // ★ 多层时分组必须带层名：否则共享层与项目层的 facts/market 会并成一组。
  //   单层（或上层自己那份产物）时与改造前完全一致。
  const multi = new Set(scope.map(e => e.layer)).size > 1;
  const group = (e) => {
    const dir = e.rel.split('/').slice(0, -1).join('/') || '(root)';
    return multi ? `${e.layer}: ${dir}` : dir;
  };
  const groups = [...new Set(live.map(group))].sort();
// ── INDEX.md ────────────────────────────────────────────────
const idx = [
  '# 知识库索引', '',
  '> ⚙️ **自动生成，请勿手改。**重建：`node kb/.scripts/build-index.mjs`',
  `> 生成于 ${now} · 共 ${live.length} 条有效条目（另有 ${scope.length - live.length} 条已取代/归档）`,
  '',
  '## 怎么用', '',
  '1. 在下表按分组/摘要定位条目 → 读对应文件',
  '2. 需要精确检索：`kb/index.json` 含每条的章节锚点、标签、时间字段与反向链接',
  '3. 引用事实时请标注 `id` 与 `asserted_at`',
  '4. 发现过期或有误：**不要直接改**，按 `kb/README.md` 的 supersede 流程走',
  '5. 待验证的开放问题见 [`OPEN.md`](OPEN.md)',
  '',
  '## 图例', '',
  '**新鲜度** `✅ 新鲜` · `🟡 7 天内到期` · `🔴 已过期` · `⏳ 已核实但尚未生效` · `⚪️ 不复核`',
  '',
  '**地基**（仅判断）`✅ 依赖全部有效` · `⚠️ 依赖中有过期或已取代` · `❔ 未声明依赖`',
  '',
  '`⏰` 表示复核日来自硬闹钟（`wake_at` / `effective_at`），不是易变周期推导',
  '',
];

// ★★ 路由表独立成 ROUTE.md —— 它是接线块里唯一【无条件】要求读的东西。
//    和 INDEX.md 合在一起时，agent 那一次 Read 会把整份索引（标签段 + 全部条目摘要）
//    一并拉进上下文：tp-vpn 实测 179,179 字符，其中属于本项目的条目摘要只占 1.0%。
//    INDEX.md 只有 757 行，远低于 Read 的默认上限，所以「只读顶部路由表」这个意图
//    在工具层面根本无法实现 —— 要判断顶部到哪结束，恰恰得先读完。
//
//    按【条目】归并，不是一问一行：同一条目的多个问法并进一格，路径只写一次。
//    tp-vpn 362 行 → 94 行、21,899 字符，省 88%；问题文本一个字不丢。
//
//    ★ 链接必须保持内联 `](path)` 形式。layers-test 的死链检测与越层泄漏检测
//      全靠这个语法提取链接，换成引用式定义（`][1]` + 末尾 `[1]: path`）之后
//      它们一个链接都提不到，会全部空过变成假绿。省下的那点字符不值这个代价。
const byEntry = new Map();   // entry -> [问法]
for (const e of live) for (const a of e.data.answers || []) {
  if (!byEntry.has(e)) byEntry.set(e, []);
  byEntry.get(e).push(a);
}
const noAns = live.filter(e => !(e.data.answers || []).length);

const rt = [
  '# 我想知道…  <sub>路由表</sub>', '',
  '> ⚙️ **自动生成，请勿手改。**重建：`node kb/.scripts/build-index.mjs`',
  `> 生成于 ${now} · ${byEntry.size} 条条目声明了问法`,
  '',
  '**在下表里找最接近你手头问题的那一行，读它指向的条目。**表里没有就全文检索：`node .scripts/search.mjs "<问题>"`。',
  '',
  '完整条目清单（摘要、新鲜度、地基健康度、按领域分组）见 [`INDEX.md`](INDEX.md)；待复核见 [`STALE.md`](STALE.md)。',
  '',
];
if (!byEntry.size) {
  rt.push('⚠️ 还没有任何条目声明 `answers:`。**读者只能靠目录结构猜，这是最容易漏读的状态。**', '');
} else {
  rt.push('| 条目 | 能回答 |', '|---|---|');
  for (const e of [...byEntry.keys()].sort((a, b) => a.qid.localeCompare(b.qid, 'zh')))
    rt.push(`| [\`${e.qid}\`](${linkTo(e)}) | ${byEntry.get(e)
      .sort((a, b) => a.localeCompare(b, 'zh')).map(q => cell(q)).join(' · ')} |`);
  rt.push('');
}
if (noAns.length)
  rt.push(`<sub>另有 ${noAns.length} 条未声明 \`answers:\`，只能从 [\`INDEX.md\`](INDEX.md) 的分组表里找。</sub>`, '');
writeFileSync(join(outRoot, 'ROUTE.md'), rt.join('\n'));

// INDEX.md 里只留一行指针，不再重复整张表 —— 同一份数据渲染两遍是上一版最大的一块浪费。
idx.push('## 我想知道…', '',
  `**按问题找条目请读 [\`ROUTE.md\`](ROUTE.md)** —— ${byEntry.size} 条条目的问法归并在一张表里，`
  + `比整份索引小一个数量级。${noAns.length ? `另有 ${noAns.length} 条未声明问法，只能从下方分组表里找。` : ''}`, '');

// 领域速览
idx.push('## 按领域', '');
idx.push('| 领域 | 条数 | 条目 |', '|---|---|---|');
for (const d of [...DOMAINS, '未标注']) {
  const rows = live.filter(e => (dom(e) || '未标注') === d);
  if (!rows.length) continue;
  idx.push(`| \`${d}\` | ${rows.length} | ${rows.map(e => `[\`${e.qid}\`](${linkTo(e)})`).join(' · ')} |`);
}
idx.push('');

for (const g of groups) {
  const rows = live.filter(e => group(e) === g);
  idx.push(`## ${g}  <sub>${rows.length} 条</sub>`, '');
  const hasJ = rows.some(e => e.data.type === 'judgment');
  idx.push(hasJ ? '| | 地基 | id | 摘要 | 领域 | 易变 | 断言于 | 应复核 |'
                : '| | id | 摘要 | 领域 | 易变 | 断言于 | 应复核 |');
  idx.push(hasJ ? '|---|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|');
  for (const e of rows) {
    const f = fOf(e), g2 = gOf(e), d = e.data;
    const rb = f.reviewBy ? `${f.reviewBy}${f.source === 'wake' ? ' ⏰' : ''}` : '—';
    const cells = [
      stateIcon(f),
      ...(hasJ ? [FOUND_ICON[g2.state] || ''] : []),
      `[\`${d.id}\`](${linkTo(e)})`,
      cell(d.summary),
      d.domain ? `\`${d.domain}\`` : '—',
      `\`${d.volatility}\``,
      d.asserted_at,
      rb,
    ];
    idx.push(`| ${cells.join(' | ')} |`);
  }
  idx.push('');
}

const allTags = [...new Set(live.flatMap(e => e.data.tags || []))].sort();
if (allTags.length) {
  idx.push('## 标签', '');
  for (const t of allTags) {
    const hits = live.filter(e => (e.data.tags || []).includes(t));
    idx.push(`- **${t}** · ${hits.map(e => `[\`${e.qid}\`](${linkTo(e)})`).join(' · ')}`);
  }
  idx.push('');
}
writeFileSync(join(outRoot, 'INDEX.md'), idx.join('\n'));

// ── index.json ──────────────────────────────────────────────
writeFileSync(join(outRoot, 'index.json'), JSON.stringify({
  generated_at: now,
  review_days: REVIEW_DAYS,
  domains: DOMAINS,
  // ★ 与 INDEX/GRAPH 同一个范围：本层 + 它可以依赖的上层。
  //   用全量 entries 的话，共享层的 index.json 里会带上 ../projA/… 的 path，
  //   那份产物离开这个项目就没有意义，也会被别的项目覆盖成矛盾内容。
  count: { total: scope.length, live: live.length },
  // ★ 内容指纹：消费方（status --all）据此判断这份索引是否已落后于语料。
  //   不用 mtime —— 它看不见删除、在 clone 后是任意顺序、也覆盖不到上层。
  source_hash: fingerprint(scope.map(x => ({ key: x.qid || x.rel, path: x.path }))),
  entries: scope.map(e => {
    const f = fOf(e), g2 = gOf(e);
    return {
      ...e.data,
      path: linkTo(e),
      layer: e.layer,
      rel: e.rel,
      // 全库唯一标识。裸 id 跨层会重名，消费方无法区分，
      // 且 foundation_issues[].id 用的就是限定 id，不给 qid 就没法 join。
      qid: e.qid,
      group: group(e),
      headings: e.headings,
      review_by: f.reviewBy,
      review_by_source: f.source,
      wake_at_effective: wakeAt(e),
      freshness: f.state,
      pending: f.pending,
      overdue_days: f.overdueDays,
      foundation: g2.state,
      foundation_issues: g2.issues,
      backlinks: backlinks.get(e.qid) || [],
      answers: e.data.answers || [],
    };
  }),
}, null, 2));

// ── STALE.md ────────────────────────────────────────────────
// ★ 待复核队列只收【本层】条目：上层条目是上层 owner 的活，
//   混进来等于把别人的工作摊到你的队列里。它们对你的影响另有出口 ——
//   下面的「地基松动」一节会连原因带链接一起指出来。
const mine = live.filter(e => e.layer === target);
const staleRows = mine.map(e => ({ e, f: fOf(e) }))
  .filter(x => x.f.state === 'overdue' || x.f.state === 'due-soon')
  .sort((a, b) => b.f.overdueDays - a.f.overdueDays);
const overdue = staleRows.filter(x => x.f.state === 'overdue');
const dueSoon = staleRows.filter(x => x.f.state === 'due-soon');

// 地基松动：判断本身没过期，但依赖里有问题
const shaky = mine.filter(e => e.data.type === 'judgment'
  && gOf(e).state === 'shaky'
  && fOf(e).state !== 'overdue');

// 未来 90 天内的硬闹钟
// ★ 必须按 wakeAt() 本身筛，不能按 f.source —— source 只在闹钟【早于】
//   周期复核日时才是 'wake'。晚于周期日的闹钟同样需要提前看见。
const alarms = mine.map(e => ({ e, f: fOf(e), wake: wakeAt(e) }))
  .filter(x => x.wake && x.wake >= now && daysBetween(now, x.wake) <= 90)
  .sort((a, b) => a.wake.localeCompare(b.wake));

// ★ kb 看一眼 docs/：条目的出处改了没、有没有没处理的文档。原文改了、加了新文档，
//   此前 kb 完全不知道，只能等 volatility 到期；这两节让它在【提交那一刻】就出现在队列里。
//   中央层也扫：它的 research/ 里是调研报告，条目从报告提炼、出处同样要盯。
const projectDir = projectDirOf(outRoot).dir;
const drift = projectDir ? derivedDrift(mine, projectDir) : [];
const survey = projectDir ? surveyOf(outRoot, projectDir, mine) : { unprocessed: [], changedSkipped: [] };
const docsPending = survey.unprocessed.length + survey.changedSkipped.length;

const st = [
  `# 待复核清单${target === 'project' ? '' : `（${target} 层）`}`, '',
  `> ⚙️ 自动生成 · ${now}`, '',
  `🔴 已过期 **${overdue.length}** 条 · 🟡 7 天内到期 **${dueSoon.length}** 条 · `
  + `⚠️ 地基松动 **${shaky.length}** 条判断 · ⏰ 90 天内闹钟 **${alarms.length}** 条`
  + (projectDir ? ` · 🟠 出处已变动 **${drift.length}** 条 · 📄 未处理文档 **${docsPending}** 份` : ''), '',
];
// ★ 上层过期不进本层队列，但必须【被看见】—— 否则「地基松动」只说得出
//   结论，说不出该去催谁。
const upstreamStale = [...new Set(mine.flatMap(e => e.depsQ))]
  .map(q => byId.get(q)).filter(t => t && t.layer !== target && fOf(t)?.state === 'overdue');
if (upstreamStale.length) st.push(
  `> ⬆️ 另有 **${upstreamStale.length}** 条你依赖的【上层】条目已过期。`
  + `它们不在你的队列里 —— 去找对应的 owner：`
  // ★ 点名到人。只说「归属层的 owner 负责」等于没说 —— 告警的价值在于
  //   收到的人知道下一步该做什么，而不是知道有事发生了。
  + upstreamStale.map(t => `\`${t.qid}\`（${ownerOf(t) || '⚠️ 未指定 owner'}）`).join(' · '), '');

st.push('## 🔴 本身已过期 / 🟡 临期', '');
if (!staleRows.length) st.push('✅ 全部新鲜。', '');
else {
  const row = ({ e, f }) =>
    `| ${ICON[f.state]} | [\`${e.qid}\`](${linkTo(e)}) | ${cell(e.data.title)} | \`${e.data.volatility}\` | ${f.reviewBy}${f.source === 'wake' ? ' ⏰' : ''} | ${f.overdueDays > 0 ? f.overdueDays + ' 天' : '—'} |`;
  const HEAD = ['| | id | 标题 | 易变 | 应复核于 | 逾期 |', '|---|---|---|---|---|---|'];
  // ★ 只在【确实有多个 owner】时才分组。单一 owner（含项目层那种全都没写
  //   owner 的情况）分组只会平白多两层标题 —— 单层输出因此逐字节不变。
  const owners = [...new Set(staleRows.map(x => ownerOf(x.e)))];
  if (owners.length <= 1) st.push(...HEAD, ...staleRows.map(row), '');
  else {
    st.push('按 **owner** 分组 —— 每一组就是一个人的复核清单。', '');
    for (const o of owners.sort((a, b) => (a || '\uffff').localeCompare(b || '\uffff'))) {
      const rows = staleRows.filter(x => ownerOf(x.e) === o);
      st.push(`### ${o || '⚠️ 未指定 owner'}  <sub>${rows.length} 条</sub>`, '', ...HEAD, ...rows.map(row), '');
    }
  }
}

st.push('## ⚠️ 地基松动的判断', '',
  '这些判断【本身】还没到复核期，但它依赖的事实出了问题。',
  '**在地基修好之前，这些结论不应被直接引用。**', '');
if (!shaky.length) st.push('✅ 所有判断的地基都有效。', '');
else {
  for (const e of shaky) {
    const g2 = gOf(e);
    st.push(`- [\`${e.qid}\`](${linkTo(e)}) — ${e.data.title}`);
    for (const is of g2.issues) {
      const t = byId.get(is.id);
      const link = t ? `[\`${is.id}\`](${linkTo(t)})` : `\`${is.id}\``;
      if (is.kind === 'overdue') st.push(`    - 🔴 依赖的事实已过期 ${is.days} 天：${link}`);
      else if (is.kind === 'superseded') st.push(`    - 🚫 依赖的事实已被取代：${link} → \`${is.to || '—'}\``);
      else if (is.kind === 'transitive') st.push(`    - ⚠️ 依赖的【判断】地基松动：${link}（问题源自 ${is.via.join(', ')}）`);
      else if (is.kind === 'marked-stale') st.push(`    - 🟠 依赖的事实被人工标记为待复核：${link}`);
      else st.push(`    - ❓ 依赖的 id 不存在：${link}`);
    }
  }
  st.push('');
}

st.push('## ⏰ 未来 90 天内的硬闹钟', '',
  '这些条目有确定的未来时点（`wake_at` 或 `effective_at`），到点必须重看。', '');
if (!alarms.length) st.push('（无）', '');
else {
  st.push('| id | 标题 | 闹钟 | 生效于 | 还有 |', '|---|---|---|---|---|');
  for (const { e, f, wake } of alarms) {
    st.push(`| [\`${e.qid}\`](${linkTo(e)}) | ${cell(e.data.title)} | ${wake} | ${f.effectiveAt || '—'} | ${daysBetween(now, wake)} 天 |`);
  }
  st.push('');
}

if (projectDir) {
  st.push('## 🟠 出处已变动', '',
    '条目是从这些文档【提炼】出来的，文档改了，条目里的断言可能已经不对。',
    '复核：`node kb/.scripts/review.mjs <id>` —— 断言没变就 `--unchanged`（顺带刷新指纹），变了走 supersede。', '');
  if (!drift.length) st.push('（无）', '');
  else {
    st.push('| id | 出处 | 状态 |', '|---|---|---|');
    for (const { e, path, state } of drift)
      st.push(`| [\`${e.qid}\`](${linkTo(e)}) | \`${path}\` | ${state === 'missing' ? '❌ 文件已不存在' : '✏️ 已改动'} |`);
    st.push('');
  }
  st.push('## 📄 未处理的文档', '',
    '项目里的文档，还没有人决定它进不进 kb。**多数不该进** —— 规格、流程、设计稿变化是因为「我们改了想法」，不是「世界变了」。',
    '读过之后：进 → `node kb/.scripts/new.mjs --from <path>`；不进 → `node kb/.scripts/survey.mjs --skip <path> --why "…"`。', '');
  if (!docsPending) st.push('（无）', '');
  else {
    const CAP = 30;
    if (survey.unprocessed.length) {
      st.push(`**新的 / 还没看过的**（${survey.unprocessed.length} 份）`, '');
      for (const d of survey.unprocessed.slice(0, CAP)) st.push(`- \`${d.rel}\``);
      if (survey.unprocessed.length > CAP) st.push(`- … 另有 ${survey.unprocessed.length - CAP} 份（\`node kb/.scripts/survey.mjs --list\` 看全部）`);
      st.push('');
    }
    if (survey.changedSkipped.length) {
      st.push(`**之前决定不进、但后来改过的**（${survey.changedSkipped.length} 份）—— 低优先级，改动可能让它值得重看`, '');
      for (const d of survey.changedSkipped) st.push(`- \`${d.rel}\`  ← 当时不进的理由：${d.why || '（未写）'}`);
      st.push('');
    }
  }
}

st.push('## 复核怎么做', '',
  '推荐用 `node kb/.scripts/review.mjs <id>` 走引导流程，它会记录复核结果。', '',
  '手工版：',
  '1. 重新核实该条事实（优先找 T1 来源）',
  '2. **数值/结论变了** → `node kb/.scripts/new.mjs --supersedes <id>` 新建条目，原条目保留',
  '3. **没变** → 更新 `asserted_at` 为今天，并在 `reviews:` 追加一条 `outcome: unchanged`',
  '4. **我们当初记错了** → 原地修正 + 在正文追加「## 修订记录」',
  '', '> 取代事实后，本文件的「⚠️ 地基松动」一节会列出受影响的判断。');
writeFileSync(join(outRoot, 'STALE.md'), st.join('\n'));

// ── GRAPH.md ────────────────────────────────────────────────
const gr = ['# 依赖关系图', '', `> ⚙️ 自动生成 · ${now}`, '',
  '判断（judgment）声明它依赖哪些事实（fact）。事实被取代或过期时，依赖它的判断必须重新评估。',
  '**主动告警见 [`STALE.md`](STALE.md) 的「⚠️ 地基松动」一节。**', ''];

// 用 live：已取代的判断不需要「重新评估」，否则每次 supersede 都会让误报清单变长
const judgments = live.filter(e => e.data.type === 'judgment');
const broken = judgments.map(j => ({ j, g: gOf(j) })).filter(x => x.g.state === 'shaky');

gr.push('## ⚠️ 需要重新评估的判断', '');
if (!broken.length) gr.push('✅ 所有判断所依赖的事实均有效且新鲜。', '');
else {
  for (const { j, g: g2 } of broken) {
    gr.push(`### [\`${j.qid}\`](${linkTo(j)}) — ${j.data.title}`, '');
    for (const is of g2.issues) {
      const t = byId.get(is.id);
      const link = t ? `[\`${is.id}\`](${linkTo(t)})` : `\`${is.id}\``;
      if (is.kind === 'overdue') gr.push(`- 🔴 依赖的事实已过期待复核：${link}（逾期 ${is.days} 天）`);
      else if (is.kind === 'superseded') gr.push(`- 🚫 依赖的事实已被取代：${link} → \`${is.to || '—'}\``);
      else if (is.kind === 'transitive') gr.push(`- ⚠️ 依赖的【判断】地基松动：${link}（问题源自 ${is.via.join(', ')}）`);
      else if (is.kind === 'marked-stale') gr.push(`- 🟠 依赖的事实被人工标记为待复核：${link}`);
      else gr.push(`- ❓ 依赖的 id 不存在：${link}`);
    }
    gr.push('');
  }
}

gr.push('## 全部判断 → 依赖的事实', '');
for (const j of judgments) {
  const deps = j.depsQ;
  const g2 = gOf(j);
  gr.push(`- ${FOUND_ICON[g2.state]} [\`${j.qid}\`](${linkTo(j)})${deps.length ? '' : '  ⚠️ 未声明依赖'}`);
  for (const id of deps) {
    const t = byId.get(id);
    gr.push(`  - ${depIcon(t, fById(id))} [\`${id}\`](${t ? linkTo(t) : '#'})`);
  }
}
gr.push('', '## 被谁引用（反向链接）', '',
  '按被引用次数排序。**排在前面的条目，一旦变化影响面最大。**', '');
const cited = entries
  .map(e => ({ e, bl: backlinks.get(e.qid) || [] }))
  .filter(x => x.bl.length)
  .sort((a, b) => b.bl.length - a.bl.length);
for (const { e, bl } of cited) {
  gr.push(`- **${bl.length}** ← [\`${e.qid}\`](${linkTo(e)}) \`${e.data.type}\` · ${bl.map(b => `\`${b.id}\`(${b.kind})`).join(' · ')}`);
}
// 用 live：已取代/归档的事实无人引用是正常的，不是需要关注的孤儿
const uncited = live.filter(e => !(backlinks.get(e.qid) || []).length && e.data.type === 'fact');
if (uncited.length) {
  gr.push('', `### 无人引用的事实 <sub>${uncited.length} 条</sub>`, '');
  for (const e of uncited) gr.push(`- [\`${e.qid}\`](${linkTo(e)})`);
}
writeFileSync(join(outRoot, 'GRAPH.md'), gr.join('\n'));

// ── OPEN.md ─────────────────────────────────────────────────
// 聚合各条目 front-matter 里的 open_questions。
// ⚠️ 分组用的 answerable_by 由【模型在写入时】判定并固化，此处只做聚合。
const LABEL = {
  internal: '▸ 内部可验证（问同事 / 查内部数据就能答）',
  research: '▸ 需要外部调研',
  expert:   '▸ 需要专业意见',
};
const buckets = Object.fromEntries(ANSWERABLE.map(k => [k, []]));
let qCount = 0;
// ★ 只收本层：开放问题是【谁去回答】的工作队列，上层的问题归上层 owner。
//   收全部的话，共享层的 OPEN.md 会列出某个项目的问题，链接还指向
//   ../projA/… —— 那份产物离开这个项目就是死链。
for (const e of mine) {
  for (const q of e.data.open_questions || []) {
    const k = ANSWERABLE.includes(q.answerable_by) ? q.answerable_by : 'research';
    buckets[k].push({ q: q.q, e, priority: q.priority || null });
    qCount++;
  }
}
// 结构性检测（非语义）：有「失效条件」章节但未结构化
const HEAD_RE = /失效|待确认|未核实|待补/;
const unstructured = mine.filter(e =>
  !(e.data.open_questions || []).length && e.headings.some(h => HEAD_RE.test(h)));

const op = [
  '# 开放问题', '',
  `> ⚙️ 自动生成 · ${now} · 共 ${qCount} 个待验证问题`, '',
  '把知识库从「参考资料」变成「工作队列」。',
  '来源是各条目 front-matter 的 `open_questions`，按**谁能回答**分组。', '',
  '```yaml',
  '# 在条目里这样声明（由模型在写入时判定 answerable_by）',
  'open_questions:',
  '  - q: "流水已上亿实际来自支付还是博彩生态？"',
  '    answerable_by: internal        # internal | research | expert',
  '    priority: high                 # 可选',
  '```', '',
];
for (const k of ANSWERABLE) {
  const rows = buckets[k];
  op.push(`## ${LABEL[k]}  <sub>${rows.length} 个</sub>`, '');
  if (!rows.length) { op.push('（无）', ''); continue; }
  for (const r of rows) {
    op.push(`- [ ] ${r.q}${r.priority ? `  \`${r.priority}\`` : ''}`);
    op.push(`      ↳ 来自 [\`${r.e.qid}\`](${linkTo(r.e)})`);
  }
  op.push('');
}
op.push('## 📝 待结构化', '',
  '以下条目正文里有「失效条件 / 待确认 / 未核实」章节，但没有把问题固化进 `open_questions`。',
  '**这是设计要求：语义判断要在写入时做掉，维护路径才能保持零模型。**', '');
if (!unstructured.length) op.push('✅ 全部已结构化。', '');
else for (const e of unstructured) op.push(`- [ ] [\`${e.qid}\`](${linkTo(e)}) — ${e.data.title}`);
writeFileSync(join(outRoot, 'OPEN.md'), op.join('\n'));

  return { overdue: overdue.length, shaky: shaky.length, alarms: alarms.length, open: qCount,
           mine: mine.length, scope: scope.length, upstream: upstreamStale.length,
           drift: drift.length, docs: docsPending };
}
// ── 目标层与调用 ────────────────────────────────────────────
// 默认只构建 KB_ROOT 所在的那一层。`--all-layers` 会给每个已加载的层各出
// 一套产物 —— 上层的产物写在上层目录里，那是它 owner 的工作台。
const argv = process.argv.slice(2);
const flag = k => { const i = argv.indexOf('--' + k); return i === -1 ? null : argv[i + 1]; };
const OWN = ROOTS().find(r => r.root === KB_ROOT)?.layer || 'project';

let targets;
if (argv.includes('--all-layers')) targets = ROOTS().map(r => ({ layer: r.layer, root: r.root }));
else {
  if (argv.includes('--layer') && !flag('layer')) {
    // ★ 缺值时静默退回本层，是「看起来生效了其实没有」的经典形态。
    console.error('❌ --layer 需要一个层名，例如 --layer shared');
    process.exit(1);
  }
  const want = flag('layer') || OWN;
  const hit = ROOTS().find(r => r.layer === want);
  if (!hit) {
    console.error(`❌ 层 "${want}" 未加载。已加载：${ROOTS().map(r => r.layer).join(', ')}`);
    process.exit(1);
  }
  targets = [{ layer: hit.layer, root: hit.root }];
}

let last = null;
for (const t of targets) {
  const r = buildFor(t.layer, t.root);
  last = r;
  const where = targets.length > 1 ? `[${t.layer}] ` : '';
  console.log(`✅ ${where}索引已重建 · ${r.mine} 条本层 / ${r.scope} 条可见 / ${entries.length} 条已加载`);
  console.log(`   ${where}ROUTE.md · INDEX.md · index.json · STALE.md · GRAPH.md · OPEN.md`);
  if (r.overdue) console.log(`   🔴 ${r.overdue} 条已过期`);
  if (r.shaky)   console.log(`   ⚠️  ${r.shaky} 条判断地基松动`);
  if (r.alarms)  console.log(`   ⏰ ${r.alarms} 条 90 天内到闹钟`);
  if (r.open)    console.log(`   📋 ${r.open} 个开放问题（OPEN.md）`);
  // ★ 这两行是 pre-commit 里唯一会被看见的地方 —— 提交那一刻的提醒就是它
  if (r.drift)   console.log(`   🟠 ${r.drift} 条条目的出处已改动（STALE.md「出处已变动」）`);
  if (r.docs)    console.log(`   📄 ${r.docs} 份文档还没决定进不进 kb（STALE.md「未处理的文档」）`);
}
// 机器可读的一行，供 weekly-check.sh 解析后决定是否告警。
// ★ 多层构建时报告【最后一个目标】，而默认单目标就是本层 —— 保证
//   weekly-check 拿到的永远是「我这一层要干的活」。
// ★ upstream 必须进 KBSTATS：待复核队列收窄到本层之后，一条【上层】过期
//   若恰好没有本层判断依赖它，overdue 与 shaky 都是 0，weekly-check 就静默
//   不告警了 —— 而 check-stale 仍会把它打进同一封日志正文。
//   报表和告警不能各说各话。
console.log(`KBSTATS overdue=${last.overdue} shaky=${last.shaky} alarms=${last.alarms} open=${last.open} upstream=${last.upstream} drift=${last.drift} docs=${last.docs}`);
