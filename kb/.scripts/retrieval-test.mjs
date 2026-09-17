#!/usr/bin/env node
// 检索测试：给定一句任务描述，验证路由是否命中正确的条目。
//
// 为什么需要它：
//   我们为「这条知识还对吗」建了大量机制 —— volatility、硬闹钟、地基传导、
//   收敛测试、CI。却零机制保证「有人能找到它」。
//   一条被完美维护、永不过期、地基稳固的知识，没人找得到时价值是零。
//
//   这个测试就是可发现性的守卫，地位等同于 roundtrip-test 之于序列化。
//
// 用法：
//   node retrieval-test.mjs                 跑 kb/retrieval.expect
//   node retrieval-test.mjs --file <path>
//   node retrieval-test.mjs --ask "问题"     临时查一句，不判定成败
//
// 期望文件格式（kb/retrieval.expect），# 开头为注释：
//   我想知道的问题 => entry-id-a, entry-id-b
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEntries, KB_ROOT, locOf, route as routeIn } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf('--' + k); return i === -1 ? null : argv[i + 1]; };

const all = loadEntries();
const entries = all.filter(e => !['superseded', 'archived'].includes(e.data.status));
// 已取代的 id → 继任者，用于给出可执行的提示而不是「根本不存在」
// 覆盖所有【存在但不在 live 里】的条目：archived、以及 superseded 却没写
// superseded_by 的。否则会把「文件就在那儿」报成「根本不存在」，
// 而这个测试现在门禁着每一次提交。
const retired = new Map(all
  .filter(e => ['superseded', 'archived'].includes(e.data.status))
  .map(e => [e.qid, { status: e.data.status, to: e.data.superseded_by || null, rel: locOf(e) }]));

// ── 路由：模拟一个 agent 拿着问题去 INDEX 找条目 ──────────────
// 只用【已固化进 front-matter 的结构化数据】，不做语义推断 ——
// 因为真实的 agent 读到的就是这些，测试必须和它看到的一致。
// ★ 评分逻辑住在 lib.mjs，与 search 共用一份 —— 复制一份出来的话，
//   这个测试守的就不再是别人实际在走的那条路由了。
const route = (q) => routeIn(q, entries.map(e => ({
  qid: e.qid, answers: e.data.answers, tags: e.data.tags, title: e.data.title, rel: locOf(e),
}))).map(h => ({ id: h.qid, score: h.score, why: h.why, rel: h.rel }));

// ── --ask：临时查询 ────────────────────────────────────────
const ask = arg('ask');
if (ask) {
  const hits = route(ask);
  console.log(`\n🔎 「${ask}」\n`);
  if (!hits.length) console.log('   ❌ 没有任何条目声明能回答这个问题');
  else hits.forEach(h => console.log(`   ${String(h.score).padStart(3)}  ${h.id}  (${h.why})`));
  process.exit(0);
}

// ── 期望文件 ──────────────────────────────────────────────
const file = arg('file') || join(KB_ROOT, 'retrieval.expect');
if (!existsSync(file)) {
  console.log(`⚠️  没有期望文件：${file}`);
  console.log('   建一个，每行 “问题 => 期望命中的 id（逗号分隔）”，# 开头为注释。');
  console.log('   没有它，可发现性就是不设防的 —— 正如这次一个 agent 读完仓库却什么都没找到。');
  process.exit(0);
}

const cases = readFileSync(file, 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => { const [q, ids] = l.split('=>'); return { q: (q || '').trim(), want: (ids || '').split(',').map(s => s.trim()).filter(Boolean) }; })
  .filter(c => c.q && c.want.length);

// ★ 用限定 id：裸 id 跨层会重名，两条会塌成一个槽位，
//   而 retrieval.expect 也就没法指名上层的条目。
const known = new Set(entries.map(e => e.qid));
let fail = 0;
console.log(`\n🔎 检索测试 · ${cases.length} 个用例\n`);
for (const c of cases) {
  const hits = route(c.q);
  const top = hits.filter(h => h.score >= 60).map(h => h.id);
  const missing = c.want.filter(id => !top.includes(id));
  const ghost = c.want.filter(id => !known.has(id));
  if (ghost.length) {
    fail++;
    console.log(`❌ ${c.q}`);
    for (const g of ghost) {
      const r = retired.get(g);
      if (r?.to) console.log(`   \`${g}\` 已被取代 → 把期望改成 \`${r.to}\``);
      else if (r) console.log(`   \`${g}\` 状态是 ${r.status}（文件在 ${r.rel}）→ 删掉这条期望或指向继任者`);
      else console.log(`   期望的 id 根本不存在: \`${g}\``);
    }
    continue;
  }
  if (missing.length) {
    fail++;
    console.log(`❌ ${c.q}`);
    console.log(`   期望命中: ${c.want.join(', ')}`);
    console.log(`   实际命中: ${top.length ? top.join(', ') : '（无）'}`);
    console.log(`   → 给 ${missing.join(', ')} 的 answers 加上这个问法`);
  } else {
    console.log(`✅ ${c.q}  →  ${top.slice(0, 3).join(', ')}${top.length > 3 ? ` +${top.length - 3}` : ''}`);
  }
}
// 孤儿检测：没有任何 answers 的条目，只能靠目录结构撞见
const orphans = entries.filter(e => !(e.data.answers || []).length);
console.log(`\n${fail ? '❌' : '✅'} ${cases.length - fail}/${cases.length} 通过`);
if (orphans.length) console.log(`⚠️  ${orphans.length} 条未声明 answers，只能靠目录结构被撞见`);
process.exit(fail ? 1 : 0);
