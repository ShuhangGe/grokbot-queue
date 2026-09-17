#!/usr/bin/env node
// 把一条知识【晋升】到更上层，并改写所有指向它的引用。
//
// ★ 晋升不是 supersede。
//   supersede 表达「世界变了，这条取代那条」—— 两条内容不同，都要保留，
//   因为「我们当时为什么那么想」有价值。
//   晋升表达「知识没变，只是换了住处」—— 同一条内容，换个地方存放，
//   因为它对别的项目也成立。
//   把晋升做成 supersede 会在上层留下一个指向【下层】的链接：依赖方向反了，
//   而且别的项目单独加载上层时找不到那个 id，那条知识对所有人作废。
//
// 用法：
//   node promote.mjs <id> --to shared [--owner <谁负责复核>]   预演，只打印计划
//   node promote.mjs <id> --to shared --owner 市场组 --yes      真正执行
//   --drop-related     摘掉指向下层的 related（「另见」不是地基，可以摘）
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import {
  loadEntries, parseFrontmatter, stringifyFrontmatter, resolveRef, qidOf,
  locOf, ownerOf, checkDirection, ROOTS, LAYERS, OWNER_REQUIRED_LAYERS, KB_ROOT,
  assertNoDateOverride,
} from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf('--' + k); return i === -1 ? null : argv[i + 1]; };
const has = (k) => argv.includes('--' + k);

// ★ 必须跳过【带值的 flag 的值】。原来的写法在缺位置参数时会把 --to 的值
//   当成 id，于是 `promote --to shared` 报「找不到 id "shared"」而不是用法 ——
//   更糟的是万一真有条目叫 shared，它会去搬错的东西。
const VALUE_FLAGS = new Set(['to', 'owner']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (VALUE_FLAGS.has(a.slice(2))) i++; continue; }
  positional.push(a);
}
const id = positional[0];
const to = flag('to');
const newOwner = flag('owner');
const doIt = has('yes');

if (!id || !to) {
  console.error('用法：node promote.mjs <id> --to <shared|portfolio> [--owner <人>] [--yes] [--drop-related]');
  console.error('      不带 --yes 时只打印计划，不动任何文件。');
  process.exit(1);
}
assertNoDateOverride('promote.mjs');

if (!LAYERS.includes(to)) {
  console.error(`❌ "${to}" 不是合法层名（${LAYERS.join(' | ')}）`);
  process.exit(1);
}
const target = ROOTS().find(r => r.layer === to);
if (!target) {
  console.error(`❌ ${to} 层未加载。已加载：${ROOTS().map(r => r.layer).join(', ')}`);
  console.error(`   晋升要把文件【搬进】那一层，所以必须先指向它。`);
  process.exit(1);
}

const entries = loadEntries();
const byId = new Map(entries.filter(e => e.qid).map(e => [e.qid, e]));
// 允许用裸 id 或限定 id 指定；裸 id 按当前 KB_ROOT 所在层解析
const ownLayer = ROOTS().find(r => r.root === KB_ROOT)?.layer || 'project';
const oldQid = byId.has(id) ? id : resolveRef(id, ownLayer);
const e = byId.get(oldQid);
if (!e) { console.error(`❌ 找不到 id "${id}"`); process.exit(1); }

// ── 前置检查 ────────────────────────────────────────────────
const fail = (m, ...rest) => { console.error(`❌ ${m}`); rest.forEach(r => console.error(`   ${r}`)); process.exit(1); };

if (e.layer === to) fail(`${oldQid} 已经在 ${to} 层了`);
if (LAYERS.indexOf(to) > LAYERS.indexOf(e.layer))
  fail(`${oldQid} 在 ${e.layer} 层，不能「晋升」到更下面的 ${to} 层`,
       `依赖只能向上：${LAYERS.join(' ← ')}`);

// ★ 搬上去之后，它原有的依赖必须仍然合法（只能指向 to 层或更上层）。
//   否则晋升本身就会造出一条向下的依赖 —— 正是方向校验要禁止的东西。
// ★ 必须连 related 一起查，不能只查 depends_on。validate 对两者都做方向校验，
//   而 related 里的裸引用在搬家之后会按【新层】重新解析 —— 漏查的话 promote
//   会成功、然后 validate 立刻失败，而文件已经动了、没有回滚。
const layerOfRef = (ref) => {
  const q = resolveRef(ref, e.layer);
  const t = byId.get(q);
  return t ? t.layer : (q.startsWith('@') ? q.slice(1).split('/')[0] : e.layer);
};
const bad = [
  ...(e.data.depends_on || []).map(r => ['depends_on', r]),
  ...(e.data.related || []).map(r => ['related', r]),
].map(([k, r]) => ({ k, r, layer: layerOfRef(r) }))
 .filter(({ layer }) => checkDirection(to, layer));

// ★ depends_on 向下是【结构性】的坏：地基不可达，那条知识对别的项目直接作废。
//   而 related 只是「另见」—— 真实语料里凡是有价值的事实都有 related 链接，
//   一律拒绝的话 promote 在真实语料上几乎不可用（实测：crypto 和 dry_clearn
//   两侧的候选全部因此被拒）。
//   所以：默认仍然拒绝，但给一个【显式】开关把它们摘掉，并把摘掉了什么报出来。
//   静默丢弃不行，静默拒绝也不行 —— 要么让人知道摘了什么，要么让人知道为什么不能搬。
const badDeps = bad.filter(x => x.k === 'depends_on');
const badRelated = bad.filter(x => x.k === 'related');
// ★ 摘不摘只判断【一次】。原来打印块查 has('drop-related')、执行块只查
//   badRelated.length —— 两个不同的判断驱动「说了什么」和「做了什么」，
//   一旦有人放宽上面那道拒绝，就会出现「没说要摘、却真的摘了」。
//   同一个 dropSet 既决定计划里怎么写，也决定文件里怎么改。
const dropSet = new Set(has('drop-related') ? badRelated.map(x => String(x.r)) : []);
if (!badDeps.length && badRelated.length && !has('drop-related')) fail(
  `${oldQid} 的 related 指向下层，搬上去会造出向下的引用：`,
  ...badRelated.map(({ r, layer }) => `related: ${r}（${layer} 层）`),
  `related 只是「另见」，不是地基。确认可以摘掉的话加 --drop-related；`,
  `想保留这层关联的话，把它们也一起晋升上去。`);
if (badDeps.length) fail(
  `${oldQid} 依赖了不能一起上去的条目，晋升会造出向下的依赖：`,
  ...badDeps.map(({ k, r, layer }) => `${k}: ${r}（${layer} 层）`),
  `depends_on 是地基，不能摘 —— 先把这些依赖也晋升上去。`);

const newQid = qidOf(to, e.data.id);
if (byId.has(newQid)) fail(`${to} 层已经有 ${newQid} 了`, byId.get(newQid).path);

const dest = join(target.root, e.rel);
if (existsSync(dest)) fail(`目标文件已存在：${dest}`);

const owner = newOwner || ownerOf(e);
if (OWNER_REQUIRED_LAYERS.includes(to) && !owner) fail(
  `${to} 层必须有 owner，而 ${oldQid} 没有`,
  `加 --owner <谁负责复核> 重试。上层被多个项目共享：没有 owner，`,
  `下游看到「地基松动」也不知道该找谁。`);

// ── 谁引用了它 ──────────────────────────────────────────────
const REF_ARRAYS = ['depends_on', 'related'];
const REF_SCALARS = ['supersedes', 'superseded_by'];
const referrers = entries.filter(x => x !== e && [
  ...REF_ARRAYS.flatMap(k => x.data[k] || []),
  ...REF_SCALARS.map(k => x.data[k]).filter(Boolean),
].some(r => resolveRef(r, x.layer) === oldQid));

// ★ supersede 必须同层。引用者若通过 supersede 指向它，晋升会把那条链拉成跨层 ——
//   拒绝，而不是搬完再让 validate 报错。
const supersedeRefs = referrers.filter(x =>
  REF_SCALARS.some(k => x.data[k] && resolveRef(x.data[k], x.layer) === oldQid));
if (supersedeRefs.length) fail(
  `${oldQid} 被 supersede 链引用，晋升会把那条链拉成跨层：`,
  ...supersedeRefs.map(x => `${locOf(x)}`),
  `supersede 只能同层。先处理那条取代关系。`);

// ── 计划 ────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`晋升  ${oldQid}  →  ${newQid}`);
console.log('═'.repeat(60));
console.log(`文件      ${relative(process.cwd(), e.path)}`);
console.log(`      →   ${relative(process.cwd(), dest)}`);
console.log(`层        ${e.layer} → ${to}`);
if (OWNER_REQUIRED_LAYERS.includes(to))
  console.log(`owner     ${owner}${newOwner && newOwner !== ownerOf(e) ? '（本次设定）' : ''}`);
if (dropSet.size) {
  console.log(`\n将摘掉 ${dropSet.size} 条指向下层的 related（它们是「另见」，不是地基）：`);
  for (const { r, layer } of badRelated) console.log(`  ${r}（${layer} 层）`);
}
console.log(`\n要改写的引用  ${referrers.length} 处`);
for (const x of referrers) console.log(`  ${locOf(x)}`);
if (!referrers.length) console.log('  （无）');

console.log(`\n★ 这是【移动】不是取代：内容不变，不产生 supersede 链。`);
console.log(`  取代关系表达「世界变了」，晋升表达「知识没变，只是换了住处」。`);

if (!doIt) {
  console.log(`\n预演结束，什么都没动。确认无误后加 --yes 执行。\n`);
  process.exit(0);
}

// ── 执行 ────────────────────────────────────────────────────
// ★ 全程可回滚。原来这里只是把源文件改名成 .promoted-away，注释还写着
//   「成功后再删，避免半途失败丢文件」—— 而没有任何东西会还原它。
//   实测中途失败（引用文件只读）的结果是：原始堆栈糊脸、孤儿 .promoted-away
//   （walk 只认 .md，任何脚本都看不见它）、引用改了一半、再跑一次报
//   「找不到 id」。注释在撒谎比没有注释更糟。
const undo = [];
const backup = e.path + '.promoted-away';
try {
  // 1) 搬文件（顺带写入 owner）
  const { data, body } = parseFrontmatter(readFileSync(e.path, 'utf8'));
  if (OWNER_REQUIRED_LAYERS.includes(to)) data.owner = owner;
  if (dropSet.size) {
    data.related = (data.related || []).filter(r => !dropSet.has(String(r)));
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, stringifyFrontmatter(data, body));
  undo.push(() => unlinkSync(dest));
  renameSync(e.path, backup);
  undo.push(() => renameSync(backup, e.path));

  // 2) 改写 front-matter 里的引用
  var touched = 0;
  for (const x of referrers) {
    const before = readFileSync(x.path, 'utf8');
    const { data: xd, body: xb } = parseFrontmatter(before);
    let changed = false;
    for (const k of REF_ARRAYS) {
      if (!Array.isArray(xd[k])) continue;
      const next = xd[k].map(r => (resolveRef(r, x.layer) === oldQid ? newQid : r));
      if (next.some((v, i) => v !== xd[k][i])) { xd[k] = next; changed = true; }
    }
    if (!changed) continue;
    writeFileSync(x.path, stringifyFrontmatter(xd, xb));
    undo.push(() => writeFileSync(x.path, before));
    touched++;
  }

  // 3) 改写 retrieval.expect 里的 id
  // ★ 它不在 front-matter 里，但 retrieval-test 按【限定 id】比对，而且
  //   pre-commit 会跑它 —— 漏改的话，promote 之后的第一次提交就被挡住，
  //   报的还是「期望的 id 根本不存在」，把人引去找一条被删掉的条目。
  var expects = 0;
  for (const { layer, root } of ROOTS()) {
    const f = join(root, 'retrieval.expect');
    if (!existsSync(f)) continue;
    const before = readFileSync(f, 'utf8');
    const after = before.split('\n').map(line => {
      if (line.trimStart().startsWith('#') || !line.includes('=>')) return line;
      const [q, rhs] = line.split(/=>(.*)/s);
      const ids = rhs.split(',').map(t => {
        const [, pre, val, post] = /^(\s*)(.*?)(\s*)$/.exec(t);
        return resolveRef(val, layer) === oldQid ? pre + newQid + post : t;
      });
      return q + '=>' + ids.join(',');
    }).join('\n');
    if (after === before) continue;
    writeFileSync(f, after);
    undo.push(() => writeFileSync(f, before));
    expects++;
  }

  // 4) 成功，删掉备份
  unlinkSync(backup);
} catch (err) {
  for (const f of undo.reverse()) { try { f(); } catch { /* 尽力而为 */ } }
  console.error(`\n❌ 晋升失败，已回滚：${err.message}`);
  console.error(`   工作区应已恢复原样。若 ${backup} 仍然存在，把它改回 ${e.path}。`);
  process.exit(1);
}

console.log(`\n✅ 已晋升 ${oldQid} → ${newQid}`);
console.log(`   改写了 ${touched} 个条目的引用` + (expects ? ` · ${expects} 个 retrieval.expect` : ''));
console.log(`\n下一步：`);
console.log(`  node kb/.scripts/validate.mjs`);
console.log(`  node kb/.scripts/retrieval-test.mjs`);
console.log(`  node kb/.scripts/build-index.mjs --all-layers`);
console.log(`  ⚠️ 上层现在多了一条 —— 记得把它提交到【上层那个仓库】里。\n`);
