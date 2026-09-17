#!/usr/bin/env node
// 列出过期 / 临期条目。--json 输出机器可读；--quiet 只在有过期项时输出。
import { loadEntries, freshness, ICON, today, locOf } from './lib.mjs';

const args = process.argv.slice(2);
const now = today();
const rows = loadEntries()
  .filter(e => e.data.status !== 'superseded' && e.data.status !== 'archived')
  .map(e => ({ ...freshness(e, now), id: e.qid, title: e.data.title, rel: locOf(e), volatility: e.data.volatility }))
  .filter(r => r.state === 'overdue' || r.state === 'due-soon')
  .sort((a, b) => b.overdueDays - a.overdueDays);

if (args.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
const overdue = rows.filter(r => r.state === 'overdue');
if (args.includes('--quiet') && !overdue.length) process.exit(0);

console.log(`\n📅 知识库保鲜检查 · ${now}\n`);
if (!rows.length) { console.log('✅ 没有过期或临期条目'); process.exit(0); }
console.log(`🔴 已过期 ${overdue.length} 条 · 🟡 7 天内到期 ${rows.length - overdue.length} 条\n`);
for (const r of rows) {
  const d = r.overdueDays > 0 ? `逾期 ${r.overdueDays} 天` : `${-r.overdueDays} 天后到期`;
  console.log(`${ICON[r.state]} ${r.id}`);
  console.log(`   ${r.title}`);
  console.log(`   ${r.volatility} · 应复核于 ${r.reviewBy} · ${d} · ${r.rel}\n`);
}
process.exit(overdue.length ? 2 : 0);
