import { build } from 'esbuild';
import { statSync } from 'node:fs';

const out = 'dist/app.js';
await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  outfile: out,
  format: 'iife',
  target: ['chrome110', 'firefox110', 'safari16'],
  minify: process.argv.includes('--min'),
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
console.log(`\n📼  dist/app.js  ${(statSync(out).size / 1024).toFixed(0)} KB`);
