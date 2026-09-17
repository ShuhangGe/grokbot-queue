#!/usr/bin/env node
// 新建条目脚手架。保证 front-matter 合规。
//   交互：  node kb/.scripts/new.mjs
//   直出：  node kb/.scripts/new.mjs --type fact --id fact-xxx --title "标题" --volatility high [--dir facts/market]
//   取代：  node kb/.scripts/new.mjs --supersedes <旧id> [...]
//   一步：  node kb/.scripts/new.mjs … --answers "问法1,问法2" --tags a,b --depends-on x,y --related z
//           --sources "https://…|T1,https://…|T2" --body-file 正文.md
//   或：    node kb/.scripts/new.mjs --spec 条目.json   （所有字段一次给齐，agent 起草用）
//
// ★ 为什么要有 --spec / 列表 flag：agent 非交互起草时所有字段一次就有，原来只能
//   「先建骨架再改 front-matter」两步（用户反馈 fb-b11e）。
import { writeFileSync, existsSync, readFileSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { KB_ROOT, ROOTS, OWNER_REQUIRED_LAYERS, loadEntries, today, assertNoDateOverride, TYPES, VOLATILITY, DOMAINS,
         stringifyFrontmatter, parseFrontmatter, projectDirOf, fileHash, withSurveyLock } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };

function usage(code) {
  const out = code ? console.error : console.log;
  out(`用法：
  交互    node kb/.scripts/new.mjs
  直出    node kb/.scripts/new.mjs --type <${TYPES.join('|')}> --id <slug> --title "…" --summary "…"
                                   --volatility <${VOLATILITY.join('|')}> [--domain ${DOMAINS.join('|')}] [--dir 目录]
                                   [--from docs/a.md,docs/b.md] [--owner 人] [--effective-at 日期] [--wake-at 日期]
  一步    …加 --answers "问法1,问法2" --tags a,b --depends-on x,y --related z
             --sources "https://…|T1,https://…|T2" --body-file 正文.md
  取代    node kb/.scripts/new.mjs --supersedes <旧id> [其余同上]
  规格    node kb/.scripts/new.mjs --spec 条目.json    （所有字段一次给齐；键与 front-matter 同名，body 为正文）

  列表字段用逗号分隔；sources 每项 url|tier。--spec 与命令行同时给时命令行优先。`);
  process.exit(code);
}
if (argv.includes('--help') || argv.includes('-h')) usage(0);

// ★ --spec：一份 JSON 把所有字段给齐
let spec = {};
if (arg('spec')) {
  try { spec = JSON.parse(readFileSync(arg('spec'), 'utf8')); }
  catch (e) { console.error(`❌ --spec 读不了：${e.message}`); process.exit(1); }
}
const fromSpec = (k) => spec[k];
const list = (k) => { const v = arg(k); if (v !== undefined) return String(v).split(',').map(x => x.trim()).filter(Boolean); const s = fromSpec(k.replace(/-/g, '_')); return Array.isArray(s) ? s : undefined; };

const DEFAULT_DIR = { fact: 'facts', judgment: 'judgments', reference: 'reference', decision: 'facts' };

let type = arg('type', fromSpec('type')), id = arg('id', fromSpec('id')), title = arg('title', fromSpec('title')), volatility = arg('volatility', fromSpec('volatility'));
let dir = arg('dir', fromSpec('dir')), summary = arg('summary', fromSpec('summary')), supersedes = arg('supersedes', fromSpec('supersedes'));
let domain = arg('domain', fromSpec('domain')), effectiveAt = arg('effective-at', fromSpec('effective_at')), eventAt = arg('event-at', fromSpec('event_at')), wakeAtArg = arg('wake-at', fromSpec('wake_at'));
let owner = arg('owner', fromSpec('owner'));
const answersArg = list('answers'), tagsArg = list('tags'), dependsArg = list('depends-on'), relatedArg = list('related'), entitiesArg = list('entities');
const sourcesArg = (() => { const v = arg('sources'); if (v !== undefined) return String(v).split(',').map(x => x.trim()).filter(Boolean).map(x => { const [url, tier] = x.split('|'); return { url, ...(tier ? { tier } : {}) }; }); return Array.isArray(spec.sources) ? spec.sources : undefined; })();
const bodyArg = arg('body-file') ? readFileSync(arg('body-file'), 'utf8') : (typeof spec.body === 'string' ? spec.body : undefined);
const confidenceArg = arg('confidence', fromSpec('confidence'));
const openQArg = Array.isArray(spec.open_questions) ? spec.open_questions : undefined;
// ★ --from：这条是从哪份文档提炼的。记下指纹，原文改了 build-index 会标「出处已变动」。
//   没有它，条目和原文之间连指针都没有 —— 实测 crypto 60 条里 0 条有本地出处。
const fromArg = arg('from');

// ★ 继任者会被写进【KB_ROOT 所在的那一层】。守卫必须拿它比，不能写死 'project' ——
//   层身份内在化之后，共享层的 owner 单独维护自己的库时 KB_ROOT 就是 shared 层，
//   写死 'project' 会把他自己的同层 supersede 也拦掉，而 supersede 正是
//   「事实变了」的法定流程：那等于让共享层再也无法记录变化。
const OWN_LAYER = ROOTS().find(r => r.root === KB_ROOT)?.layer || 'project';

// ★ 上层必须写 owner。在【问卷之前】拦 —— 放在后面的话，用户答完八个问题
//   才被告知缺参数，所有答案一起丢掉。
if (OWNER_REQUIRED_LAYERS.includes(OWN_LAYER) && !owner) {
  console.error(`❌ 在 ${OWN_LAYER} 层建条目必须指定 --owner（谁负责复核它）。`);
  console.error(`   上层被多个项目共享：没有 owner，下游看到「地基松动」也不知道该找谁。`);
  process.exit(1);
}

const entries = loadEntries();
const byId = new Map(entries.filter(e => e.qid).map(e => [e.qid, e]));

// ★ 在任何 today() 之前拦住：本脚本会把它写进 asserted_at
assertNoDateOverride('new.mjs');

let old = null;
if (supersedes) {
  old = byId.get(supersedes);
  if (!old) { console.error(`❌ 找不到 id "${supersedes}"`); process.exit(1); }
  // ★ 本命令只会把继任者写进【项目层】。若被取代者住在上层，落盘后会在上层
  //   留下一个指向下层的 superseded_by —— 依赖必须向上，这是反向的；而且
  //   别的项目单独加载上层时会因找不到该 id 而校验失败，那条上层事实就此
  //   对所有人作废却没有可见的继任者。跨层取代要在该层自己的库里做。
  if (old.layer !== OWN_LAYER) {
    console.error(`❌ 拒绝执行：${supersedes} 住在【${old.layer}】层，而继任者会写进【${OWN_LAYER}】层。`);
    console.error(`   那会在上层留下指向下层的 superseded_by（依赖方向必须向上），`);
    console.error(`   并让其他项目加载上层时校验失败。`);
    console.error(`   请把 MINDLINK_KB 指向 ${old.root} 后再执行，或等 promote 支持跨层晋升。`);
    process.exit(1);
  }
  type ||= old.data.type;
  volatility ||= old.data.volatility;
  domain ||= old.data.domain;
  // ★ 时间锚点必须继承 —— 否则 supersede 会静默删掉硬闹钟，
  //   而 supersede 正是「事实变了」的法定流程，闹钟恰恰在此时最不该丢。
  eventAt ||= old.data.event_at;
  effectiveAt ||= old.data.effective_at;
  wakeAtArg ||= old.data.wake_at;
  dir ||= old.rel.split('/').slice(0, -1).join('/');
  title ||= old.data.title + '（更新）';
  id ||= `${old.data.id}-${today().replace(/-/g, '')}`;
}

if (!type || !id || !title || !volatility) {
  // ★ stdin 不是终端（agent、管道、CI）时不能进问卷 —— 它会等一个永远不来的输入。
  //   实测一个 agent 跑 `new.mjs --help` 挂了两分钟（当时还没有 --help）。
  if (!stdin.isTTY) { console.error('❌ 缺必填参数（type / id / title / volatility），且 stdin 不是终端，不进交互问卷。'); usage(1); }
  const rl = createInterface({ input: stdin, output: stdout });
  type ||= (await rl.question(`type (${TYPES.join('/')}): `)).trim();
  title ||= (await rl.question('title: ')).trim();
  id ||= (await rl.question(`id (建议 ${type}-短横线-slug): `)).trim();
  summary ||= (await rl.question('summary (一句话，进索引): ')).trim();
  volatility ||= (await rl.question(`volatility (${VOLATILITY.join('/')}) [medium]: `)).trim() || 'medium';
  domain ||= (await rl.question(`domain (${DOMAINS.join('/')}) [business]: `)).trim() || 'business';
  effectiveAt ||= (await rl.question('effective_at 生效日 (YYYY-MM-DD，没有就回车): ')).trim() || undefined;
  dir ||= (await rl.question(`目录 [${DEFAULT_DIR[type] || 'facts'}]: `)).trim() || (DEFAULT_DIR[type] || 'facts');
  // 项目层可选；上层在问卷之前就已经拦掉了缺 owner 的情况
  owner ||= (await rl.question('owner 谁负责复核（可留空）: ')).trim() || undefined;
  rl.close();
}
dir ||= DEFAULT_DIR[type] || 'facts';
summary ||= title;

// ★ id/title 不能为空：空 id 会生成 "<dir>/.md"，而 extname('.md') === ''，
//   walk() 永远扫不到它 —— 文件存在但 validate 和 build 都看不见。
if (!id || !String(id).trim()) { console.error('❌ id 不能为空'); process.exit(1); }
if (!title || !String(title).trim()) { console.error('❌ title 不能为空'); process.exit(1); }
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { console.error(`❌ id "${id}" 应为小写短横线 slug`); process.exit(1); }
if (!TYPES.includes(type)) { console.error(`❌ type 必须是 ${TYPES.join('|')}`); process.exit(1); }
if (!VOLATILITY.includes(volatility)) { console.error(`❌ volatility 必须是 ${VOLATILITY.join('|')}`); process.exit(1); }
domain ||= 'business';
if (!DOMAINS.includes(domain)) { console.error(`❌ domain 必须是 ${DOMAINS.join('|')}`); process.exit(1); }
if (byId.has(id)) { console.error(`❌ id "${id}" 已存在：${byId.get(id).rel}`); process.exit(1); }

// 出处：路径相对【项目根】（入口文件所在的目录），不是相对 kb
// ★ 两边都 realpath：cwd 是解析过符号链接的，MINDLINK_KB 多半不是 ——
//   macOS 上 /var → /private/var 就会算出 ../../..，把项目里的文件判成「不在项目里」。
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const PROJECT_DIR = real(projectDirOf(KB_ROOT).dir);
const derivedFrom = [];
for (const raw of (fromArg || '').split(',').map(x => x.trim()).filter(Boolean)) {
  const abs = real(isAbsolute(raw) ? raw : resolve(process.cwd(), raw));
  const rel = relative(PROJECT_DIR, abs).split(sep).join('/');
  if (rel.startsWith('..')) { console.error(`❌ --from 必须在项目里：${raw}`); process.exit(1); }
  const hash = fileHash(abs);
  if (hash === null) { console.error(`❌ --from 找不到：${raw}`); process.exit(1); }
  derivedFrom.push({ path: rel, hash });
}

const data = {
  id, type, title, summary,
  asserted_at: today(),
  ...(eventAt ? { event_at: eventAt } : {}),
  ...(effectiveAt ? { effective_at: effectiveAt } : {}),
  ...(wakeAtArg ? { wake_at: wakeAtArg } : {}),
  volatility,
  domain,
  tags: tagsArg ?? (old ? (old.data.tags || []) : []),
  entities: entitiesArg ?? (old ? (old.data.entities || []) : []),
  confidence: confidenceArg || 'medium',
  status: 'active',
  ...(owner ? { owner } : {}),
  sources: sourcesArg ?? [],
  ...(derivedFrom.length ? { derived_from: derivedFrom } : {}),
  depends_on: dependsArg ?? (type === 'judgment' ? (old ? old.data.depends_on || [] : []) : []),
  related: relatedArg ?? (old ? (old.data.related || []) : []),
  // ★ answers 必须继承：CLAUDE.md 把路由表定为【无条件必读的第一入口】，
  //   不继承的话，supersede 会把这条静默移出所有 agent 的入口。
  answers: answersArg ?? (old ? (old.data.answers || []) : []),
  open_questions: openQArg ?? [],
  reviews: [],
  supersedes: supersedes || null,
  superseded_by: null,
};

const body = bodyArg !== undefined ? (bodyArg.trim() + '\n') : old
  ? `## 变更内容\n\n<!-- 相比 ${supersedes} 变了什么、为什么 -->\n\n## 正文\n\n<!-- 新的完整内容 -->\n`
  : type === 'judgment'
    ? `## 判断\n\n<!-- 结论 -->\n\n## 依据\n\n<!-- 引用 depends_on 里的事实 id -->\n\n## 什么条件下这个判断会失效\n\n<!-- ★ 必填：让未来的人知道何时该推翻它 -->\n<!-- ★ 同时把可验证的那几条填进 front-matter 的 open_questions，\n     并标 answerable_by: internal|research|expert，它们会汇总进 OPEN.md -->\n`
    : `## 正文\n\n`;

const path = join(KB_ROOT, dir, `${id}.md`);
if (existsSync(path)) { console.error(`❌ 文件已存在：${path}`); process.exit(1); }
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, stringifyFrontmatter(data, body));
console.log(`✅ 已创建 ${dir}/${id}.md`);
// 台账：这几份文档的去向是「进了 kb」。以后它们改了走出处指纹那条路，不再算未处理。
if (derivedFrom.length) {
  // ★ 在锁里读改写：并行起草时不加锁会互相抹掉记录
  try {
    withSurveyLock(KB_ROOT, (sv) => { for (const d of derivedFrom) sv.docs[d.path] = { hash: d.hash, decision: `entry:${id}`, at: today() }; });
  } catch (e) {
    // ★ 台账没记上就把刚写的条目撤掉 —— 「条目在、台账没有」正是用户报过的半截状态
    try { unlinkSync(path); } catch {}
    console.error(`❌ ${e.message}\n   已撤掉刚创建的 ${dir}/${id}.md，请重试。`);
    process.exit(1);
  }
  console.log(`   出处 ${derivedFrom.map(d => d.path).join(', ')} 已记入台账`);
}

if (old) {
  const raw = readFileSync(old.path, 'utf8');
  const { data: od, body: ob } = parseFrontmatter(raw);
  od.superseded_by = id;
  od.status = 'superseded';
  writeFileSync(old.path, stringifyFrontmatter(od, ob));
  console.log(`✅ 已把 ${supersedes} 标记为 superseded → ${id}`);
  const dependents = entries.filter(e => e.depsQ.includes(supersedes));
  if (dependents.length) {
    console.log(`\n⚠️  ${dependents.length} 条判断依赖被取代的事实，需要重新评估：`);
    dependents.forEach(d => console.log(`   · ${d.data.id}  (${d.rel})`));
  }
}
console.log(`\n下一步：编辑该文件，然后 node kb/.scripts/build-index.mjs`);
