#!/usr/bin/env node
// 复核一条知识条目。
//
// 分工：脚本负责【展示待核信息】与【落盘记录】；
//       重新查证、判断"变没变"由【模型】完成；最终确认由【人】做。
//       本脚本不联网、不调模型。
//
//   node review.mjs <id>              显示待核信息（供人/模型查证）
//   node review.mjs <id> --unchanged  确认没变 → 更新 asserted_at + 记 reviews
//   node review.mjs <id> --updated    已就地修正 → 同上，outcome: updated
//   node review.mjs <id> --supersede  提示走 supersede 流程（不自动执行）
//   node review.mjs --due             列出所有该复核的 id
import { readFileSync, writeFileSync } from 'node:fs';
import {
  loadEntries, parseFrontmatter, stringifyFrontmatter,
  freshness, foundation, wakeAt, today, assertNoDateOverride, REVIEW_DAYS, ICON,
  projectDirOf, fileHash, KB_ROOT,
} from './lib.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const now = today();
const entries = loadEntries();
const byId = new Map(entries.filter(e => e.qid).map(e => [e.qid, e]));

// ── --due：列出待复核 ────────────────────────────────────────
if (args.includes('--due')) {
  const rows = entries
    .filter(e => !['superseded', 'archived'].includes(e.data.status))
    .map(e => ({ e, f: freshness(e, now) }))
    .filter(x => x.f.state === 'overdue' || x.f.state === 'due-soon')
    .sort((a, b) => b.f.overdueDays - a.f.overdueDays);
  if (!rows.length) { console.log('✅ 没有待复核条目'); process.exit(0); }
  console.log(`\n📅 待复核 ${rows.length} 条 · ${now}\n`);
  for (const { e, f } of rows) {
    // ★ 必须打限定 id：byId 按 qid 建，打裸 id 的话把它复制回来喂给本脚本
    //   会得到「找不到 id」。列表输出必须是可以直接回喂的。
    console.log(`${ICON[f.state]} ${e.qid}  （应复核于 ${f.reviewBy}${f.source === 'wake' ? ' ⏰硬闹钟' : ''}）`);
  }
  console.log(`\n逐条复核：node kb/.scripts/review.mjs <id>`);
  process.exit(0);
}

const id = args.find(a => !a.startsWith('--'));
if (!id) {
  console.error('用法：node review.mjs <id> [--unchanged|--updated|--supersede]');
  console.error('      node review.mjs --due');
  process.exit(1);
}

const entry = byId.get(id);
if (!entry) { console.error(`❌ 找不到 id "${id}"`); process.exit(1); }

const d = entry.data;
const f = freshness(entry, now);
const g = foundation(entry, byId, now);

// ── 落盘动作 ────────────────────────────────────────────────
function record(outcome) {
  // ★ 只拦落盘 —— 上面的 --due 列表是只读的，用假日期预览是正当用途
  assertNoDateOverride('review.mjs 落盘');
  const raw = readFileSync(entry.path, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const prev = data.asserted_at;
  data.asserted_at = now;
  // 复核过就不再是 stale —— 否则 status 会永远卡在旧值
  if (data.status === 'stale') data.status = 'active';
  data.reviews = [...(data.reviews || []), { at: now, outcome }];
  // ★ 复核过 = 人确认了「对着现在的原文，断言仍然成立」→ 出处指纹刷新到现在。
  //   不刷新的话，「出处已变动」会在复核之后照样红着，队列永远清不掉。
  let refreshed = 0;
  if ((data.derived_from || []).length) {
    const pd = projectDirOf(KB_ROOT).dir;
    for (const d of data.derived_from) {
      const h = fileHash(join(pd, String(d.path)));
      if (h && h !== d.hash) { d.hash = h; refreshed++; }
    }
  }
  writeFileSync(entry.path, stringifyFrontmatter(data, body));

  const n = data.reviews.length;
  const unchangedRun = [...data.reviews].reverse()
    .findIndex(r => r.outcome !== 'unchanged');
  const streak = unchangedRun === -1 ? n : unchangedRun;

  console.log(`✅ ${id} 已记录复核：${outcome}`);
  console.log(`   asserted_at  ${prev} → ${now}`);
  if (refreshed) console.log(`   出处指纹      已刷新 ${refreshed} 份（对着现在的原文确认过了）`);
  console.log(`   新的复核期    ${REVIEW_DAYS[d.volatility] ?? '不复核'} 天后`);
  console.log(`   累计复核      ${n} 次`);

  // 自校准提示（只提示，不自动改 —— 由人决定）
  if (outcome === 'unchanged' && streak >= 3 && d.volatility === 'high')
    console.log(`\n💡 连续 ${streak} 次复核无变化，但标为 high(30天)。考虑降为 medium(90天)。`);
  if (outcome === 'unchanged' && streak >= 3 && d.volatility === 'medium')
    console.log(`\n💡 连续 ${streak} 次复核无变化，但标为 medium(90天)。考虑降为 low(365天)。`);

  console.log(`\n下一步：node kb/.scripts/build-index.mjs`);
}

if (args.includes('--unchanged')) { record('unchanged'); process.exit(0); }
if (args.includes('--updated'))   { record('updated');   process.exit(0); }

if (args.includes('--supersede')) {
  console.log(`\n🚫 ${id} 需要被取代（世界变了，不是我们记错了）\n`);
  console.log(`执行：node kb/.scripts/new.mjs --supersedes ${id}\n`);
  const affected = entries.filter(e => e.depsQ.includes(id));
  if (affected.length) {
    console.log(`⚠️  取代后，以下 ${affected.length} 条判断的地基会松动，必须逐条重新评估：`);
    for (const a of affected) console.log(`   - ${a.data.id}  —  ${a.data.title}`);
  } else {
    console.log('（没有判断依赖这条事实）');
  }
  process.exit(0);
}

// ── 默认：展示待核信息 ──────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`复核  ${id}`);
console.log('═'.repeat(60));
console.log(`标题        ${d.title}`);
console.log(`摘要        ${d.summary}`);
console.log(`类型/领域   ${d.type} / ${d.domain || '未标注'}`);
console.log(`易变度      ${d.volatility}（${REVIEW_DAYS[d.volatility] ?? '不复核'} 天周期）`);
console.log(`置信度      ${d.confidence || '未标'}`);
console.log(`\n── 时间 ──`);
console.log(`上次核实    ${d.asserted_at}`);
console.log(`应复核于    ${f.reviewBy || '不复核'}${f.source === 'wake' ? ' ⏰硬闹钟' : ''}`
  + (f.reviewBy ? `（${f.overdueDays > 0 ? `已逾期 ${f.overdueDays} 天` : `还有 ${-f.overdueDays} 天`}）` : ''));
if (d.event_at)     console.log(`事件发生    ${d.event_at}`);
if (d.effective_at) console.log(`生效于      ${d.effective_at}${f.pending ? '  ⏳ 尚未生效' : ''}`);
if (wakeAt(entry))  console.log(`硬闹钟      ${wakeAt(entry)}${f.source === 'wake' ? '  ← 本次复核由它触发' : ''}`);

console.log(`\n── 来源（重新查证时优先用 T1）──`);
if (!(d.sources || []).length) console.log('  ⚠️ 无来源记录');
for (const s of d.sources || []) console.log(`  [${s.tier || '?'}] ${s.url}${s.accessed ? `  (${s.accessed})` : ''}`);

if ((d.reviews || []).length) {
  console.log(`\n── 复核历史 ──`);
  for (const r of d.reviews) console.log(`  ${r.at}  ${r.outcome}`);
}

const dependents = entries.filter(e => e.depsQ.includes(id));
if (dependents.length) {
  console.log(`\n── ⚠️ ${dependents.length} 条判断依赖这条事实 ──`);
  for (const a of dependents) console.log(`  ${a.data.id}  —  ${a.data.title}`);
  console.log(`  （若本条被取代，以上结论全部需要重新评估）`);
}

if (g.state === 'shaky') {
  console.log(`\n── ⚠️ 本条自己的地基也松动 ──`);
  for (const is of g.issues) console.log(`  ${is.kind}: ${is.id}`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`查证之后，选一个：`);
console.log(`  没变        node kb/.scripts/review.mjs ${id} --unchanged`);
console.log(`  就地修正了   node kb/.scripts/review.mjs ${id} --updated`);
console.log(`  世界变了     node kb/.scripts/review.mjs ${id} --supersede`);
console.log('─'.repeat(60) + '\n');
