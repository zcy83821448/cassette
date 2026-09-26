/* dev: move the interface onto `rem`.
 *
 * The page is laid out for a 1440-wide canvas; on a 2560×1440 display the same
 * px values mean a plate that stretches to 1108px with a hollow middle and
 * 10.5px micro-labels on a very large field. `html { font-size }` is the one
 * dial that scales all of it at once — every length becomes a multiple of the
 * root size, so the whole interface keeps its proportions instead of being
 * stretched over more canvas.
 *
 * Conversion rules, deliberately narrow:
 *   - `@media` / `@container` condition lines are left alone: those are
 *     viewport/container queries and must not move with the root size.
 *   - `border-*` and `outline-*` declarations keep their px, so a hairline is
 *     still exactly one device pixel at every scale.
 *   - everything else becomes rem at 16px to the root, which is the default
 *     root size — so nothing at all changes until the root grows.
 *
 *   node tools/_px2rem.mjs            (rewrites styles.css in place)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PX = /(?<![\w.])(-?\d*\.?\d+)px/g;
const rem = (n) => {
  const v = n / 16;
  if (v === 0) return '0';
  return `${+v.toFixed(5)}rem`;
};
const convert = (s) => s.replace(PX, (_, n) => rem(parseFloat(n)));

const path = new URL('../styles.css', import.meta.url);
const src = readFileSync(path, 'utf8');
const out = src.split('\n').map((line) => {
  if (/^\s*@(media|container|supports)/.test(line)) return line;
  // per declaration, so `border-bottom: 1px solid …; padding-bottom: 14px` only
  // keeps the border in px
  return line.replace(/([^;{}]+)/g, (decl) => {
    const prop = decl.split(':')[0].trim();
    if (/^(border|outline)/.test(prop)) return decl;
    return convert(decl);
  });
}).join('\n');

writeFileSync(path, out);
const n = (src.match(PX) || []).length;
console.log(`styles.css: ${n} px values scanned, rewritten to rem (borders/outlines kept)`);
