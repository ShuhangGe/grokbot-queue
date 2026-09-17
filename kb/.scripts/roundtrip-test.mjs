#!/usr/bin/env node
// 回归测试：序列化必须【收敛】—— 写第 2 次起内容不再变化。
//
// 注意断言的是收敛，不是「与手写输入逐字节相同」：
// 序列化器会规范化手写内容（比如给含特殊字符的值加引号），那是正常的。
// 真正的 bug 是【每写一次就变一次】。
// 这条测试是被真实的中文引号数据逼出来的 —— parseScalar 曾经不反转义，
// 导致每写一次反斜杠翻倍，静默损坏数据。
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEntries, parseFrontmatter, stringifyFrontmatter } from './lib.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mindlink-rt-'));
let bad = 0, n = 0;
for (const e of loadEntries()) {
  const tmp = join(dir, e.slug + '.md');
  copyFileSync(e.path, tmp);
  // 第 1 次写：规范化。之后 4 次必须逐字节相同。
  const w = () => {
    const { data, body } = parseFrontmatter(readFileSync(tmp, 'utf8'));
    writeFileSync(tmp, stringifyFrontmatter(data, body));
  };
  w();
  const before = readFileSync(tmp, 'utf8');
  for (let i = 0; i < 4; i++) w();
  const after = readFileSync(tmp, 'utf8');
  n++;
  if (before !== after) {
    bad++;
    console.error(`❌ ${e.slug}`);
    const b = before.split('\n'), a = after.split('\n');
    for (let i = 0; i < Math.max(b.length, a.length); i++)
      if (b[i] !== a[i]) { console.error(`   L${i + 1} before: ${b[i]}`); console.error(`   L${i + 1} after:  ${a[i]}`); break; }
  }
}
rmSync(dir, { recursive: true, force: true });   // 每次提交都跑，不清理会持续泄漏
console.log(`${bad ? '❌' : '✅'} round-trip convergence: ${bad} of ${n} unstable`);
process.exit(bad ? 1 : 0);
