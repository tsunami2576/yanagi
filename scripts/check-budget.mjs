/**
 * 首包体积预算检查：dist 内 JS（gzip）+ index.html ≤ 3MB（白皮书 §8.7 性能预算）。
 * 用法：node scripts/check-budget.mjs [distDir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'games/demo/dist';
const assets = join(dir, 'assets');

let jsGzip = 0;
for (const f of readdirSync(assets).filter((f) => f.endsWith('.js'))) {
  jsGzip += gzipSync(readFileSync(join(assets, f))).length;
}
const html = statSync(join(dir, 'index.html')).size;
const total = jsGzip + html;
const budget = 3 * 1024 * 1024;

console.log(
  `首包预算检查：JS gzip ${(jsGzip / 1024).toFixed(0)}KB + HTML ${(html / 1024).toFixed(1)}KB = ${(total / 1024).toFixed(0)}KB / ${(budget / 1048576).toFixed(0)}MB`,
);
if (total > budget) {
  console.error('超出首包预算（3MB）——请检查依赖或分包');
  process.exit(1);
}
console.log('通过');
