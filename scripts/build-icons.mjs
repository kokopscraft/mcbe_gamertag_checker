// 画面で使う Lucide アイコンだけを public/icons.js にまとめるスクリプト。
// 使い方: npm install して npm run icons
// アイコンを増やしたいときは ICONS に Lucide の名前(https://lucide.dev/icons)を足して再実行します。

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const ICONS = [
  // 内訳の項目
  'trophy', // 実績達成率
  'clock', // プレイ時間
  'award', // ゲーマースコア
  'shield-check', // 評判(良い)
  'shield-alert', // 評判(補正あり)
  'sigma', // 合計
  // 機種(ブランドのロゴではなく一般的な形で表す)
  'monitor', // Windows / PC
  'gamepad-2', // Xbox
  'gamepad-directional', // Nintendo Switch
  'smartphone', // モバイル
  'gamepad', // その他
  // 注意書き・その他
  'info',
  'triangle-alert',
  'octagon-alert',
  'search',
  'refresh-cw',
  'user-round-check',
  'gauge',
  'bug',
];

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('lucide-static/package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
const iconDir = join(dirname(pkgPath), 'icons');

const entries = ICONS.map((name) => {
  const svg = readFileSync(join(iconDir, `${name}.svg`), 'utf8');
  // <svg ...> の中身(path や circle など)だけを取り出す
  const inner = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('');
  return `  '${name}': '${inner.replace(/'/g, "\\'")}',`;
});

const out = `// このファイルは scripts/build-icons.mjs で生成しています。直接編集しないでください。
// アイコン: Lucide v${version} (https://lucide.dev) / ISC License
// Copyright (c) Lucide Icons and Contributors
//
// Permission to use, copy, modify, and/or distribute this software for any purpose with or
// without fee is hereby granted, provided that the above copyright notice and this permission
// notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
// SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
// AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
// NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
// PERFORMANCE OF THIS SOFTWARE.

const ICONS = {
${entries.join('\n')}
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** アイコンの SVG 要素を作る。飾りなので読み上げ対象から外す。 */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  svg.innerHTML = ICONS[name] ?? ICONS.gamepad;
  return svg;
}

/** HTML に書いた <span data-icon="名前"></span> をアイコンに置き換える。 */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.replaceWith(icon(el.dataset.icon, el.className || 'icon'));
  }
}
`;

writeFileSync(new URL('../public/icons.js', import.meta.url), out);
console.log(`public/icons.js を作りました(${ICONS.length}個、Lucide v${version})`);
