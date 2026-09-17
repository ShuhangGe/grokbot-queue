#!/usr/bin/env node
// 中央视图：一条命令看到所有已注册知识库的健康度。
//
// ★ 本脚本【零模型】。index.json 已经是机器可读产物，这里只做遍历 + 聚合。
//   ROADMAP 的判断在这里被证实：「哪些过期了、哪些地基松了、有多少开放问题」
//   不是 agent 的活，是脚本的活。中央「agent」的大部分工作其实是中央「脚本」。
//
// 用法：
//   node status.mjs --all              汇总所有已注册的库
//   node status.mjs --register [路径]  把一个库登记进来（默认当前 KB_ROOT）
//   node status.mjs --unregister <名>  取消登记
//   node status.mjs --list             只列出登记表
import { existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { KB_ROOT, LAYERS, resolveRef, projectDirOf, wireStateOf, WIRE_FILES, readLayerMarker } from './lib.mjs';
import { REGISTRY, loadRegistry, saveRegistry, readAll, reportProblems } from './central.mjs';

const argv = process.argv.slice(2);
// ★ 下一个参数若本身是 flag，说明这个 flag【没带值】—— 不能把它当成值。
//   （promote.mjs 的 code review 刚指出过同一个坑：`--to shared` 缺位置参数时
//    会把 "shared" 当成 id。同类错误换个脚本又犯了一次，所以写成共用的形状。）
const flag = (k) => {
  const i = argv.indexOf('--' + k);
  if (i === -1) return null;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? null : v;
};
const has = (k) => argv.includes('--' + k);

// ★ 模式必须互斥。cli.mjs 会把子命令映射成 flag 再拼上用户给的参数，
//   于是 `mindlink status --register` 变成 `--all --register` —— 而下面按
//   顺序检查的话，一个【读】命令就执行了【写】。
const MODES = ['all', 'suggest', 'register', 'unregister', 'list'].filter(has);
if (MODES.length > 1) {
  console.error(`❌ 这些是互斥的模式，一次只能给一个：${MODES.map(m => '--' + m).join(' ')}`);
  process.exit(1);
}

// ── 登记 / 取消登记 ─────────────────────────────────────────
// ★ 登记表由命令【生成】，不手写。手写清单一定会腐化 —— 这是本项目反复
//   踩到的同一件事（ROADMAP 第 7 节旧稿、CLAUDE.md 的条目计数、变异用例锚点）。
if (has('register')) {
  const root = resolve(flag('register') || KB_ROOT);
  if (!existsSync(root)) { console.error(`❌ 路径不存在：${root}`); process.exit(1); }
  // ★ 必须确认它真是个知识库。KB_ROOT 的最后兜底是【脚本自己所在的仓库】，
  //   所以在一个没有 kb/ 的目录里裸跑 --register 会把 mindlink 仓库本身
  //   登记进去，从此永远显示「未构建」并把 --all 钉在退出码 2。
  if (!existsSync(join(root, 'facts')) && !existsSync(join(root, 'judgments'))) {
    console.error(`❌ 不是知识库目录（缺 facts/ 与 judgments/）：${root}`);
    console.error(`   在项目里跑，或用 --register <路径> 指明。`);
    process.exit(1);
  }
  const r = loadRegistry();
  const name = flag('name') || basename(dirname(root) === root ? root : dirname(root));
  const declared0 = readLayerMarker(root).layer;
  if (r.projects.some(p => resolve(p.root) === root)) {
    // ★ 早于「登记表记层」这个功能登记的中央层，再跑一次 register 也要把层位置补上 ——
    //   否则它永远停在「已登记过」，而项目照样看不见它。
    if (declared0 && declared0 !== 'project' && !(r.layers && resolve(r.layers[declared0] || '') === root)) {
      r.layers = r.layers || {};
      const prev = r.layers[declared0];
      if (prev && resolve(prev) !== root && !has('force')) { console.error(`❌ ${declared0} 层已经有一个根了：${prev}（--force 可换）`); process.exit(1); }
      r.layers[declared0] = root; saveRegistry(r);
      console.log(`✅ 已登记过：${root}\n   补记为 ${declared0} 层的位置 —— 所有项目从此零配置看到它`);
      process.exit(0);
    }
    console.log(`✅ 已登记过：${root}`);
    process.exit(0);
  }
  if (r.projects.some(p => p.name === name)) {
    console.error(`❌ 名字 "${name}" 已被占用：${r.projects.find(p => p.name === name).root}`);
    console.error(`   用 --name <别的名字> 重试。`);
    process.exit(1);
  }
  r.projects.push({ name, root, registered_at: new Date().toISOString().slice(0, 10) });
  r.projects.sort((a, b) => a.name.localeCompare(b.name));
  // ★ 自称 shared / portfolio 的库同时记为【层的位置】。从此这台机器上任何 session
  //   零配置看到它 —— 此前只有环境变量，而用户的 shell 里根本没设。
  const declared = readLayerMarker(root).layer;
  if (declared && declared !== 'project') {
    r.layers = r.layers || {};
    const prev = r.layers[declared];
    if (prev && resolve(prev) !== root && !has('force')) {
      console.error(`❌ ${declared} 层已经有一个根了：${prev}`);
      console.error(`   同一层不能有两个根（限定 id 会撞键）。确认要换的话加 --force。`);
      process.exit(1);
    }
    r.layers[declared] = root;
  }
  saveRegistry(r);
  console.log(`✅ 已登记 ${name} → ${root}`);
  if (declared && declared !== 'project') console.log(`   并记为 ${declared} 层的位置 —— 所有项目从此零配置看到它`);
  console.log(`   登记表：${REGISTRY}`);
  process.exit(0);
}

if (has('unregister')) {
  const name = flag('unregister');
  if (!name) { console.error('❌ --unregister 需要一个名字。用 --list 看有哪些。'); process.exit(1); }
  const r = loadRegistry();
  const n = r.projects.length;
  const gone = r.projects.find(p => p.name === name);
  r.projects = r.projects.filter(p => p.name !== name);
  if (r.projects.length === n) { console.error(`❌ 没有登记过 "${name}"`); process.exit(1); }
  // 它若是某一层的位置，一并撤掉 —— 留着会让每个项目的 build 去读一个不存在的根
  for (const [l, p] of Object.entries(r.layers || {})) if (resolve(p) === resolve(gone.root)) delete r.layers[l];
  saveRegistry(r);
  console.log(`✅ 已取消登记 ${name}`);
  process.exit(0);
}

const reg = loadRegistry();
if (has('list')) {
  if (!reg.projects.length) console.log('（登记表为空。用 --register 添加）');
  for (const p of reg.projects) console.log(`${p.name}\t${p.root}\t${p.registered_at}`);
  const ls = Object.entries(reg.layers || {});
  if (ls.length) { console.log(''); for (const [l, p] of ls) console.log(`层 ${l}\t${p}`); }
  process.exit(0);
}

if (!has('all') && !has('suggest')) {
  console.error('用法：node status.mjs --all | --suggest | --register [路径] | --unregister <名> | --list');
  process.exit(1);
}

// ── 聚合 ────────────────────────────────────────────────────
if (!reg.projects.length) {
  console.log(`\n（登记表为空：${REGISTRY}）`);
  console.log(`在某个项目里跑 node kb/.scripts/status.mjs --register 把它登记进来。\n`);
  process.exit(0);
}

const rows = readAll(reg.projects);

const ok = rows.filter(r => !r.err);
const bad = rows.filter(r => r.err);
const order = (r) => LAYERS.indexOf(r.layer);
ok.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));

const SHOW_TABLE = has('all');
const W = (s, n) => { const w = [...String(s)].reduce((a, c) => a + (/[一-龥]/.test(c) ? 2 : 1), 0); return String(s) + ' '.repeat(Math.max(1, n - w)); };
if (SHOW_TABLE) {
  console.log('');
  console.log(W('库', 16) + W('层', 12) + W('条目', 6) + W('过期', 6) + W('地基松动', 10) + W('开放问题', 10) + W('路由', 8) + '索引生成于');
  console.log('─'.repeat(82));
  let lastLayer = null;
  for (const r of ok) {
    if (lastLayer !== null && r.layer !== lastLayer) console.log('─'.repeat(82));
    lastLayer = r.layer;
    // 地基松动只对有判断的库有意义；一条判断都没有时显示 — 而不是 0，
    // 免得看起来像「检查过了，很健康」。
    const shaky = r.judgments ? String(r.shaky) : '—';
    // ★ 路由块：一个建好的 kb 若没写进 agent 的入口文件，对 agent 就是隐形的。
    //   实测五个库里三个处于这个状态。它不影响数字，但影响【数字有没有人看】，
    //   所以放在同一张表里 —— 中央 agent 看健康度时顺带就看到了。
    //   中央层也算：agent 会直接在共享层的主题文件夹里开 session 做调研。
    const wired = (() => {
      const { dir, kbRel } = projectDirOf(r.root);
      const st = WIRE_FILES.map(f => wireStateOf(join(dir, f), kbRel, r.layer));
      return st.every(x => x === 'ok') ? '✅' : st.every(x => x === 'missing') ? '❌ 缺' : st.includes('missing') ? '◐ 缺一' : '⚠️ 过时';
    })();
    console.log(W(r.name, 16) + W(r.layer, 12) + W(r.live.length, 6) + W(r.overdue || '·', 6)
      + W(shaky, 10) + W(r.open || '·', 10) + W(wired, 8) + r.at + (r.drift ? `  ⚠️ ${r.drift}` : ''));
  }

  const sum = (k) => ok.reduce((n, r) => n + (k === 'live' ? r.live.length : r[k]), 0);
  console.log('─'.repeat(82));
  console.log(W('合计', 16) + W('', 12) + W(sum('live'), 6) + W(sum('overdue') || '·', 6)
    + W(sum('shaky') || '·', 10) + W(sum('open') || '·', 10));
  const unwired = ok.some(r =>
    !WIRE_FILES.every(f => wireStateOf(join(projectDirOf(r.root).dir, f), projectDirOf(r.root).kbRel, r.layer) === 'ok'));
  if (unwired) console.log(`\n路由列非 ✅ 的库，agent 看不见或看到的是旧规则 —— 到那个项目跑 mindlink wire <目录>`);
}

// ── --suggest：跨库线索 ─────────────────────────────────────
// ★ 这里只产出【候选】，绝不自动动手 —— 铁律 1：agent 只起草，人确认。
//   而且刻意只做【结构性】判断：哪些条目在结构上可以晋升、哪个问题被两个库
//   分别作答。真正的语义判断（这两条结论是不是互相矛盾、三个项目是不是卡在
//   同一个供应商问题上）不在这里做 —— 那需要模型，而模型只在写入与复核时介入。
//
// ★ 为什么先做这一半：Phase 4 的触发条件（前三阶段跑一段时间）根本没到，
//   现在做「跨项目模式发现」只能靠猜。但 promote 在上一轮做出来之后，
//   没有任何东西告诉你【该晋升什么】—— 能力被实现却无法被发现，
//   正是这个项目自己的教训（保鲜 ≠ 可发现）。
if (has('suggest')) {
  // 结构上可晋升：项目层 + 类型/目录本就属于共享层 + 不依赖任何项目层条目。
  // 「可复用性与领域普适性相关」这个判断是语义的，所以这里只筛【结构】，
  // 最终该不该上去由人（或写入时的模型）决定。
  // ★ 主题文件夹（如 agent/）不在这个正则里，但里面的 fact / reference 同样可能
  //   对别的项目成立。规则改成「fact 或 reference，且不是 entity、判断、决策」——
  //   entity 是本项目相关主体的信息，天然项目专属。
  const SHARED_DIRS = /^(reference\/|facts\/(market|regulation|vendor)\/)/;
  const PROJECT_ONLY = /^(facts\/entity\/|judgments\/|decisions\/)/;
  const cands = [];
  const answerMap = new Map();
  const allIds = new Map();   // 裸 id → 出现在哪些库（覆盖全部本层条目）

  for (const r of ok) {
    // ★ 用 central 已经读好的条目，不再自己重读 index.json ——
    //   重读一遍就是第二份「怎么读一个库」的逻辑，两份必然漂移。
    for (const x of r.all.map(e => e.data)) {
      if (x.layer !== r.layer) continue;                       // 只看本库自己的条目
      if (['superseded', 'archived'].includes(x.status)) continue;
      // ★ qid 可能是 null：build 刻意容忍缺 id 的条目（validate 会报，但 build
      //   必须先跑得动）。别处都用 .filter(x => x.qid) 挡着，这里漏了就会
      //   在 bare() 里对 null 调 replace，吐一脸堆栈。
      if (!x.qid) continue;
      // ★ 重复统计要覆盖【全部本层条目】，不能只统计候选：只要有一份因为
      //   目录或依赖不合格而落选，剩下那份就不会被标成重复，
      //   「promote 只搬一条」的警告也跟着消失 —— 而那正是最需要它的时候。
      const b0 = x.qid.replace(/^@[a-z]+\//, '');
      if (!allIds.has(b0)) allIds.set(b0, new Set());
      allIds.get(b0).add(r.name);
      for (const a of x.answers || []) {
        const k = String(a).trim();
        if (!k) continue;
        if (!answerMap.has(k)) answerMap.set(k, []);
        answerMap.get(k).push({ lib: r.name, qid: x.qid });
      }
      if (r.layer !== 'project') continue;                     // 已经在上层的不用晋升
      if (!(x.type === 'reference' || SHARED_DIRS.test(x.rel || '')
          || (x.type === 'fact' && !PROJECT_ONLY.test(x.rel || '')))) continue;
      // ★ 必须连 related 一起查。validate 对 depends_on 与 related 一视同仁，
      //   promote 也是 —— 只查 depends_on 的话，这里会把 promote 转头就拒绝的
      //   条目当成候选推荐给你。
      const downward = [...(x.depends_on || []), ...(x.related || [])]
        .map(ref => resolveRef(ref, x.layer))
        .filter(q => !q.startsWith('@'));                       // 无前缀 = 项目层
      if (downward.length) continue;                            // 依赖还在下层，搬不上去
      cands.push({ lib: r.name, qid: x.qid, type: x.type, rel: x.rel, title: x.title });
    }
  }

  console.log('★ 以下全是【候选】，需要人判断。本命令不会动任何文件。\n');

  console.log(`── 结构上可晋升到共享层  ${cands.length} 条 ──`);
  if (!cands.length) console.log('  （无）');
  else {
    // 同一个裸 id 在多个库出现 = 重复知识，晋升信号最强，排前面
    const bare = (q) => String(q).replace(/^@[a-z]+\//, '');
    const dup = allIds;
    cands.sort((a, b) => (dup.get(bare(b.qid))?.size || 1) - (dup.get(bare(a.qid))?.size || 1));
    for (const c of cands) {
      const n = dup.get(bare(c.qid))?.size || 1;
      console.log(`  ${c.lib}/${c.qid}  \`${c.type}\`  ${c.title || ''}`
        + (n > 1 ? `\n     ★ 同名条目在 ${n} 个库里都有 —— 重复知识，最该上去` : ''));
    }
    console.log(`\n  晋升（★ 必须在候选【所在的那个库】里跑）：`);
    console.log(`     node kb/.scripts/promote.mjs <id> --to shared --owner <人>`);
    // ★ 排在最前的候选恰恰是「同名出现在多个库」的那些 —— 裸 id 会按当前库解析，
    //   在别的库里粘贴这条命令会【悄悄搬走那个库的同名条目】，而且不会报错。
    console.log(`     裸 id 按当前库解析：在别的库里跑会悄悄搬走那个库的同名条目，且不报错。`);
    if (cands.some(c => (dup.get(bare(c.qid))?.size || 1) > 1)) {
      // ★ 必须说清楚：promote 只搬【一条】。多个库各有一份时，搬完剩下的那些
      //   仍然存在、而且【不会有任何校验报错】—— 它们是各自项目层的合法条目。
      //   不写这一行，输出就等于暗示 promote 解决了重复，而它没有。
      console.log(`  ⚠️ promote 只搬一条。多个库各有一份时，搬完之后其余那些仍然存在，`);
      console.log(`     且不会有任何校验报错 —— 要手工删掉它们，并把引用改指 @shared/<id>。`);
    }
  }

  const clash = [...answerMap.entries()]
    .map(([q, hits]) => ({ q, hits, libs: new Set(hits.map(h => h.lib)) }))
    .filter(x => x.libs.size > 1);
  console.log(`\n── 同一个问题被多个库分别作答  ${clash.length} 个 ──`);
  console.log('  可能是重复知识，也可能是互相矛盾 —— 哪一种，只有读了才知道。');
  if (!clash.length) console.log('  （无）');
  else for (const c of clash) {
    console.log(`  「${c.q}」`);
    for (const h of c.hits) console.log(`     ${h.lib}/${h.qid}`);
  }

  console.log(`\n★ 没做的：跨项目模式发现、语义上的矛盾判定。那些需要模型，`);
  console.log(`  而模型只在【写入】与【复核】时介入 —— 这条路径跑在 cron 里，那里没有模型。\n`);
}

reportProblems(rows);

process.exit(bad.length ? 2 : 0);
