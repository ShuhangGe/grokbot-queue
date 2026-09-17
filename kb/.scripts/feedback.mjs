#!/usr/bin/env node
// 提意见：agent 在使用这套工具的过程中卡住了、缺什么、觉得哪条规则不对 —— 一行记下来。
//
// ★ 这套系统是面向 agent 的：agent 是它的客户，改进方向应该由 agent 提。
//   但「在对话里说一句」等于没说 —— 会话结束就丢了。必须落成文件。
//
// ★ 为什么住在【项目里】（kb/feedback/）而不是中央：
//   Codex 默认沙箱禁止写工作区之外。放 ~/.mindlink/ 的话，第二个客户一条都提不了。
//   本地写、中央读 —— 跟这套系统里其它所有能力同构。
//
// ★ 为什么 --doing 必填：同一条意见，附上「当时在做什么」才分得清它是普遍的
//   还是特定场景的。不同 agent 提出的需求有差异，差异往往就在任务背景里。
//
// ★ 不入 git（kb/.gitignore）。它们是关于【这套工具】的意见，不是项目的知识；
//   出现在项目仓库的历史里是噪音。
//
// 用法：
//   node feedback.mjs --kind friction --doing "当时在做什么" "一句话说清楚"
//   node feedback.mjs --kind bug --doing "…" "…" --body "更长的说明，可多行"
//   node feedback.mjs --list          本库所有反馈（含已处理的，带原因）
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KB_ROOT, parseFrontmatter, stringifyFrontmatter, today } from './lib.mjs';

export const KINDS = ['bug', 'friction', 'missing', 'wrong', 'question', 'review'];
// ★ review 是【复盘】不是抱怨：任务收尾时记一句「kb 这次帮到 / 无感 / 碍事」。
//   这是唯一能回答「这工具到底有没有用」的数据 —— 抱怨只在坏的时候出现，
//   复盘在好的时候也出现，两者的比例才是信号。verdict 必填，不然没法数。
export const VERDICTS = ['helped', 'neutral', 'hindered'];
export const STATUSES = ['open', 'accepted', 'rejected', 'done'];
export const FEEDBACK_DIR = 'feedback';

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const flag = (k) => { const i = argv.indexOf('--' + k); const v = argv[i + 1]; return i === -1 || v === undefined || v.startsWith('--') ? null : v; };
const VALUE_FLAGS = new Set(['kind', 'doing', 'body', 'agent', 'verdict']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (VALUE_FLAGS.has(a.slice(2))) i++; continue; }
  positional.push(a);
}

/** 探测是哪个 agent 在提。探不到就 unknown —— 不猜。
 *  ★ 可被 --agent 覆盖：探测只是省事，不是权威。 */
export function detectAgent(env = process.env) {
  if (Object.keys(env).some(k => k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE')) return 'claude-code';
  if (Object.keys(env).some(k => k.startsWith('CODEX'))) return 'codex';
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return 'cursor';
  return 'unknown';
}

/** 读取一个库里全部反馈。供 --list 与中央 triage 共用。 */
export function loadFeedback(root = KB_ROOT) {
  const dir = join(root, FEEDBACK_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    try {
      const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'));
      if (!data.id || !data.kind) continue;
      out.push({ path, data, body: (body || '').trim() });
    } catch { /* 坏文件跳过；它不是知识，不值得让整个列表崩掉 */ }
  }
  return out;
}

function usage(code = 1) {
  console.error(`用法：node feedback.mjs --kind <${KINDS.join('|')}> --doing "当时在做什么" "一句话" [--body "…"] [--agent <名>]`);
  console.error(`      node feedback.mjs --list`);
  console.error(``);
  console.error(`  bug       坏了：报错、产物不对、数据丢失`);
  console.error(`  friction  能用但别扭：找了很久、绕了弯、不确定该用哪个`);
  console.error(`  missing   缺能力：想做的事没有命令`);
  console.error(`  wrong     规则本身不对：照着做反而更差`);
  console.error(`  question  不确定该怎么做，文档没说清`);
  console.error(`  review    任务收尾的复盘：--verdict helped|neutral|hindered 必填`);
  console.error(``);
  console.error(`  只记【真的挡住你】或【你有具体更好做法】的。一条一个文件。`);
  process.exit(code);
}

// 只在直接执行时跑；被 triage 当模块 import 时不动。
// ★ 两边都要 realpath：Node 的 import.meta.url 已经解析过符号链接，而 argv[1] 是
//   原样路径。macOS 上 /var → /private/var 就会不等 —— 于是命令【什么都不做也不报错】。
//   静默无操作是最坏的失败形态：agent 以为提了，其实没有。
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  if (has('help') || (!has('list') && !positional.length && !flag('kind'))) usage(has('help') ? 0 : 1);

  if (has('list')) {
    const all = loadFeedback();
    if (!all.length) { console.log('（本库还没有任何反馈）'); process.exit(0); }
    const open = all.filter(f => f.data.status === 'open');
    const closed = all.filter(f => f.data.status !== 'open');
    console.log(`\n本库反馈 ${all.length} 条 · 未处理 ${open.length}\n`);
    for (const f of all) {
      const d = f.data;
      const tag = d.status === 'open' ? '○' : d.status === 'accepted' ? '◐' : d.status === 'done' ? '●' : '✕';
      console.log(`${tag} ${d.id}  [${d.kind}${d.verdict ? ':' + d.verdict : ''}]  ${d.title}`);
      console.log(`    ${d.at} · ${d.agent} · 当时在做：${d.doing}`);
      if (d.status !== 'open') console.log(`    → ${d.status}${d.resolution ? `：${d.resolution}` : ''}`);
    }
    console.log(`\n○ 未处理  ◐ 已接受  ● 已完成  ✕ 已拒绝（原因在上面 —— 别再提同一件）`);
    if (closed.length) console.log('');
    process.exit(0);
  }

  const kind = flag('kind');
  const doing = flag('doing');
  const title = positional.join(' ').trim();
  const missing = [];
  if (!kind) missing.push('--kind');
  else if (!KINDS.includes(kind)) { console.error(`❌ kind 只能是 ${KINDS.join(' | ')}，收到 "${kind}"`); process.exit(1); }
  if (!doing) missing.push('--doing（当时在做什么 —— 这是区分「普遍」和「特定场景」的唯一线索）');
  const verdict = flag('verdict');
  if (kind === 'review' && !verdict) missing.push(`--verdict ${VERDICTS.join('|')}（复盘没有结论就没法数）`);
  if (verdict && !VERDICTS.includes(verdict)) { console.error(`❌ verdict 只能是 ${VERDICTS.join(' | ')}，收到 "${verdict}"`); process.exit(1); }
  if (!title) missing.push('一句话说明（位置参数）');
  if (missing.length) { console.error(`❌ 缺：${missing.join('；')}`); usage(1); }

  const dir = join(KB_ROOT, FEEDBACK_DIR);
  mkdirSync(dir, { recursive: true });
  const at = today();
  const id = `fb-${at.replaceAll('-', '')}-${randomBytes(2).toString('hex')}`;
  const path = join(dir, `${id}.md`);
  const data = {
    id, kind, title, at,
    agent: flag('agent') || detectAgent(),
    doing,
    ...(kind === 'review' ? { verdict } : {}),
    // ★ 复盘不是待办：它是数据点，不需要有人来「处理」。默认就是 done，
    //   否则每次复盘都在队列里多一条等 resolve 的东西，队列很快就没人看了。
    status: kind === 'review' ? 'done' : 'open',
  };
  const body = (flag('body') || '').trim();
  writeFileSync(path, stringifyFrontmatter(data, body ? body + '\n' : ''));
  console.log(`✅ 已记录 ${id}  [${kind}]  ${title}`);
  console.log(`   ${path}`);
  console.log(`   不入 git；中央 agent 用 mindlink feedback 汇总处理。`);
}
