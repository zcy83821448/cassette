/* dev: the same three checks, but waiting on *frames* instead of seconds.
   Under software rendering a frame can take seconds and cas.update() clamps dt to
   1/20 s, so a 1.5 s animation needs ~35 frames and the 5 s idle delay needs
   ~100 鈥?wall-clock waits measure nothing here. Small viewport, so frames are
   cheap. */
import { writeFileSync } from 'node:fs';

const [url, out = 'tools/_chk'] = process.argv.slice(2);
const port = 9445;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
};
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then((r) => r.result?.result?.value);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (tag) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${out}-${tag}.png`, Buffer.from(s.result.data, 'base64'));
};
const frames = () => evaluate('window.__f');
const waitFrames = async (n) => {
  const from = await frames();
  for (let i = 0; i < 900; i++) {
    await sleep(500);
    if ((await frames()) - from >= n) return;
  }
  console.log(`   (timed out waiting for ${n} frames)`);
};
const state = () => evaluate(`JSON.stringify({
  rec: document.querySelector('.file-cn')?.textContent,
  explodedBtn: document.getElementById('btn-explode').getAttribute('aria-pressed'),
  body: document.body.className,
  op: [...document.querySelectorAll('.anno')].map((e) => +getComputedStyle(e).opacity.slice(0, 4)),
})`).then((s) => JSON.parse(s));
const INSTRUMENT = `window.__f = 0; (function tick(){ window.__f++; requestAnimationFrame(tick); })();`;

await send('Emulation.setDeviceMetricsOverride', { width: 940, height: 580, deviceScaleFactor: 1, mobile: false });
await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
await send('Page.navigate', { url });
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  if (await evaluate(`(() => { const l = document.getElementById('loader'); return !!l && getComputedStyle(l).opacity === '0'; })()`).catch(() => false)) break;
}
await waitFrames(20);
console.log('frames at start:', await frames());

console.log('1/2  drag, then leave it alone');
const cx = 200, cy = 150;
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 });
for (let i = 1; i <= 8; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + i * 14, y: cy + i * 5, button: 'left', buttons: 1 });
  await sleep(20);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 112, y: cy + 40, button: 'left', buttons: 0, clickCount: 1 });
await waitFrames(12);
await shot('dragged');
console.log('     dragged off');
await waitFrames(190);   // > 5 s of clamped dt, plus the 1.6 s ease
await shot('returned');
console.log('     waited 150 frames; compare _chk-dragged vs _chk-returned');

console.log('3    read 05 (hub), then 00 (whole machine)');
await evaluate(`document.querySelectorAll('.row')[5].click()`);
await sleep(400);
await evaluate(`document.querySelectorAll('.row')[5].click()`);
await waitFrames(40);
console.log('     open, settled :', await state());
await evaluate(`document.querySelectorAll('.row')[0].click()`);
await sleep(400);
await evaluate(`document.querySelectorAll('.row')[0].click()`);
await waitFrames(6);
console.log('     just closing  :', await state());
await waitFrames(150);
console.log('     closed        :', await state());
await shot('closed');
if (problems.length) console.log('page errors:\n  ' + problems.join('\n  '));
ws.close();
