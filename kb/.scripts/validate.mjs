#!/usr/bin/env node
// 校验全部条目的 front-matter。CI / pre-commit 用。失败退出码 1。
import { loadEntries, locOf, parseRef, resolveRef, checkDirection, ownerOf, OWNER_REQUIRED_LAYERS, ROOTS, LAYERS, REQUIRED, TYPES, VOLATILITY, CONFIDENCE, STATUS, TIERS,
         DOMAINS, ANSWERABLE, DATE_FIELDS } from './lib.mjs';

const entries = loadEntries();
const errors = [], warns = [];
const ids = new Map();

for (const e of entries) {
  const d = e.data, at = locOf(e);
  if (!d || Object.keys(d).length === 0) { errors.push(`${at}: 缺少 front-matter`); continue; }

  for (const f of e.blockScalars || [])
    errors.push(`${at}: "${f}" 用了 YAML 块标量（| 或 >），本解析器不支持 —— ` +
                `放任不管会让值变成字面量 "|"/">"、正文被丢弃，且 review.mjs 会把损坏结果写回磁盘。请改成单行或引号包裹`);
  for (const f of e.nestedMaps || [])
    errors.push(`${at}: "${f}" 是嵌套 map，序列化时会变成 "[object Object]"。请改成标量或对象数组`);
  for (const f of e.malformed || []) errors.push(`${at}: "${f}" 必须是数组，现在是标量`);
  for (const f of REQUIRED) if (d[f] === undefined || d[f] === null || d[f] === '') errors.push(`${at}: 缺必填字段 "${f}"`);
  // ★ 前缀由所在层【推导】，绝不能写进 front-matter：写进去就是同一事实两处真相，
  //   移动条目要手改 id，且文件名放不下 `/`（「id == 文件名」规则会直接崩）。
  if (d.id && /[@/]/.test(String(d.id)))
    errors.push(`${at}: id "${d.id}" 含 @ 或 /。层前缀由所在目录推导，不要写进 front-matter；` +
                `引用别的层时才在 depends_on 里写 @layer/id`);
  // 唯一性按【限定 id】判：两层各有一条同名裸 id 是合法的，它们的 qid 不同。
  if (e.qid && ids.has(e.qid)) errors.push(`${at}: id "${e.qid}" 与 ${ids.get(e.qid)} 重复`);
  if (e.qid) ids.set(e.qid, at);
  if (d.id && d.id !== e.slug) errors.push(`${at}: id "${d.id}" 与文件名 "${e.slug}" 不一致`);
  if (d.type && !TYPES.includes(d.type)) errors.push(`${at}: type "${d.type}" 非法（${TYPES.join('|')}）`);
  if (d.volatility && !VOLATILITY.includes(d.volatility)) errors.push(`${at}: volatility "${d.volatility}" 非法（${VOLATILITY.join('|')}）`);
  if (d.confidence && !CONFIDENCE.includes(d.confidence)) errors.push(`${at}: confidence "${d.confidence}" 非法`);
  if (d.status && !STATUS.includes(d.status)) errors.push(`${at}: status "${d.status}" 非法`);
  // ── 时间字段 ──
  for (const f of DATE_FIELDS) {
    if (d[f] && !/^\d{4}-\d{2}-\d{2}$/.test(String(d[f]))) errors.push(`${at}: ${f} 必须是 YYYY-MM-DD`);
  }
  if (d.event_at && d.asserted_at && String(d.event_at) > String(d.asserted_at))
    warns.push(`${at}: event_at(${d.event_at}) 晚于 asserted_at(${d.asserted_at}) —— 事件还没发生就核实了？`);
  if (d.wake_at && d.effective_at && String(d.wake_at) > String(d.effective_at))
    warns.push(`${at}: wake_at 晚于 effective_at —— 生效后才提醒，闹钟没意义`);

  // ── domain ──
  if (d.domain && !DOMAINS.includes(d.domain)) errors.push(`${at}: domain "${d.domain}" 非法（${DOMAINS.join('|')}）`);
  if (!d.domain) warns.push(`${at}: 未标注 domain —— 无法按商业/技术筛选`);

  // ── open_questions ──
  for (const q of d.open_questions || []) {
    if (!q.q) errors.push(`${at}: open_questions 缺 q`);
    if (q.answerable_by && !ANSWERABLE.includes(q.answerable_by))
      errors.push(`${at}: answerable_by "${q.answerable_by}" 非法（${ANSWERABLE.join('|')}）`);
    if (!q.answerable_by) warns.push(`${at}: open_question 未标 answerable_by，将默认归入 research`);
  }

  // ── answers（路由表数据源）──
  for (const a of d.answers || []) {
    if (typeof a !== 'string' || !a.trim()) errors.push(`${at}: answers 的每一项必须是非空字符串`);
    else if (a.length > 40) warns.push(`${at}: answers "${a.slice(0,20)}…" 过长，路由表里会很难读`);
  }

  // ── reviews ──
  for (const r of d.reviews || []) {
    if (!r.at) errors.push(`${at}: reviews 缺 at`);
    if (r.at && !/^\d{4}-\d{2}-\d{2}$/.test(String(r.at))) errors.push(`${at}: reviews.at 必须是 YYYY-MM-DD`);
  }
  if (d.summary && String(d.summary).length > 160) warns.push(`${at}: summary 超过 160 字，索引里会很难读`);

  for (const s of d.sources || []) {
    if (!s.url) errors.push(`${at}: source 缺 url`);
    if (s.tier && !TIERS.includes(s.tier)) errors.push(`${at}: source tier "${s.tier}" 非法（${TIERS.join('|')}）`);
  }

  // ── derived_from：出处指纹 ──
  for (const x of d.derived_from || []) {
    if (!x || typeof x !== 'object' || !x.path) errors.push(`${at}: derived_from 每项必须有 path`);
    else if (!/^[0-9a-f]{12}$/.test(String(x.hash || ''))) errors.push(`${at}: derived_from ${x.path} 缺 12 位 hash（用 new.mjs --from 生成）`);
    else if (/^(\/|\.\.)/.test(String(x.path))) errors.push(`${at}: derived_from 路径必须相对项目根：${x.path}`);
  }

  // 来源分级规则：仅 T3 支撑的 fact，confidence 不得为 high
  if (d.type === 'fact' && (d.sources || []).length) {
    const best = (d.sources || []).map(s => s.tier).filter(Boolean).sort()[0];
    if (best === 'T3' && d.confidence === 'high') errors.push(`${at}: 仅 T3 来源，confidence 不得为 high`);
  }
  if (d.type === 'judgment' && !(d.depends_on || []).length) warns.push(`${at}: judgment 未声明 depends_on —— 事实变化时无法追溯`);

  // ★ 上层必须写明 owner。上层被多个项目共享，「过期了该找谁」在项目层是
  //   自明的（就是你自己），在上层则不是 —— 没有 owner，下游看到「地基松动」
  //   也不知道该去催谁，告警就退化成噪音。
  // ★ 写了但是空白 / 写了但不是字符串 → 只报这一条。若同时再报「必须写 owner」，
  //   一个问题两条错误，读的人会以为是两处要改。
  if (d.owner != null && !ownerOf(e))
    errors.push(`${at}: owner 必须是非空字符串（当前：${JSON.stringify(d.owner)}）`);
  else if (OWNER_REQUIRED_LAYERS.includes(e.layer) && !ownerOf(e))
    errors.push(`${at}: ${e.layer} 层必须写 owner（谁负责复核这条）。` +
                `没有它，依赖它的项目看到「地基松动」也不知道该找谁`);
}

// 引用完整性 + ★ 方向校验（依赖只能向上）
// ★ 从 ROOTS() 取而不是从 entries 取：一个已加载但恰好【空】的层不会出现在
//   entries 里，会被误报成「未加载」。
const loadedLayers = new Set(ROOTS().map(r => r.layer));
const ENV_OF = { project: 'MINDLINK_KB', shared: 'MINDLINK_SHARED', portfolio: 'MINDLINK_PORTFOLIO' };
for (const e of entries) {
  const d = e.data, at = locOf(e);
  const refs = [
    ...['depends_on', 'related'].flatMap(k => (d[k] || []).map(r => [k, r])),
    ...['supersedes', 'superseded_by'].filter(k => d[k]).map(k => [k, d[k]]),
  ];
  for (const [key, ref] of refs) {
    // ★ 按【引用者所在层】解析：裸 id 指同层。报错时仍打印用户写的原样。
    const q = resolveRef(ref, e.layer);
    if (!ids.has(q)) {
      const { layer } = parseRef(ref, e.layer);
      // 引用了一个【没被加载】的层，和「id 写错了」是两种完全不同的问题，
      // 提示必须分开 —— 否则会去改一个其实没错的 id。
      // ★ 三种情况必须分开：层名拼错 / 层没加载 / id 写错。混成一条的话，
      //   一个 @shard 的拼写错误会把人引去设一个根本不存在的环境变量。
      errors.push(
        !LAYERS.includes(layer)
          ? `${at}: ${key} 指向 "${ref}"，"${layer}" 不是合法的层名（${LAYERS.join(' | ')}）`
        : !loadedLayers.has(layer)
          ? `${at}: ${key} 指向 "${ref}"，但 ${layer} 层未加载（设 ${ENV_OF[layer]}）`
        : `${at}: ${key} 指向不存在的 id "${ref}"`);
      continue;
    }
    const refLayer = parseRef(ref, e.layer).layer;
    if (key === 'depends_on' || key === 'related') {
      const bad = checkDirection(e.layer, refLayer);
      if (bad) errors.push(`${at}: ${key} → "${ref}"：${bad}`);
    } else if (refLayer !== e.layer) {
      // ★ supersede 必须【同层】。它表达的是「世界变了，这条取代那条」，
      //   而跨层取代会在上层留下指向下层的链接：别的项目单独加载上层时
      //   找不到该 id，那条上层知识对所有人作废。
      //   ★ 晋升（把条目搬到上层）不是 supersede —— 知识没变，只是换了住处。
      //     那是 promote 的活：物理移动 + 改写引用，不留 supersede 链。
      errors.push(`${at}: ${key} → "${ref}" 跨层（${e.layer} → ${refLayer}）。` +
                  `supersede 只能在同层内发生；把条目搬到上层请用 promote，不要用 supersede`);
    }
  }
}

// supersede 双向一致性
const byId = new Map(entries.filter(e => e.qid).map(e => [e.qid, e]));
for (const e of entries) {
  const s = e.data.supersedes;
  // ★ 右侧必须是 e.qid：byId 按 qid 建、s 是限定引用，superseded_by 存的也是
  //   限定引用 —— 三者同一口径。右侧用裸 data.id 的话上层内部的 supersede
  //   会被永远误报成「对方没指回来」。
  //   ★ 也不能给 superseded_by 再套 qidOf：它【已经】是限定引用，会变成 @shared/@shared/…
  // ★ 对方的 superseded_by 要按【对方所在层】解析，不是引用者的层。
  //   跨层时用错框会多报一条误导性的「未指回来」，反向还可能在裸 id 恰好
  //   相同时意外匹配、把真问题吞掉。
  const t = s ? byId.get(resolveRef(s, e.layer)) : null;
  // ★ 跨层 supersede 上面已经报过了，这里不要再吐一条「未指回来」——
  //   那是同一个问题的次生现象，会把人引向错误的修法（去给上层加
  //   superseded_by），而正确的修法是根本不要跨层 supersede。
  const crossLayer = t && t.layer !== e.layer;
  if (s && !crossLayer && (!t || resolveRef(t.data.superseded_by ?? '\u0000', t.layer) !== e.qid))
    errors.push(`${locOf(e)}: supersedes "${s}"，但对方的 superseded_by 未指回来`);
  // ★ 反方向也必须查：带 superseded_by 却仍是 active 的条目会留在 live 里，
  //   在 INDEX 和路由表里冒充权威；更糟的是 foundation() 只看 status，
  //   于是依赖它的判断全部显示「✅ 地基稳固」—— 正是这个功能要防的静默失败。
  if (e.data.superseded_by && !['superseded', 'archived'].includes(e.data.status))
    errors.push(`${locOf(e)}: 有 superseded_by "${e.data.superseded_by}" 但 status 仍是 "${e.data.status}"，` +
                `它会继续以权威身份出现在索引与路由表里，且依赖它的判断不会被标记地基松动`);
}

warns.forEach(w => console.log(`⚠️  ${w}`));
if (errors.length) { console.error(`\n❌ ${errors.length} 个错误：`); errors.forEach(x => console.error('   ' + x)); process.exit(1); }
console.log(`\n✅ ${entries.length} 条全部通过校验${warns.length ? `（${warns.length} 条提醒）` : ''}`);
