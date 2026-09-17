// kb/.scripts/lib.mjs —— 零依赖共享库
import { readdirSync, statSync, lstatSync, readFileSync, writeFileSync, renameSync, existsSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, basename, extname, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

/** 解析知识库根目录，按优先级：
 *   1. MINDLINK_KB 环境变量（显式指定）
 *   2. 脚本自身所在的知识库（若存在）—— 防止在别的项目里跑本项目脚本时对错语料
 *   3. 从 cwd 逐级向上找 kb/ 目录（脚本全局安装时走这条）
 *  这样脚本既能住在项目里，也能被全局安装后指向任意项目。 */
function resolveKbRoot() {
  if (process.env.MINDLINK_KB) return resolve(process.env.MINDLINK_KB);
  // ★ 脚本自身所在的知识库优先于 cwd —— 否则在【别的】含 kb/ 的项目里
  //   执行本项目的脚本，会对着错误的语料自信地报「✅ 没有过期」。
  const own = fileURLToPath(new URL('..', import.meta.url));
  if (existsSync(join(own, 'facts')) || existsSync(join(own, 'judgments'))) return own;
  let dir = process.cwd();
  for (;;) {
    const cand = join(dir, 'kb');
    if (existsSync(join(cand, 'facts')) || existsSync(join(cand, 'judgments'))) return cand;
    if (basename(dir) === 'kb' && (existsSync(join(dir, 'facts')) || existsSync(join(dir, 'judgments')))) return dir;
    // ★ 库根就是目录本身（中央层：shared/ portfolio/）。在 shared/agent/ 里开 session，
    //   不认这个的话会一路向上找不到，最后落到 mindlink 仓库根 —— 对着错误的语料干活。
    //   判据与 cli 一致：库自己的标记。
    if ((existsSync(join(dir, '.mindlink-layer')) || existsSync(join(dir, '.scripts')))
        && (existsSync(join(dir, 'facts')) || existsSync(join(dir, 'judgments')))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return fileURLToPath(new URL('..', import.meta.url));
}

export const KB_ROOT = resolveKbRoot();

// ─────────────────────────────────────────────────────────────
// 分层（Phase 2）
// ─────────────────────────────────────────────────────────────
/** 层的顺序即依赖方向：依赖只能【向上】—— project → portfolio → shared。
 *  这把「分层不是网状」从口头约定变成可校验的结构（方向校验见 Step 3）。 */
export const LAYERS = ['shared', 'portfolio', 'project'];

const isKbDir = d => existsSync(join(d, 'facts')) || existsSync(join(d, 'judgments'));

/** 层身份标记文件。内容是一个层名，例如 `shared`。
 *  ★ 为什么需要它：没有标记时，层身份取决于【哪个环境变量指向了这个目录】——
 *    共享层的 owner 把 MINDLINK_KB 指向自己的库（正是他该做的事），
 *    脚本就把它当成 project 层：owner 不再必填、qid 不再带前缀、
 *    方向校验也失去了参照。同一份语料换个打开方式就换了一套规则。
 *    身份必须是【内在的】，写在库里，而不是由调用方的环境决定。
 *  没有标记 = project 层（绝大多数项目如此，零配置）。 */
export const LAYER_MARKER = '.mindlink-layer';
/** 软读取：返回 { layer, error }，绝不退出进程。
 *  ★ 中央视图要遍历很多个库，其中一个坏掉不能把整张表打没 ——
 *    它的全部价值就在于「全都看到」。所以那里需要一个能把错误【当成数据】
 *    返回的入口，而单项目脚本仍然应该硬失败。 */
export function readLayerMarker(root) {
  const f = join(root, LAYER_MARKER);
  if (!existsSync(f)) return { layer: null, error: null };
  let v;
  try { v = readFileSync(f, 'utf8').trim(); }
  catch (e) { return { layer: null, error: `读不了 ${f}：${e.message}` }; }
  if (!LAYERS.includes(v)) return { layer: null, error: `${f} 内容 "${v}" 不是合法层名（${LAYERS.join(' | ')}）` };
  return { layer: v, error: null };
}

export function declaredLayer(root) {
  const { layer, error } = readLayerMarker(root);
  if (error) { console.error(`❌ ${error}`); process.exit(1); }
  return layer;
}

/** 解析所有启用的层，返回 [{ layer, root }]，按 LAYERS 顺序（共享在前）。
 *
 *  ★ 上层只认【显式环境变量】，没有 `~/knowledge` 之类的约定默认值。
 *    约定默认会造成最难查的一类分歧：开发机上碰巧存在 ~/knowledge 于是被
 *    悄悄纳入构建，CI 上不存在于是没有 —— 同一份语料两种产物，而且谁都
 *    不会想到去看环境。等 promote 真正造出共享层时再引入约定，并让
 *    build 打印实际加载的层，使它可见而非隐形。
 *
 *  ★ 项目层永远存在 —— 单层项目零配置照跑，这是不可回退的底线。 */
// ★ 登记表住 ~/.mindlink/：它不只记项目，也记【层的位置】。
//   此前上层只从环境变量来，而用户的 shell 里没设 —— 于是任何一个没手动 export 的
//   session 都看不见共享层：INDEX 里没有 @shared、promote 报「未加载」、
//   depends_on 上层的条目让 validate 失败、pre-commit 挂掉。
//   「其它 session 都能用这些知识」靠的是这一条：登记一次，这台机器上零配置可见。
export const REGISTRY = process.env.MINDLINK_REGISTRY
  || join(process.env.HOME || homedir(), '.mindlink', 'projects.json');
/** 只读登记表里的层位置；坏掉时静默当作没有 —— 修复路径在 central.loadRegistry，那里会吵。 */
export function registeredLayers() {
  try {
    const j = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    const l = (j && j.layers) || {};
    return Object.fromEntries(Object.entries(l).filter(([k, v]) => LAYERS.includes(k) && typeof v === 'string'));
  } catch { return {}; }
}

export function resolveRoots() {
  const out = [];
  // ★ MINDLINK_LAYERS=none：不要登记表里的层。登记表记层之后，这台机器上【任何】build 都会
  //   加载真实上层 —— 包括 mindlink 仓库自己的 examples/：它的 INDEX 被灌进 88 条真实的 @shared，
  //   还被提交了一次。示例、CI、测试这类要求确定性的构建必须能显式退出。
  const fromReg = process.env.MINDLINK_LAYERS === 'none' ? {} : registeredLayers();
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  for (const [layer, env] of [['shared', 'MINDLINK_SHARED'], ['portfolio', 'MINDLINK_PORTFOLIO']]) {
    // 环境变量是覆盖（测试 / CI 用），登记表是默认
    const v = process.env[env] || fromReg[layer];
    if (!v) continue;
    const root = resolve(v);
    // ★ KB_ROOT 自己就是这一层时不重复加载 —— 在 shared/ 里开 session，登记表又说
    //   shared 在这儿，不去重会撞上「同一层被两个根声称」。
    if (real(root) === real(KB_ROOT)) continue;
    if (!existsSync(root)) {
      // 登记表里的路径失效不该让每个项目的 build 都崩 —— 说一句，跳过
      if (!process.env[env]) { console.error(`⚠️  登记表里 ${layer} 层的路径不存在，已跳过：${root}（mindlink register 重新登记）`); continue; }
    }
    if (!isKbDir(root)) {
      console.error(`❌ ${env}="${v}" 不是知识库目录（缺 facts/ 与 judgments/）。`);
      process.exit(1);
    }
    // 环境变量与库自称的身份不一致 → 一定是配错了，早报早好
    const declared = declaredLayer(root);
    if (declared && declared !== layer) {
      console.error(`❌ ${env} 指向的库自称是 "${declared}" 层，但被当作 "${layer}" 层加载。`);
      console.error(`   见 ${join(root, LAYER_MARKER)}`);
      process.exit(1);
    }
    out.push({ layer, root });
  }
  // ★ KB_ROOT 的层由它【自己】声明；没声明才默认 project。
  out.push({ layer: declaredLayer(KB_ROOT) || 'project', root: KB_ROOT });

  // ★ 同一个层不得被两个根声称。层身份内在化之前这是不可能的（KB_ROOT 恒为
  //   project），现在则可能：MINDLINK_SHARED 指向一份拷贝、而 MINDLINK_KB
  //   指向原库。后果是同一批 qid 撞键、条目在产物里出现两次、其中一份的链接
  //   还逃出本层 —— 而重叠守卫只查【包含】，查不到平级重复。
  const seen = new Map();
  for (const { layer, root } of out) {
    if (seen.has(layer)) {
      console.error(`❌ 层 "${layer}" 被两个不同的根声称：`);
      console.error(`   ${seen.get(layer)}`);
      console.error(`   ${root}`);
      console.error(`   同一批限定 id 会撞键，条目在产物里出现两次。`);
      process.exit(1);
    }
    seen.set(layer, root);
  }

  // ★ 根之间不得重叠。把项目 kb 放在共享库目录下是很自然的布局，
  //   而 walk() 会把同一批文件走【两遍】：条目数凭空翻倍、条目和自己
  //   报「id 重复」、还会冒出莫名其妙的「depends_on 指向不存在的 id」。
  //   这些症状指向的位置全是错的，排查成本极高 —— 必须在入口拦掉。
  const covers = (a, b) => b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
  for (const x of out) for (const y of out) {
    if (x === y || !covers(x.root, y.root)) continue;
    console.error(`❌ 知识库根目录重叠：${y.layer} 层在 ${x.layer} 层里面。`);
    console.error(`   ${x.layer}: ${x.root}`);
    console.error(`   ${y.layer}: ${y.root}`);
    console.error(`   同一批文件会被加载两遍，产生虚假的「id 重复」与「引用不存在」。`);
    process.exit(1);
  }
  return out;
}

// ★ 懒求值。原来是模块级 `export const ROOTS = resolveRoots()`，于是【任何】
//   import 本模块的脚本都会在启动时解析层根 —— 而 resolveRoots 遇到坏环境会
//   直接 process.exit。后果：中央视图（它跟单项目的层配置毫无关系）只要环境里
//   有个失效的 MINDLINK_SHARED 就跑不起来。而中央视图恰恰是「东西配坏了」
//   时你会去拿的那个工具。
let _roots = null;
export const ROOTS = () => (_roots ??= resolveRoots());

// ─────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────
export const TYPES = ['fact', 'judgment', 'reference', 'decision'];
export const VOLATILITY = ['high', 'medium', 'low', 'static'];
export const CONFIDENCE = ['high', 'medium', 'low'];
export const STATUS = ['active', 'stale', 'superseded', 'archived', 'draft'];
export const TIERS = ['T1', 'T2', 'T3'];
export const DOMAINS = ['business', 'tech', 'both'];
export const ANSWERABLE = ['internal', 'research', 'expert'];

export const REQUIRED = ['id', 'type', 'title', 'summary', 'asserted_at', 'volatility'];

/** 时间字段：asserted_at 必填；其余可选。
 *  asserted_at   我们【核实】的日期 —— 新鲜度基准
 *  event_at      事件【实际发生】的日期 —— 仅用于叙述/排序
 *  effective_at  内容【开始生效】的日期 —— 决定 pending 状态，并自动推导 wake_at
 *  wake_at       硬闹钟，这天之前必须重看 —— 覆盖 volatility 周期 */
export const DATE_FIELDS = ['asserted_at', 'event_at', 'effective_at', 'wake_at'];

/** effective_at 自动推导 wake_at 时，提前多少天 */
export const WAKE_LEAD_DAYS = 7;

/** volatility -> 复核周期（天）。static 表示不复核。 */
export const REVIEW_DAYS = { high: 30, medium: 90, low: 365, static: null };

// ─────────────────────────────────────────────────────────────
// YAML 子集解析（只支持本 schema 用到的结构）
//   scalar / inline array / block array / array-of-objects
// ─────────────────────────────────────────────────────────────
function indentOf(l) { return l.length - l.trimStart().length; }

function parseScalar(s) {
  s = String(s).trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^\[.*\]$/.test(s)) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    // 按逗号切分，跳过引号内的逗号（entities 里有 "POSX US, Inc" 这类值）。
    // ★ 只有位于【元素开头】的引号才算引号 —— 数引号个数是错的：
    //   [Moody's, S&P's] 有偶数个撇号，按计数法会被并成一个元素。
    const parts = []; let buf = '', q = null;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (q) { buf += ch; if (ch === q && inner[i - 1] !== '\\') q = null; }
      else if ((ch === '"' || ch === "'") && buf.trim() === '') { buf += ch; q = ch; }
      else if (ch === ',') { parts.push(buf); buf = ''; }
      else buf += ch;
    }
    parts.push(buf);
    return parts.map(parseScalar);
  }
  // ★ 必须反转义：dumpScalar 用 JSON.stringify 写出，这里不还原的话
  //   每写一次就多一层反斜杠，最终损坏数据。
  if (/^".*"$/.test(s)) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1).replace(/\\(.)/g, '$1'); }
  }
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** 剥离行尾注释：` # …`。
 *  ★ 必须做，因为我们文档里的 front-matter 模板大量使用行尾注释说明取值，
 *    照抄模板时若不剥离，注释文字会被当成值写进 summary / title。
 *  只在【引号外】剥离，故 URL 的 #anchor 和引号内的 # 都安全。 */
function stripTrailingComment(line) {
  // ★ 只有【标量开头】的引号才算引号。否则 BVNK's / Moody's 里的撇号
  //   会把扫描器切进「引号内」，注释永远剥不掉，污染值还会被 review.mjs 写回磁盘。
  const m = line.match(/^(\s*[\w-]+:\s*)(.*)$/);
  if (!m) return line;
  const [, head, rest] = m;
  const opener = (rest[0] === '"' || rest[0] === "'") ? rest[0] : null;
  let i = 0;
  if (opener) {                       // 跳过完整的引号标量
    for (i = 1; i < rest.length; i++) {
      if (rest[i] === '\\') { i++; continue; }
      if (rest[i] === opener) { i++; break; }
    }
  }
  // ★ 要求 # 前有【两个及以上空格】才算注释。
  //   YAML 规范里单个空格就够，但我们的值里有 "Order #123"、"Issue #42" 这类，
  //   按单空格切会把它们截断，而 review.mjs 重写后就是永久损坏。
  for (; i < rest.length; i++)
    if (rest[i] === '#' && i >= 2 && rest[i - 1] === ' ' && rest[i - 2] === ' ')
      return (head + rest.slice(0, i)).trimEnd();
  return line;
}

export function parseYamlSubset(text) {
  const lines = text.split('\n')
    .filter(l => l.trim() !== '' && !l.trim().startsWith('#'))
    .map(stripTrailingComment)
    .filter(l => l.trim() !== '');
  let idx = 0;

  function parseList(itemIndent) {
    const arr = [];
    while (idx < lines.length) {
      const line = lines[idx];
      const t = line.trim();
      if (indentOf(line) !== itemIndent || !t.startsWith('- ')) break;
      const rest = t.slice(2).trim();
      idx++;
      const kv = rest.match(/^([\w-]+):\s*(.*)$/);
      if (kv) {
        const o = { [kv[1]]: parseScalar(kv[2]) };
        while (idx < lines.length) {
          const l2 = lines[idx], t2 = l2.trim();
          if (indentOf(l2) <= itemIndent || t2.startsWith('- ')) break;
          const m2 = t2.match(/^([\w-]+):\s*(.*)$/);
          if (m2) o[m2[1]] = parseScalar(m2[2]);
          idx++;
        }
        arr.push(o);
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  }

  function parseMap(minIndent) {
    const obj = {};
    while (idx < lines.length) {
      const line = lines[idx];
      const ind = indentOf(line);
      const t = line.trim();
      if (ind < minIndent) break;
      if (t.startsWith('- ')) break;
      const m = t.match(/^([\w-]+):\s*(.*)$/);
      if (!m) { idx++; continue; }
      const [, key, rest] = m;
      idx++;
      // ★ 块标量（| 和 >）本解析器不支持。若放任不管，值会变成字面量 "|" / ">"，
      //   缩进的正文被丢弃，而 review.mjs 一旦重写就永久落盘 —— 静默丢数据。
      //   这里打标记，由 validate.mjs 硬报错。
      if (/^[|>][-+0-9]*\s*$/.test(rest)) { obj[key] = { __blockScalar: rest.trim() }; continue; }
      if (rest !== '') { obj[key] = parseScalar(rest); continue; }
      if (idx < lines.length && lines[idx].trim().startsWith('- ') && indentOf(lines[idx]) >= ind) {
        obj[key] = parseList(indentOf(lines[idx]));
      } else if (idx < lines.length && indentOf(lines[idx]) > ind) {
        obj[key] = parseMap(indentOf(lines[idx]));
      } else {
        obj[key] = null;
      }
    }
    return obj;
  }

  return parseMap(0);
}

export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: null, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: null, body: text };
  const raw = text.slice(text.indexOf('\n') + 1, end);
  const body = text.slice(end + 4).replace(/^\n/, '');
  return { data: parseYamlSubset(raw), body };
}

function dumpScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // 允许常见中文标点不加引号（YAML 只把 ASCII 的 ': ' 当分隔符，故这些都安全）
  return /^[\w一-鿿.\/:@+()（），、·—～：；？！《》…「」%$-]+$/.test(s) && !s.includes(': ') ? s : JSON.stringify(s);
}

export function stringifyFrontmatter(data, body) {
  const out = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      if (v.length === 0) { out.push(`${k}: []`); continue; }
      if (typeof v[0] === 'object' && v[0] !== null) {
        out.push(`${k}:`);
        for (const item of v) {
          const ks = Object.entries(item);
          out.push(`  - ${ks[0][0]}: ${dumpScalar(ks[0][1])}`);
          for (const [k2, v2] of ks.slice(1)) out.push(`    ${k2}: ${dumpScalar(v2)}`);
        }
      } else {
        out.push(`${k}: [${v.map(dumpScalar).join(', ')}]`);
      }
    } else {
      out.push(`${k}: ${dumpScalar(v)}`);
    }
  }
  out.push('---', '');
  return out.join('\n') + body.replace(/^\n*/, '');
}

// ─────────────────────────────────────────────────────────────
// 语料遍历
// ─────────────────────────────────────────────────────────────
// ★ feedback/ 里是 agent 对【这套工具】的意见，不是知识条目。不排掉的话
//   validate 会拿 fact 的 schema 去校验它们，每提一条意见就多一个「缺必填字段」。
// ★ research/ 里是调研报告：原始笔记、来源、过程，没有 front-matter。它们不是条目，
//   是条目的【出处】—— 走 derived_from 那条路。放进 SKIP_DIRS 才不会被 validate
//   拿 fact 的 schema 去校验。
const SKIP_DIRS = new Set(['.scripts', '_archive', 'node_modules', '.git', 'feedback', 'research']);
/** 不是知识条目的 markdown：自动生成物 + 仓库文档 */
// ★ 入口文件也不是条目：中央层现在会被接线，CLAUDE.md / AGENTS.md 直接躺在库根 ——
//   不排掉的话 validate 报「@portfolio/CLAUDE.md 缺少 front-matter」，本层条目数虚增 2。
// ★ 推广成规则：【全大写文件名】不是条目。条目 id 一律小写 kebab（fact-… judgment-…），
//   而 README / INDEX / STALE / CLAUDE / WATCHLIST 这类全是大写 —— 逐个点名永远点不全
//   （实测用户在主题文件夹根放了一份 WATCHLIST.md，validate 就报「缺少 front-matter」）。
const NON_ENTRY = /^[A-Z][A-Z0-9_.-]*\.md$/;
// kb 自己的产物与说明：既不是条目、也不算「项目文档」。其余全大写文件（NOTES.md、WATCHLIST.md）
// 不是条目，【但是文档】—— 它们该进勘察台账，由人决定进不进。
// ★ 新增产物时必须同时加进这里。漏了的话它会被当成「项目文档」进勘察台账，
//   docs 计数虚高，连带 STALE 的「未处理的文档」一节和四个分层用例一起失败
//   —— ROUTE.md 加入时实测如此。这就是上面那句「逐个点名永远点不全」的再次应验。
const KB_OWN = /^(ROUTE|INDEX|STALE|GRAPH|OPEN|README)\.md$/;

// ── .kbignore：随库走的排除规则 ─────────────────────────────
// ★ 为什么需要它：DOC_SKIP / SKIP_DIRS 写死在脚本里，用户想排除自己的 research/daily/、
//   experiments/ 只能改分发出去的 lib.mjs —— 下一次 upgrade 就被覆盖（实测已经丢过一次三处改动）。
//   定制必须落在【随库走的文件】里，不落在脚本里。
// 语法：每行一个模式，# 注释。
//   name          不带斜杠：匹配任意层级里叫这个名字的目录或文件
//   a/b/**  a/*.md  带斜杠：相对【被扫描的根】（条目遍历 = kb 根；文档扫描 = 项目根），支持 * ** ?
export const KBIGNORE = '.kbignore';
const globToRe = (pat) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?(?:[^/]*)?') + '$');
export function loadKbIgnore(kbRoot) {
  const f = kbRoot ? join(kbRoot, KBIGNORE) : null;
  const names = new Set(), globs = [];
  if (f && existsSync(f)) {
    for (const raw of readFileSync(f, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const pat = line.replace(/\/$/, '');
      if (pat.includes('/')) globs.push(globToRe(pat)); else names.add(pat);
    }
  }
  const test = (rel, name) => names.has(name) || globs.some(re => re.test(rel));
  test.empty = !names.size && !globs.length;
  return test;
}

export function walk(dir = KB_ROOT, acc = [], root = dir, ignore = loadKbIgnore(root)) {
  for (const name of readdirSync(dir)) {
    // ★ 隐藏目录一律不是知识：.git .scripts .venv .claude，以及用户放进主题文件夹的
    //   .repos（clone 的外部仓库）、.watch（自己的工具）。实测 .repos 里 5800 份 README 被当成
    //   条目，每个项目的 validate 被几千条「缺必填字段」淹没。逐个点名永远点不全。
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (ignore(relative(root, p).split(sep).join('/'), name)) continue;   // .kbignore
    if (statSync(p).isDirectory()) walk(p, acc, root, ignore);
    else if (extname(p) === '.md' && !NON_ENTRY.test(name)) acc.push(p);
  }
  return acc;
}

/** 本 schema 里必须是数组的字段。
 *  ★ 若被写成标量，for..of 会逐【字符】迭代，静默产出垃圾而不报错 ——
 *    比直接崩溃更糟。统一在加载时归一化，并让 validate 报出来。 */
export const ARRAY_FIELDS = ['tags', 'entities', 'sources', 'depends_on', 'related', 'open_questions', 'reviews', 'answers', 'derived_from'];

/** 加载所有层的条目。单层时与改造前逐字节等价。 */
/** 限定 id：条目在【全库】范围内的唯一标识。
 *  项目层用裸 id（与改造前一致，单层项目零影响）；上层带 @layer/ 前缀。
 *
 *  ★ 前缀【推导】而非写进 front-matter：
 *    写进去会与文件位置冗余（同一事实两处真相），移动/晋升条目就得手改 id，
 *    还会破坏现有「id == 文件名」规则 —— 而文件名放不下 `/`。
 *    推导则让晋升时前缀自动跟着走。
 *  ★ 引用侧必须写全（depends_on: [@shared/xxx]）：这是方向校验的依据，
 *    也让读者在引用处一眼看出目标住在哪一层。 */
export const qidOf = (layer, id) =>
  id == null ? null : (layer === 'project' ? String(id) : `@${layer}/${id}`);

/** 从引用串里拆出层名。
 *  ★ 无前缀 = 【引用者所在的层】，不是项目层。
 *    这让每一层都能被【单独加载并自洽】：共享层内部互相引用写裸 id 即可，
 *    共享层的 owner 把 MINDLINK_KB 指向它就能独立跑 validate / build。
 *    若把无前缀定义成「项目层」，共享层条目就必须自己写 @shared/ 前缀，
 *    而单独加载时那个前缀反而解析不了 —— 上层永远无法自治。 */
export function parseRef(ref, fromLayer = 'project') {
  const m = /^@([a-z]+)\/(.+)$/.exec(String(ref));
  return m ? { layer: m[1], id: m[2] } : { layer: fromLayer, id: String(ref) };
}

/** 把引用串规范成限定 id（相对于引用者所在层）。 */
export function resolveRef(ref, fromLayer) {
  const { layer, id } = parseRef(ref, fromLayer);
  return qidOf(layer, id);
}

/** 依赖方向校验：层只能依赖【自己或更上层】。
 *  LAYERS = [shared, portfolio, project]，下标越小越上层。
 *
 *  ★ 为什么必须机器强制：上层被多个项目共享，一旦它反向依赖某个项目，
 *    别的项目单独加载上层时会因找不到该 id 而校验失败 —— 那条上层知识
 *    对所有人作废。这正是「分层不是网状」这句话的全部实质内容，
 *    留在文档里它就只是个建议。
 *  返回 null 表示合法，否则返回可读原因。 */
export function checkDirection(fromLayer, toLayer) {
  const a = LAYERS.indexOf(fromLayer), b = LAYERS.indexOf(toLayer);
  if (a === -1 || b === -1) return `未知的层：${fromLayer} → ${toLayer}`;
  if (b > a) return `${fromLayer} 层不得依赖 ${toLayer} 层（依赖只能向上：${LAYERS.join(' ← ')}）`;
  return null;
}

/** 谁负责复核这条。
 *  ★ 上层（shared / portfolio）必填 —— 上层被多个项目共享，「过期了该找谁」
 *    在项目层是自明的（就是你自己），在上层则不是：没有 owner，
 *    「地基松动」只说得出结论、说不出该去催谁，告警就退化成噪音。
 *  ★ 这是铁律 2 的第二次应用：「谁该复核」是个【语义判断】，必须在写入时
 *    由模型固化成字段，维护路径（pre-commit / cron，那里没有模型）才只做聚合。
 *    与 answerable_by 同构。 */
export const OWNER_REQUIRED_LAYERS = ['shared', 'portfolio'];
export const ownerOf = (e) => {
  const v = e?.data?.owner;
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
};

/** 报错/报告里用的位置串。
 *  ★ rel 是层内相对路径，跨层会重名 —— 不带层的话，「id 重复」可能打印成
 *    `X: id "…" 与 X 重复`（自己和自己重复），指向的路径还解析不到。 */
export const locOf = e => e.layer === 'project' ? e.rel : `@${e.layer}/${e.rel}`;

export function loadEntries(roots = ROOTS()) {
  const order = new Map(LAYERS.map((l, i) => [l, i]));
  return roots.flatMap(({ layer, root }) => walk(root).map(path => {
    const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    const headings = [...body.matchAll(/^##+\s+(.+)$/gm)].map(m => m[1].trim());
    // 归一化数组字段：记录违规供 validate 报错，但不让下游逐字符迭代
    const malformed = [], blockScalars = [], nestedMaps = [];
    if (data) for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // 块标量标记 / 嵌套 map —— 两者 stringifyFrontmatter 都写不回去
        if (v.__blockScalar) { blockScalars.push(k); data[k] = null; }
        else { nestedMaps.push(k); data[k] = null; }
      }
    }
    if (data) for (const f of ARRAY_FIELDS) {
      if (data[f] != null && !Array.isArray(data[f])) { malformed.push(f); data[f] = []; }
    }
    return {
      malformed, blockScalars, nestedMaps,
      path,
      layer,
      root,
      // 全库唯一标识；byId / depends_on / _stack 一律用它，不用裸 data.id ——
      // 两层各有一条同名裸 id 时，用裸 id 作键会静默塌成一条。
      qid: qidOf(layer, data?.id),
      // ★ 规范化后的依赖（限定 id），只供图遍历与反向链接用。
      //   data 保持【原样】—— review/new 会把 data 写回磁盘，
      //   在那里塞规范化结果等于偷偷改用户的文件。
      depsQ: [],
      // rel 是【层内】相对路径，跨层可能重名（两层都有 facts/market/x.md）。
      // 需要全局唯一的键时用 path —— 见 build-index.mjs 里 F/G 的说明。
      rel: relative(root, path),
      slug: basename(path, '.md'),
      data: data || {},
      headings,
      lines: body.split('\n').length,
    };
  })).sort((a, b) =>
    (order.get(a.layer) - order.get(b.layer)) || a.rel.localeCompare(b.rel))
    .map(e => {
      e.depsQ = (e.data.depends_on || []).map(r => resolveRef(r, e.layer));
      return e;
    });
}

/** 一组条目文件的内容指纹。
 *  ★ 用【内容】而不是 mtime 判断「索引是否已落后于语料」：
 *    - mtime 看不见删除（删一条只会让最大 mtime 变小，索引反而显得更新）
 *    - mtime 在 git clone 之后是任意顺序，会让每一行都永远显示「落后」，
 *      而永远为真的警告等于训练读者忽略警告
 *    - mtime 只覆盖被遍历的那个根，看不见上层条目的改动，而项目的地基
 *      健康度恰恰依赖上层
 *  ★ 键用【限定 id】而不是路径。目前生产端与消费端传的都是绝对路径，
 *    所以按路径排序【当下】也能得到一致结果 —— 但那是巧合：任何一端改成
 *    传相对路径（比如直接用产物里的 linkTo 值），两边的排序就会不同，
 *    每一行都永远显示「落后」，而永远为真的警告等于训练读者忽略警告。
 *    按 qid 排序把这个耦合彻底去掉。 */
export function fingerprint(items) {
  const h = createHash('sha256');
  for (const { key, path } of [...items].sort((a, b) => a.key.localeCompare(b.key))) {
    h.update(key); h.update('\0');
    try { h.update(readFileSync(path)); } catch { h.update('<missing>'); }
    h.update('\n');
  }
  return h.digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────
// 日期与保鲜
// ─────────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 读取 MINDLINK_TODAY 覆盖值并【校验格式】。
 *  ★ 不校验的后果是静默且全局的：`2026-11-1`（漏前导零）会让 daysBetween
 *    返回 NaN，而 freshness 里 `overdueDays > 0` 与 `> -7` 对 NaN 双双为 false，
 *    于是每一条都判成 'ok' —— STALE.md 打印「✅ 全部新鲜」，一条逾期 260 天的
 *    事实报告健康，且零报错。**不支持好过静默给错答案。** */
function dateOverride() {
  const v = process.env.MINDLINK_TODAY;
  if (v == null || v === '') return null;
  if (!DATE_RE.test(v)) {
    console.error(`❌ MINDLINK_TODAY="${v}" 不是合法日期。`);
    console.error(`   必须是 YYYY-MM-DD 且含前导零，例如 2026-11-01。`);
    console.error(`   （格式不对会让所有过期计算变成 NaN，从而静默报告「全部新鲜」。）`);
    process.exit(1);
  }
  return v;
}

/** 今天（本地日历日）。
 *  ★ 必须用本地日期，不能用 toISOString() —— 后者是 UTC。
 *    在 UTC+8，每天 00:00~08:00 这八小时 toISOString() 仍返回昨天，
 *    于是 new.mjs 会把【昨天】写进 asserted_at；而 asserted_at 是整个
 *    复核排期的基线，落盘即永久，validate 只校验格式不校验真伪。
 *    这是系统性偏移，不是随机噪声。
 *  ★ 只有「今天是几号」要用本地时区。addDays / daysBetween 仍按 UTC 解析
 *    纯日期串（`YYYY-MM-DDT00:00:00Z`），那是对的：两个日历日之间的天数
 *    不该受时区影响，统一用 UTC 解析才不会在夏令时切换处丢一天。 */
export function today() {
  const o = dateOverride();
  if (o) return o;
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 写入路径的守卫：日期被覆盖时拒绝落盘。
 *  ★ MINDLINK_TODAY 的正当用途只有一个 —— 确定性地【构建】示例产物。
 *    可它一旦 `export` 进 shell，new.mjs 就会把假日期写进 asserted_at，
 *    而 asserted_at 是整个复核排期的基线：写错一次永久错，
 *    且 validate 只校验日期的【格式】不校验【真伪】，没有任何下游能发现。
 *    所以这里必须硬拦，不能只警告 —— 警告会被忽略，错误的基线不会。 */
export function assertNoDateOverride(who) {
  const v = dateOverride();
  if (!v) return;
  console.error(`❌ 拒绝执行：环境里设了 MINDLINK_TODAY=${v}，而 ${who} 会把它写进条目。`);
  console.error(`   MINDLINK_TODAY 只用于确定性构建示例产物（见 examples/README.md），不可用于写入。`);
  console.error(`   请先 \`unset MINDLINK_TODAY\` 再运行。`);
  process.exit(1);
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

/** 硬闹钟：显式 wake_at 优先，否则由 effective_at 提前 WAKE_LEAD_DAYS 天推导。
 *  ★ 闹钟必须晚于 asserted_at 才有意义 —— 核实时就已经过去的生效日不产生闹钟，
 *    否则条目一创建就是「逾期 250 天」，是噪音不是信号。 */
export function wakeAt(entry) {
  const d = entry.data;
  const at = String(d.asserted_at);
  // 闹钟日在核实时【已经过去】→ 我们当时就知道了，视为已解除。
  // ★ 显式 wake_at 也适用：否则它会被钳到 asserted+1，而 review 只推进
  //   asserted_at 不动 wake_at —— 闹钟每天重新触发，永远解除不掉。
  if (d.wake_at && String(d.wake_at) <= at) return null;
  if (!d.wake_at && d.effective_at && String(d.effective_at) <= at) return null;
  const raw = d.wake_at ? String(d.wake_at)
            : d.effective_at ? addDays(String(d.effective_at), -WAKE_LEAD_DAYS)
            : null;
  if (!raw) return null;
  // ★ 派生日落在核实日之前（生效日很近），说明闹钟应该是「马上」而不是「不提醒」。
  //   早先直接 null 掉，恰恰丢掉了【最紧急】的那一批。
  return raw > at ? raw : addDays(at, 1);
}

/** 返回 { reviewBy, overdueDays, state, source, pending, effectiveAt }
 *  state   ok | due-soon | overdue | never   —— 我们核实的新鲜度
 *  source  period | wake | null             —— reviewBy 来自周期还是硬闹钟
 *  pending true 表示【已核实但尚未生效】
 *  ★ reviewBy = min(asserted_at + 周期, wake_at)，硬闹钟优先 */
export function freshness(entry, now = today()) {
  const d = entry.data;
  // 缺 asserted_at 时不要抛 RangeError —— 让 validate.mjs 给出可读错误
  if (!d.asserted_at || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.asserted_at)))
    return { reviewBy: null, overdueDays: 0, state: 'never', source: null, pending: false, effectiveAt: null };
  const days = REVIEW_DAYS[d.volatility];
  const periodBy = (days === null || days === undefined) ? null : addDays(String(d.asserted_at), days);
  const wake = wakeAt(entry);
  const pending = Boolean(d.effective_at && String(d.effective_at) > now);
  const effectiveAt = d.effective_at ? String(d.effective_at) : null;

  let reviewBy = null, source = null;
  if (periodBy && wake) { reviewBy = periodBy <= wake ? periodBy : wake; source = periodBy <= wake ? 'period' : 'wake'; }
  else if (periodBy) { reviewBy = periodBy; source = 'period'; }
  else if (wake) { reviewBy = wake; source = 'wake'; }

  if (!reviewBy) return { reviewBy: null, overdueDays: 0, state: 'never', source: null, pending, effectiveAt };

  const overdueDays = daysBetween(reviewBy, now);
  const state = overdueDays > 0 ? 'overdue' : overdueDays > -7 ? 'due-soon' : 'ok';
  return { reviewBy, overdueDays, state, source, pending, effectiveAt };
}

// ─────────────────────────────────────────────────────────────
// ★ 地基健康度传导
//   判断的可信度不高于它所依赖的最差的那条事实。
//   这把 GRAPH 从「被动可查」变成「主动告警」。
// ─────────────────────────────────────────────────────────────

/** 返回 { state, issues } —— state: solid | shaky | unknown | n/a
 *  issues: [{ id, kind: missing|superseded|overdue|transitive, ... }]
 *
 *  ★ 递归传导：判断可以依赖判断。若上游判断的地基松了，本判断也不可信。
 *    _seen 防环（A 依赖 B、B 依赖 A 时不会无限递归）。 */
export function foundation(entry, byId, now = today(), _stack = new Set()) {
  if (entry.data.type !== 'judgment') return { state: 'n/a', issues: [] };
  const deps = entry.depsQ || [];
  if (!deps.length) return { state: 'unknown', issues: [] };
  // ★ _stack 是【当前递归路径】，不是全局 visited 集合。
  //   若当作 visited 用，菱形依赖（A→B→D, A→C→D）会让第二条路径
  //   直接返回 solid，导致 A 只报 B 的问题、永远看不到 C 的。
  if (_stack.has(entry.qid)) return { state: 'solid', issues: [] };  // 成环
  _stack.add(entry.qid);

  const issues = [];
  for (const id of deps) {
    const t = byId.get(id);
    if (!t) { issues.push({ id, kind: 'missing' }); continue; }
    if (['superseded', 'archived'].includes(t.data.status)) {
      issues.push({ id, kind: 'superseded', to: t.data.superseded_by || null });
      continue;
    }
    // status: stale 是「人工标记待复核」，同样构成地基问题
    if (t.data.status === 'stale') { issues.push({ id, kind: 'marked-stale' }); continue; }
    const f = freshness(t, now);
    if (f.state === 'overdue') { issues.push({ id, kind: 'overdue', days: f.overdueDays }); continue; }
    // 上游是判断 → 递归看它自己的地基
    if (t.data.type === 'judgment') {
      const sub = foundation(t, byId, now, _stack);
      if (sub.state === 'shaky') issues.push({ id, kind: 'transitive', via: sub.issues.map(i => i.id) });
    }
  }
  _stack.delete(entry.qid);   // ★ 出栈，让兄弟分支能独立求值
  return { state: issues.length ? 'shaky' : 'solid', issues };
}

// ─────────────────────────────────────────────────────────────
// 路由（检索评分）
// ─────────────────────────────────────────────────────────────
/** 给一句话，按【已固化进 front-matter 的结构化数据】打分。
 *
 *  ★ 不做语义推断，只用 answers / tags / title —— 因为真实的 agent 读到的
 *    就是这些。评分逻辑必须只有一份：retrieval-test 守的必须正是 search
 *    实际在用的那套，否则测试守着一个没人走的路由。
 *
 *  items: [{ qid, answers, tags, title, ...任意附加字段 }]
 *  返回按分数降序的命中，附带 why（为什么命中）—— 不给理由的排序没法被质疑。 */
export function route(q, items) {
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s\u3000]/g, '');
  const nq = norm(q);
  if (!nq) return [];
  const hits = [];
  for (const it of items) {
    let score = 0, why = null;
    for (const a of it.answers || []) {
      const na = norm(a);
      if (na === nq) { score = 100; why = 'answers 精确匹配'; break; }
      if (na && (na.includes(nq) || nq.includes(na))) { if (score < 60) { score = 60; why = 'answers 部分匹配'; } }
    }
    if (!score) for (const t of it.tags || []) { const nt = norm(t); if (nt && nq.includes(nt)) { score = 20; why = 'tag'; } }
    if (!score && norm(it.title).includes(nq)) { score = 15; why = 'title'; }
    if (score) hits.push({ ...it, score, why });
  }
  return hits.sort((a, b) => b.score - a.score || String(a.qid).localeCompare(String(b.qid)));
}

// ─────────────────────────────────────────────────────────────
// 显示
// ─────────────────────────────────────────────────────────────
export const ICON = { ok: '✅', 'due-soon': '🟡', overdue: '🔴', never: '⚪️', pending: '⏳' };
export const FOUND_ICON = { solid: '✅', shaky: '⚠️', unknown: '❔', 'n/a': '' };
/** 依赖项的图标：已取代/归档要和「只是过期」区分开 —— 两者要做的事完全不同
 *  （前者是把引用指向继任者，后者是重新核实）。 */
export function depIcon(entry, f) {
  if (!entry) return '❓';
  if (['superseded', 'archived'].includes(entry.data.status)) return '🚫';
  if (entry.data.status === 'stale') return '🟠';
  return stateIcon(f);
}

/** 综合图标：过期最紧急；未生效与临期可同时显示，不互相遮蔽。 */
export function stateIcon(f) {
  if (f.state === 'overdue') return ICON.overdue;
  if (f.pending) return f.state === 'due-soon' ? ICON.pending + ICON['due-soon'] : ICON.pending;
  return ICON[f.state];
}

// ─────────────────────────────────────────────────────────────
// 接线：把 kb 的路由块写进项目的 CLAUDE.md / AGENTS.md
// ─────────────────────────────────────────────────────────────
// ★ 为什么要有这一段：init 只给了容器。一个建好的 kb 若没被写进 agent 的入口
//   文件，对 agent 就是隐形的 —— 实测五个库里三个处于这个状态，而 Codex 一个
//   都看不见。「保鲜 ≠ 可发现」在【库这一级】的同一种形态。
// ★ 为什么模板随脚本分发（scripts/agent-block.md 而不是 templates/）：
//   status 要能在【任何一个库】里判断「路由块过时了没」，那需要当前模板的哈希，
//   而 templates/ 只在 mindlink 仓库里有。
export const WIRE_FILES = ['CLAUDE.md', 'AGENTS.md'];
export const WIRE_RE = /<!-- mindlink:begin[^>]*-->[\s\S]*?<!-- mindlink:end -->\n?/;
const WIRE_TPL = join(dirname(fileURLToPath(import.meta.url)), 'agent-block.md');
// ★ 中央层用另一份模板：在共享层里干活的规则和项目里完全不同 —— 这里每一条对所有
//   项目可见、owner 必填、调研报告放 research/、条目从报告提炼。原来的「中央层没有
//   agent 干活」被用户推翻：他要在 shared/agent/ 里直接开 session 做调研。
const WIRE_TPL_LAYER = join(dirname(fileURLToPath(import.meta.url)), 'agent-block-layer.md');

/** 渲染路由块。kbRel 是入口文件所在目录到 kb 的相对路径（通常是 'kb'；
 *  中央层那种「目录本身就是库根」的情况是 '.'）。layer 决定用哪份模板。 */
export function renderAgentBlock(kbRel = 'kb', version = '?', layer = 'project') {
  const tpl = layer && layer !== 'project' ? WIRE_TPL_LAYER : WIRE_TPL;
  const body = readFileSync(tpl, 'utf8').replaceAll('{{KB}}', kbRel).replaceAll('{{LAYER}}', layer).trimEnd();
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 7);
  return { hash, text: `<!-- mindlink:begin v${version} ${hash} -->\n${body}\n<!-- mindlink:end -->\n` };
}

/** 某个入口文件里的路由块处于什么状态。
 *  返回 'missing' | 'stale' | 'ok'。★ 用内容哈希而不是版本号：模板改了措辞而
 *  没升版本号的话，按版本号比对会把七份旧块全部报成「最新」。 */
export function wireStateOf(file, kbRel = 'kb', layer = 'project') {
  if (!existsSync(file)) return 'missing';
  const m = readFileSync(file, 'utf8').match(/<!-- mindlink:begin[^>]*?([0-9a-f]{7}) -->/);
  if (!m) return 'missing';
  return m[1] === renderAgentBlock(kbRel, '?', layer).hash ? 'ok' : 'stale';
}

/** kb 根 → 放入口文件的项目目录，以及从那里到 kb 的相对路径。
 *  <x>/kb → { dir: <x>, kbRel: 'kb' }；库根即目录本身 → { dir: 它自己, kbRel: '.' } */
export function projectDirOf(kbRoot) {
  return basename(kbRoot) === 'kb' ? { dir: dirname(kbRoot), kbRel: 'kb' } : { dir: kbRoot, kbRel: '.' };
}

// ─────────────────────────────────────────────────────────────
// 项目文档：勘察、出处指纹、台账
// ─────────────────────────────────────────────────────────────
// ★ 为什么 kb 要看一眼 docs/：条目是从原文档【提炼】出来的，而现在能触发复核的
//   只有时间（volatility）和依赖（depends_on）—— 原文改了、加了新文档，kb 完全
//   不知道。实测 crypto 60 条里 0 条指向本地出处，连指针都没有。
//   这里补三样：出处指纹（derived_from）、勘察台账（.survey.json）、扫描逻辑。
//   全部零模型，跑在 build-index 里 —— 也就是每次 pre-commit。

// 这些目录里没有「知识」，只有依赖和产物。不排掉的话，一个 node_modules 就能
// 把真正值得看的十几份文档淹没在几千份 README 里。
export const DOC_SKIP = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit', 'dist', 'build', 'out',
  'target', 'vendor', 'coverage', '.venv', 'venv', '__pycache__', '.cache',
  '.turbo', '.vercel', '.terraform', 'Pods', 'DerivedData',
  // agent 的配置目录：skill、worktree 镜像、会话产物，不是项目知识。
  // 实测一个项目的 .claude/worktrees/ 造出 117 处同内容副本。
  '.claude', '.codex', '.cursor', '.agents',
  '.scripts',   // kb 就是项目根时，脚本目录里的 agent-block.md 不是文档
  'feedback', '_archive',   // 同上：意见与归档条目都不是项目文档
]);
// agent 的入口文件是【指令】，不是知识。而且 init 之后它们必然存在（wire 写的）。
export const AGENT_ENTRY = new Set(['CLAUDE.md', 'AGENTS.md', 'AGENT.md', 'GEMINI.md', 'COPILOT.md']);
export const DOC_EXT = new Set(['.md', '.mdx']);
// ★ 所有拿路径互相比较的地方都要先 realpath：环境变量来的路径没解析符号链接，
//   cwd 来的解析过。macOS 上 /var → /private/var 一不等，kb 子树排不掉、
//   相对路径算成 ../../..。实测两次都栽在这里。
const realDir = (p) => { try { return realpathSync(p); } catch { return p; } };

/** 项目里的文档（绝对路径）。排除 kb 自己的语料、依赖目录、agent 入口文件。
 *  kb 可能【就在项目根】（kbRoot === projectDir，中央层和 examples/ 都是这形态）——
 *  那时「文档」的定义是：**不是条目的 .md**。不能按固定目录名排（facts/ judgments/ …），
 *  主题文件夹（agent/）里的条目会被当成未处理的文档；而 agent/research/ 里的报告
 *  【不是】条目、【是】文档 —— 只有用 walk() 的结果来区分才两边都对。 */
export function walkProjectDocs(projectDir, kbRoot) {
  projectDir = realDir(projectDir);
  kbRoot = kbRoot ? realDir(kbRoot) : kbRoot;
  const flat = kbRoot === projectDir;
  const ignore = loadKbIgnore(kbRoot);
  // ★ 「条目」= 有 front-matter 且带 id 的 .md。walk() 只看扩展名 —— kb 根下一份没有
  //   front-matter 的 NOTES.md 也会被它捡起来，按它排的话那份笔记就永远不算文档。
  const looksLikeEntry = (p) => { try { const h = readFileSync(p, 'utf8').slice(0, 2000); return h.startsWith('---') && /^id:\s*\S/m.test(h.split(/\n---/)[0]); } catch { return false; } };
  const entries = flat ? new Set(walk(kbRoot).filter(looksLikeEntry).map(realDir)) : null;
  const inOwnKb = (p) => kbRoot && (p === kbRoot || p.startsWith(kbRoot + sep))
    ? (flat ? entries.has(p) : true)
    : false;
  const acc = [];
  const rec = (dir) => {
    let names; try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (DOC_SKIP.has(n) || n.startsWith('.')) continue;   // 隐藏目录同样不是项目文档
      const p = join(dir, n);
      if (ignore(relative(projectDir, p).split(sep).join('/'), n)) continue;   // .kbignore
      let st; try { st = lstatSync(p); } catch { continue; }
      // 不跟进符号链接：指向祖先的软链会把同一批文件反复走到 ELOOP 上限
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (!inOwnKb(p)) rec(p); }
      // kb 就是项目根时，根目录下的 INDEX/STALE/GRAPH/OPEN/README 是 kb 自己的产物，不是项目文档
      else if (DOC_EXT.has(extname(p)) && !AGENT_ENTRY.has(n) && !inOwnKb(p)
               && !(flat && KB_OWN.test(n))) acc.push(p);
    }
  };
  rec(projectDir);
  return acc;
}

/** 文件内容指纹（12 位 hex）；文件不存在返回 null。 */
export function fileHash(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12); }
  catch { return null; }
}

/** 勘察台账：kb/.survey.json。记每份文档的指纹和【决定】——
 *  进了 kb（entry:<id>）/ 不进（skip + 理由）。没有决定的文档就一直挂在队列里。
 *  ★ 入 git：「跳过，因为是规格文档」是团队知识，换台机器也该知道。 */
export const SURVEY_FILE = '.survey.json';
export function loadSurvey(kbRoot) {
  const f = join(kbRoot, SURVEY_FILE);
  if (!existsSync(f)) return { docs: {} };
  try { const j = JSON.parse(readFileSync(f, 'utf8')); return { docs: (j && j.docs) || {} }; }
  catch { return { docs: {} }; }
}
export function saveSurvey(kbRoot, s) {
  const f = join(kbRoot, SURVEY_FILE);
  const sorted = Object.fromEntries(Object.entries(s.docs).sort(([a], [b]) => a.localeCompare(b)));
  // ★ 临时文件名必须唯一。固定的 .survey.json.tmp 在并行写入时互相覆盖，
  //   rename 抛 ENOENT —— 实测 6 个写者 × 15 次：10 次崩溃。
  const tmp = `${f}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ docs: sorted }, null, 2) + '\n');
  renameSync(tmp, f);
}

/** 在锁里做「读 → 改 → 写」。
 *  ★ 没有锁的话两个写者各自读到旧台账、各自写回 —— 后写的把先写的抹掉。
 *    实测 6 个 agent 并行建 90 条，台账只剩 83 条（用户那边 6 个 agent 建 85 条时先撞上）。
 *  锁用 mkdir：POSIX 上原子。拿不到就退避重试；锁目录超过 STALE_MS 视为遗留（持锁进程被杀），
 *  强制清掉 —— 一把永远拿不到的锁比丢一条记录更糟。 */
const LOCK_STALE_MS = 10_000;
// ★ 等待上限可配：测试里预占锁验证「不绕过」时，5 秒 × 每轮全量变异 230 次 = 20 分钟白等
const LOCK_WAIT_MS = Number(process.env.MINDLINK_LOCK_WAIT_MS) || 5_000;
export function withSurveyLock(kbRoot, fn) {
  const lock = join(kbRoot, SURVEY_FILE + '.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0; try { age = Date.now() - statSync(lock).mtimeMs; } catch { /* 刚被别人释放 */ continue; }
      if (age > LOCK_STALE_MS) { try { rmSync(lock, { recursive: true, force: true }); } catch {} continue; }
      if (Date.now() > deadline) throw new Error(`台账锁 ${lock} ${LOCK_WAIT_MS}ms 内拿不到（持锁者 ${Math.round(age)}ms 前还活着）`);
      // 同步退避：短暂自旋。这里不能 await —— 调用方是同步脚本
      const until = Date.now() + 15 + Math.random() * 30; while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    const s = loadSurvey(kbRoot);
    const r = fn(s);
    saveSurvey(kbRoot, s);
    return r;
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch {}
  }
}

/** 文档 vs 台账 vs 条目出处：哪些文档还没被处理。
 *  返回 { unprocessed: [{rel, hash}], changedSkipped: [{rel, why, hash, was}] }。
 *  ★ 被某条目 derived_from 引用的文档不算未处理 —— 即使台账里没记（手写的条目）。 */
export function surveyOf(kbRoot, projectDir, entries = []) {
  projectDir = realDir(projectDir);
  const ledger = loadSurvey(kbRoot).docs;
  const covered = new Set();
  for (const e of entries) for (const d of e.data?.derived_from || []) if (d && d.path) covered.add(String(d.path));
  const unprocessed = [], changedSkipped = [];
  for (const abs of walkProjectDocs(projectDir, kbRoot)) {
    const rel = relative(projectDir, abs).split(sep).join('/');
    if (covered.has(rel)) continue;
    const rec = ledger[rel];
    const hash = fileHash(abs);
    if (!rec) { unprocessed.push({ rel, hash }); continue; }
    if (rec.decision === 'skip' && rec.hash !== hash) changedSkipped.push({ rel, why: rec.why, hash, was: rec.hash });
  }
  return { unprocessed, changedSkipped };
}

/** 条目的出处是否已变动。返回 [{e, path, state: 'changed'|'missing'}]。 */
export function derivedDrift(entries, projectDir) {
  projectDir = realDir(projectDir);
  const out = [];
  for (const e of entries) for (const d of e.data?.derived_from || []) {
    if (!d || !d.path) continue;
    const now = fileHash(join(projectDir, String(d.path)));
    if (now === null) out.push({ e, path: d.path, state: 'missing' });
    else if (now !== d.hash) out.push({ e, path: d.path, state: 'changed' });
  }
  return out;
}
