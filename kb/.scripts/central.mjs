#!/usr/bin/env node
// 中央侧的共享底座：登记表 + 读取所有已登记的库。
//
// ★ 抽出来是因为 status / search / digest 都要做同一件事：读登记表 → 读各库的
//   index.json → 还原成 lib 认得的形状 → 判断索引是否已落后于语料。
//   复制三份的话它们会各自漂移，而漂移的表现是【三个命令对同一批库给出不同的数字】,
//   那比任何一个单独出错都难查。
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import {
  walk, readLayerMarker, fingerprint, resolveRef, freshness, foundation, today, REGISTRY, LAYERS,
} from './lib.mjs';

// ★ 登记表的路径住在 lib —— resolveRoots 也要读它（层的位置）。
export { REGISTRY };

/** 读登记表。
 *  ★ 坏掉时必须还能修：半截 JSON 若让【每一个】子命令都吐堆栈，
 *    连 --list 和 --unregister 这仅有的两条修复路径也一起废掉。 */
export function loadRegistry() {
  if (!existsSync(REGISTRY)) return { projects: [] };
  let j;
  try { j = JSON.parse(readFileSync(REGISTRY, 'utf8')); }
  catch (e) {
    console.error(`❌ 登记表读不了：${REGISTRY}`);
    console.error(`   ${e.message}`);
    console.error(`   删掉它重新登记，或手工修好那个 JSON。`);
    process.exit(1);
  }
  if (!j || !Array.isArray(j.projects)) return { projects: [], layers: {} };
  // ★ layers 必须原样保留：这里是【唯一】的写回路径，过滤掉就等于每次 register 都把
  //   层的位置抹了 —— 而层的位置正是其它 session 看得见共享层的全部依据。
  const layers = Object.fromEntries(Object.entries((j.layers && typeof j.layers === 'object') ? j.layers : {})
    .filter(([k, v]) => LAYERS.includes(k) && typeof v === 'string'));
  return { projects: j.projects.filter(p => p && typeof p.root === 'string' && typeof p.name === 'string'), layers };
}

/** 写登记表。临时文件 + rename —— 中断不会留下半截登记表。 */
export function saveRegistry(r) {
  mkdirSync(dirname(REGISTRY), { recursive: true });
  const tmp = REGISTRY + '.tmp';
  const out = { layers: r.layers || {}, projects: r.projects || [] };
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  renameSync(tmp, REGISTRY);
}

/** 从 index.json 的一条记录还原出 lib 认得的 entry 形状。
 *  ★ 这样就能直接复用 freshness() / foundation() 【现场重算】，
 *    而不是把 build 时算好的结论抄下来 —— 那些结论是按【当时的日期】算的，
 *    只抄的话光是时间流逝就能让整张表报「一切正常」。 */
export const revive = (x) => ({
  data: x, qid: x.qid, layer: x.layer,
  depsQ: (x.depends_on || []).map(r => resolveRef(r, x.layer)),
});

/** 这份索引还对应得上现在的语料吗？
 *  ★ 用【内容指纹】而不是 mtime。mtime 有三个各自独立的失效方式：
 *    看不见删除（删一条只让最大 mtime 变小，索引反而显得更新）；
 *    git clone 之后是任意顺序，会让每一行都永远显示「落后」；
 *    只覆盖被遍历的那个根，看不见上层条目的改动 —— 而项目的地基健康度
 *    恰恰依赖上层。指纹三个都能覆盖。 */
export function driftOf(root, j) {
  if (!j.source_hash) return '索引是旧版本生成的（没有 source_hash），重建一次';
  const items = (j.entries || []).map(x => ({ key: x.qid || x.rel, path: resolve(root, x.path) }));
  const listed = new Set(items.map(i => i.path));
    // ★ 键要用相对路径。用绝对路径会把「两端传的路径形态必须一致」这个耦合
  //   又请回来 —— 而 lib.fingerprint 按 key 排序正是为了去掉它。
  for (const f of walk(root)) if (!listed.has(f)) items.push({ key: '<新增>' + relative(root, f), path: f });
  return fingerprint(items) === j.source_hash ? null : '索引落后于条目';
}

/** 读取全部已登记的库。
 *  返回 [{ name, root, err? , layer, drift, all, byId, live, 各项计数 }]。
 *  ★ 逐库容错：一个库坏掉不能把整张表打没 —— 中央视图的全部价值就在于
 *    「全都看到」。坏掉的库要降级成一行吵闹的记录，不是空白。 */
export function readAll(projects, now = today()) {
  const rows = [];
  for (const p of projects) {
    try {
      if (!existsSync(p.root)) { rows.push({ ...p, err: '路径不存在' }); continue; }
      const marker = readLayerMarker(p.root);
      if (marker.error) { rows.push({ ...p, err: marker.error }); continue; }
      const idx = join(p.root, 'index.json');
      if (!existsSync(idx)) { rows.push({ ...p, err: '未构建（跑 build-index.mjs）' }); continue; }
      const j = JSON.parse(readFileSync(idx, 'utf8'));

      // ★ 旧 schema 的索引（分层之前生成的）没有 qid / layer，于是它的条目
      //   会被下游整批丢掉 —— 一个 61 条的库就这样【整库不可见】，
      //   而工具还报「0 个库」当成事实。必须当成错误报出来，并给出可执行的修法。
      if ((j.entries || []).length && !('qid' in j.entries[0])) {
        rows.push({ ...p, err: '索引是旧版本生成的（条目缺 qid）。先 mindlink upgrade，再跑 build-index.mjs 重建' });
        continue;
      }

      const layer = marker.layer || 'project';
      const all = (j.entries || []).map(revive);
      const byId = new Map(all.filter(x => x.qid).map(x => [x.qid, x]));
      // ★ 只数【本层】条目：项目的 index.json 里也含它可见的上层条目，
      //   算进项目行就是把上层的活重复计到每一个项目头上。
      const live = all.filter(x => x.layer === layer
        && !['superseded', 'archived'].includes(x.data.status));

      rows.push({
        ...p, layer, all, byId, live,
        drift: driftOf(p.root, j),
        overdue: live.filter(x => freshness(x, now).state === 'overdue').length,
        judgments: live.filter(x => x.data.type === 'judgment').length,
        shaky: live.filter(x => x.data.type === 'judgment'
          && foundation(x, byId, now).state === 'shaky').length,
        open: live.reduce((n, x) => n + (x.data.open_questions || []).length, 0),
        at: j.generated_at || '?',
      });
    } catch (e) {
      rows.push({ ...p, err: `${e.message}` });
    }
  }
  return rows;
}

/** 把所有库的条目汇成一份【按 qid 去重】的清单，并标出归属。
 *
 *  ★ 去重绝不能用「只保留本层的」来实现：共享层多半【没有被单独登记】
 *    （adopt 只登记各项目自己的 kb），那样一丢，所有共享事实就整体不可达 ——
 *    明明它躺在每个项目的索引里，检索却报「没有记录」，把人支去把已有的
 *    知识重做一遍。
 *  ★ 归属库已登记就报库名；否则报层名（@shared），并记下是【经由】哪个项目
 *    看到的 —— 谎称它属于那个碰巧看得见它的项目会误导来源。
 *
 *  ★ 去重的键【不能】只用 qid：qid 只在层内唯一。
 *    上层条目（带 @ 前缀）会出现在每个能看见它的项目索引里，那是同一条，该合并；
 *    但两个项目各有一条裸 id 相同的条目，那是【两条不同的知识】——
 *    `--suggest` 正是靠「同一个裸 id 出现在多个库」来发现该晋升什么的。
 *    把它们合并掉，等于让那个信号和这两条知识本身一起消失。 */
export function collectEntries(rows) {
  const byQid = new Map();
  for (const r of rows) {
    if (r.err) continue;
    for (const e of r.all) {
      if (!e.qid) continue;
      const owns = e.layer === r.layer;
      // 项目层条目只属于自己那个库 → 键要带库名；上层条目全局唯一 → 键就是 qid
      const key = e.layer === 'project' ? `${r.name}\u0000${e.qid}` : e.qid;
      const prev = byQid.get(key);
      if (prev && !(owns && !prev.owns)) continue;   // 已有的更权威（或同级）
      byQid.set(key, {
        e, owns, layer: e.layer,
        lib: owns ? r.name : `@${e.layer}`,
        via: owns ? null : r.name,
      });
    }
  }
  return [...byQid.values()];
}

/** 把「登记项失效」与「索引落后」这两类问题打印出来。
 *  ★ 它们【不】受输出模式控制。塞进某个分支里，就会出现「既不吭声、
 *    又照样以非 0 退出」——一个没人看得懂的退出码，外加一次少了一个库的分析。
 *  ★ out 可以改道：机器可读模式下必须走 stderr，否则这些警告会跟在
 *    JSON 文档【后面】打进 stdout，把整份输出变成 JSON.parse 不了的东西。 */
export function reportProblems(rows, out = console.log) {
  const bad = rows.filter(r => r.err);
  const stale = rows.filter(r => !r.err && r.drift);
  if (bad.length) {
    out(`\n⚠️  ${bad.length} 条登记项有问题：`);
    for (const r of bad) out(`   ${r.name}  ${r.root}\n     → ${r.err}`);
    out(`   修：mindlink unregister <名>，或到那个库里跑一次 build-index.mjs`);
  }
  if (stale.length) {
    out(`\n⚠️  ${stale.length} 个库的索引与语料对不上，下面的数字是旧的：`);
    for (const r of stale) out(`   ${r.name} → 到 ${r.root} 跑 node .scripts/build-index.mjs`);
  }
  return bad.length;
}
