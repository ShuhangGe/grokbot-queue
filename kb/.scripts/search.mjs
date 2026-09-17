#!/usr/bin/env node
// 跨库检索：给一句话，在所有已登记的库里找该读哪几条。
//
// ★ 零模型。只用【已固化进 front-matter 的结构化数据】（answers / tags / title）——
//   因为真实的 agent 读到的就是这些，而评分逻辑与 retrieval-test 共用 lib 里的
//   同一份 route()：测试守的必须正是这里实际在走的那条路由。
//
// ★ 它是 agent 的【工具】，不是替代品：用它快速定位，然后自己去读原文。
//
// 用法：
//   node search.mjs "稳定币结算成本"
//   node search.mjs "…" --json        机器可读
//   node search.mjs "…" --all         连已被取代/归档的也列出来
import { route, freshness, today, stateIcon } from './lib.mjs';
import { loadRegistry, readAll, reportProblems, collectEntries } from './central.mjs';

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
// ★ 把所有非 flag 参数合起来。只取第一个的话，忘了加引号的
//   `search 稳定币 结算成本` 会静默地只搜「稳定币」—— 而且不吭一声。
const words = argv.filter(a => !a.startsWith('--'));
const q = words.join(' ');
if (words.length > 1) console.error(`（合并为一句检索：「${q}」。下次记得加引号。）`);

if (!q) {
  console.error('用法：node search.mjs "<问题>" [--json] [--all]');
  process.exit(1);
}

const NOW = today();
const reg = loadRegistry();
if (!reg.projects.length) {
  console.error('❌ 登记表为空。先 mindlink adopt <目录>... --yes 把项目接进来。');
  process.exit(1);
}

const rows = readAll(reg.projects, NOW);
const ok = rows.filter(r => !r.err);

// 去重与归属的规则住在 central，与 digest 共用一份 —— 复制出去会各自漂移。
const items = collectEntries(rows).map(({ e, lib, via, layer }) => {
  const d = e.data;
  return {
    qid: e.qid, lib, via, layer,
    answers: d.answers, tags: d.tags, title: d.title,
    summary: d.summary, status: d.status, superseded_by: d.superseded_by,
    // ★ 现场重算，不抄 index.json 里 build 时冻结的 freshness
    f: freshness(e, NOW),
  };
});

const all = route(q, items);
const live = all.filter(h => !['superseded', 'archived'].includes(h.status));
const dead = all.filter(h => ['superseded', 'archived'].includes(h.status));
const hits = has('all') ? all : live;

if (has('json')) {
  console.log(JSON.stringify({
    query: q, at: NOW, libraries: ok.length,
    hits: hits.map(h => ({
      qid: h.qid, lib: h.lib, layer: h.layer, via: h.via, score: h.score, why: h.why,
      title: h.title, summary: h.summary,
      freshness: h.f.state, overdue_days: h.f.overdueDays,
      status: h.status, superseded_by: h.superseded_by || null,
    })),
  }, null, 2));
  // ★ 警告必须走 stderr。跟在 JSON 文档后面打进 stdout 的话，
  //   任何 JSON.parse 都会失败 —— 而机器可读模式的全部意义就是能被解析。
  process.exit(reportProblems(rows, console.error) ? 2 : 0);
}

const W = (s, n) => {
  const w = [...String(s ?? '')].reduce((a, c) => a + (/[一-龥]/.test(c) ? 2 : 1), 0);
  return String(s ?? '') + ' '.repeat(Math.max(1, n - w));
};

console.log(`\n🔎 「${q}」 · ${ok.length} 个库 · 命中 ${hits.length} 条\n`);

if (!hits.length && dead.length) {
  // ★ 知识其实存在，只是被取代了。这时说「确实没有记录过，去查证」
  //   等于把人支去做一遍重复劳动。
  console.log(`命中的 ${dead.length} 条都【已被取代或归档】—— 知识存在，只是这条不再是权威版本。`);
  console.log('先看继任者：');
  for (const h of dead) console.log(`   ${h.lib}/${h.qid}${h.superseded_by ? ` → ${h.superseded_by}` : '（已归档，无继任者）'}`);
  console.log('');
  console.log('若继任者的 answers 没写上这个问法，补上它 —— 否则下次还是找不到。');
} else if (!hits.length) {
  console.log('没有条目声明自己能回答这个问题。');
  console.log('');
  console.log('两种可能，处理方式完全不同：');
  console.log('  ① 确实没有记录过 —— 那就去查证，然后 /ml new 写下来');
  console.log('  ② 记录过，但那条的 answers 没写上这个问法');
  console.log('     ★ 后者正是 retrieval-test 存在的理由：被完美维护、却没人找得到');
  console.log('       的知识价值为零。补上 answers，并把这个问法加进 retrieval.expect。');
} else {
  for (const h of hits) {
    // ★ 新鲜度必须显示。不标的话会拿一条过期答案当新的用 —— 那比查不到更糟。
    const mark = ['superseded', 'archived'].includes(h.status) ? '🚫' : stateIcon(h.f);
    const age = h.f.state === 'overdue' ? `逾期 ${h.f.overdueDays} 天` : '';
    console.log(`${String(h.score).padStart(4)}  ${W(h.lib, 14)}${W(h.qid, 40)}${mark} ${age}`);
    if (h.summary) console.log(`      ${W('', 14)}${h.summary}`);
    // ★ 不用 ANSI 转义：这份输出的主要读者是【读终端输出的 agent】，
    //   转义序列对它只是噪音，管道/捕获时还会污染内容。
    console.log(`      ${W('', 14)}└ ${h.why}${h.superseded_by ? ` · 已被 ${h.superseded_by} 取代` : ''}`
      + (h.via ? `（经 ${h.via} 看到；该层未单独登记）` : ''));
  }
}

// ★ 命中了已被取代的条目却不说，等于把一个死答案递出去。
if (!has('all') && dead.length && hits.length) {
  console.log(`\n🚫 另有 ${dead.length} 条命中已被取代或归档，未列出（--all 可看）：`);
  for (const h of dead) console.log(`   ${h.lib}/${h.qid}${h.superseded_by ? ` → ${h.superseded_by}` : ''}`);
}

const badCount = reportProblems(rows);
console.log('');
process.exit(badCount ? 2 : 0);
