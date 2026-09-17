#!/usr/bin/env node
// 勘察台账：记下项目里每份文档的去向 —— 进了 kb，还是不进（以及为什么）。
//
// ★ 为什么需要它：build-index 每次都扫一遍项目文档，没有决定的会挂在 STALE.md
//   「未处理的文档」里。多数文档【不该进 kb】（规格、流程、设计稿），但「不进」
//   也是一个决定，得记下来 —— 否则同一份文档每周都被重新看一遍。
// ★ 台账入 git：「跳过，因为是规格文档」是团队知识，换台机器也该知道。
// ★ 「进了 kb」不用在这里记 —— new.mjs --from 会自动记，条目的 derived_from 是权威。
//
// 用法：
//   node survey.mjs --skip <path>[,<path>] --why "为什么不进"
//   node survey.mjs --unskip <path>          撤销（文档回到未处理）
//   node survey.mjs --list                   台账 + 未处理的文档
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, relative, sep, join } from 'node:path';
import { KB_ROOT, projectDirOf, loadSurvey, withSurveyLock, surveyOf, fileHash, loadEntries, today, DOC_SKIP, walkProjectDocs } from './lib.mjs';

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const flag = (k) => { const i = argv.indexOf('--' + k); const v = argv[i + 1]; return i === -1 || v === undefined || v.startsWith('--') ? null : v; };

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const PROJECT_DIR = real(projectDirOf(KB_ROOT).dir);
const toRel = (raw) => {
  const abs = real(isAbsolute(raw) ? raw : resolve(process.cwd(), raw));
  const rel = relative(PROJECT_DIR, abs).split(sep).join('/');
  if (rel.startsWith('..')) { console.error(`❌ 不在项目里：${raw}`); process.exit(1); }
  return { rel, abs };
};

if (has('skip')) {
  const why = flag('why');
  // ★ 理由必填。「不进」的价值全在理由里 —— 下次有人（或 agent）看到这份文档，
  //   要能立刻知道当时为什么不进、现在情况变没变。没理由的跳过等于没跳过。
  if (!why) { console.error('❌ --skip 必须带 --why：下一个看到这份文档的人要靠它知道为什么不进。'); process.exit(1); }
  let paths = (flag('skip') || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!paths.length) { console.error('用法：node survey.mjs --skip <path|glob>[,<…>] --why "…"'); process.exit(1); }
  // ★ glob（* ** ?）：在【扫描器看得见的文档】里展开，决定仍是逐份的，只是记录可以批量。
  //   一个 probe 一份 FINDINGS 的项目，未处理队列天然上百（用户反馈 fb-fe0f）。
  //   只在真实文档里匹配 —— 免得 glob 把依赖目录里的东西也扫进来。
  if (paths.some(p => /[*?]/.test(p))) {
    const docs = walkProjectDocs(PROJECT_DIR, KB_ROOT).map(abs => relative(PROJECT_DIR, real(abs)).split(sep).join('/'));
    const toRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?') + '$');
    const expanded = [];
    for (const p of paths) {
      if (!/[*?]/.test(p)) { expanded.push(p); continue; }
      const re = toRe(p); const hit = docs.filter(d => re.test(d));
      if (!hit.length) { console.error(`❌ ${p} 没匹配到任何文档（只在扫描器看得见的文档里匹配）`); process.exit(1); }
      console.log(`   ${p} → ${hit.length} 份`);
      expanded.push(...hit);
    }
    paths = [...new Set(expanded)];
  }
  // 先把要记的算好（找不到就报错退出），再在锁里一次写入
  const recs = []; let ignored = 0;
  for (const raw of paths) {
    const { rel, abs } = toRel(raw);
    // ★ 扫描器本来就不看的路径（.venv、node_modules…）不进台账 —— 记了也永远不会被
    //   对比，只是把台账撑成一堆依赖包的 README。实测一次 find 喂进来 60 份。
    if (rel.split('/').some(seg => DOC_SKIP.has(seg))) { ignored++; continue; }
    const hash = fileHash(abs);
    if (hash === null) { console.error(`❌ 找不到：${raw}`); process.exit(1); }
    recs.push({ rel, hash });
  }
  withSurveyLock(KB_ROOT, (sv) => { for (const r of recs) sv.docs[r.rel] = { hash: r.hash, decision: 'skip', why, at: today() }; });
  for (const r of recs) console.log(`✅ 不进 kb：${r.rel}  —— ${why}`);
  if (ignored) console.log(`   （${ignored} 份在依赖/产物目录里，扫描器本来就不看，没记）`);
  console.log('   已记入 kb/.survey.json。文档以后改了会低优先级提一句「之前跳过的改了」。');
  process.exit(0);
}

if (has('unskip')) {
  const { rel } = toRel(flag('unskip') || '');
  const had = withSurveyLock(KB_ROOT, (sv) => { const h = !!sv.docs[rel]; delete sv.docs[rel]; return h; });
  if (!had) { console.error(`❌ 台账里没有 ${rel}`); process.exit(1); }
  console.log(`✅ 已撤销：${rel} 回到「未处理」`);
  process.exit(0);
}

if (has('list') || !argv.length) {
  const entries = loadEntries().filter(e => e.root === KB_ROOT);
  const { unprocessed, changedSkipped } = surveyOf(KB_ROOT, PROJECT_DIR, entries);
  const ledger = loadSurvey(KB_ROOT).docs;
  const skipped = Object.entries(ledger).filter(([, r]) => r.decision === 'skip');
  const inKb = Object.entries(ledger).filter(([, r]) => String(r.decision).startsWith('entry:'));
  console.log(`\n项目文档去向 · 未处理 ${unprocessed.length} · 进了 kb ${inKb.length} · 不进 ${skipped.length}${changedSkipped.length ? ` · 之前不进但后来改过 ${changedSkipped.length}` : ''}\n`);
  if (unprocessed.length) {
    console.log('── 未处理（还没人决定）──');
    for (const d of unprocessed) console.log(`  ${d.rel}`);
    console.log('  进 → new.mjs --from <path> · 不进 → survey.mjs --skip <path> --why "…"\n');
  }
  if (changedSkipped.length) {
    console.log('── 之前不进、后来改过 ──');
    for (const d of changedSkipped) console.log(`  ${d.rel}  ← 当时理由：${d.why || '（未写）'}`);
    console.log('');
  }
  if (inKb.length) { console.log('── 进了 kb ──'); for (const [p, r] of inKb) console.log(`  ${p}  → ${r.decision.slice(6)}`); console.log(''); }
  if (skipped.length) { console.log('── 不进 ──'); for (const [p, r] of skipped) console.log(`  ${p}  —— ${r.why}（${r.at}）`); console.log(''); }
  if (!unprocessed.length && !changedSkipped.length) console.log('✅ 每份文档都有去向。\n');
  process.exit(0);
}

console.error('用法：node survey.mjs --skip <path>[,<path>] --why "…" | --unskip <path> | --list');
process.exit(1);
