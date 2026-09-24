/* dev: does the camera come back after a drag, and does the model stay still on
   its own? Screenshots the page, drags the canvas, screenshots again, waits past
   the idle delay and screenshots a third time. */
import { writeFileSync } from 'node:fs';

const [url, out = '_home'] = process.argv.slice(2);
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
  if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails?.exception?.description);
};
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then((r) => r.result?.result?.value);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (tag) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${out}-${tag}.png`, Buffer.from(s.result.data, 'base64'));
  console.log(`  ${out}-${tag}.png`);
};

await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  if (await evaluate(`(() => { const l = document.getElementById('loader'); return !!l && getComputedStyle(l).opacity === '0'; })()`).catch(() => false)) break;
}
await sleep(2000);

console.log('still (no interaction):');
await shot('a');
await sleep(6000);
await shot('b');            // must look identical: 巡览 is off by default

console.log('dragging the model:');
const cx = 700, cy = 420;
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 });
for (let i = 1; i <= 12; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + i * 22, y: cy + i * 6, button: 'left', buttons: 1 });
  await sleep(30);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 264, y: cy + 72, button: 'left', buttons: 0, clickCount: 1 });
await sleep(2500);
await shot('c');            // dragged away
console.log('waiting out the idle delay...');
await sleep(8000);
await shot('d');            // back on the framing the panel names
if (problems.length) console.log('page errors:\n  ' + problems.join('\n  '));
ws.close();
