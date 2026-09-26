/* dev: screenshot the running page over CDP, which is the only way to see the
   real thing — `msedge --screenshot` gives WebGL no time to draw, and the loader
   is still up when it fires.
 *
 *   msedge --headless=new --remote-debugging-port=9445 --use-angle=swiftshader \
 *          --enable-unsafe-swiftshader --user-data-dir=<tmp>
 *   node tools/page-shot.mjs <url> <out.png> [width] [height] [waitMs] [js] [clip]
 *
 * The last two are optional: `js` is evaluated in the page right before the shot
 * (e.g. to click a button), and `clip` crops and zooms — "x,y,w,h,scale" in page
 * pixels, which is how a close-up of one corner of the model gets framed.
 */
import { writeFileSync } from 'node:fs';

const [url, out, w = '1280', h = '820', waitMs = '0', js = '', clip = '', dpr = '1'] = process.argv.slice(2);
const port = 9445;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target — start the browser with --remote-debugging-port');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const problems = [];
ws.onclose = () => { for (const [, p] of pending) p.reject?.(new Error('devtools socket closed')); pending.clear(); };
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`${m.error.message} (${m.error.code})`)); else p.resolve(m);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    problems.push(m.params.args.map((a) => a.description || a.value).join(' '));
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  // a software-rendered 1440p frame can take minutes to read back, and a
  // renderer that dies under it never answers at all — fail loudly instead of
  // hanging on an unsettled promise. The timer is unref'd and cleared, or it
  // would hold the process open for its full length after a successful shot.
  const guard = setTimeout(() => {
    if (pending.has(n)) { pending.delete(n); reject(new Error(`${method} timed out`)); }
  }, 180000);
  guard.unref?.();
  pending.set(n, {
    resolve: (v) => { clearTimeout(guard); resolve(v); },
    reject: (e) => { clearTimeout(guard); reject(e); },
  });
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  .then((r) => r.result?.result?.value);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* `dpr` below 1 keeps the *layout* at the requested size while making the
   framebuffer smaller, which is the only way software rendering survives a
   1440p-class viewport; a clip's scale then multiplies it back up. */
await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: +dpr, mobile: false });
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });

// the sheet is what everything else waits on: nothing is drawn before it exists
let ready = false;
for (let i = 0; i < 90 && !ready; i++) {
  await sleep(1000);
  ready = await evaluate(`(() => { const l = document.getElementById('loader');
    return !!l && getComputedStyle(l).opacity === '0'; })()`).catch(() => false);
}
if (!ready) console.log('warning: loader never cleared');
await sleep(1200);                       // let the intro / first frames settle
if (js) console.log('js ->', await evaluate(js));
if (+waitMs) await sleep(+waitMs);

const shotArgs = { format: 'png', fromSurface: true, captureBeyondViewport: false };
if (clip && clip !== '-') {
  const parts = clip.split(',').map(Number);
  if (parts.length !== 5 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error(`clip wants "x,y,w,h,scale" or "-", got "${clip}"`);
  }
  const [x, y, cw, ch, scale] = parts;
  shotArgs.clip = { x, y, width: cw, height: ch, scale };
}
const shot = await send('Page.captureScreenshot', shotArgs);
const png = Buffer.from(shot.result.data, 'base64');
writeFileSync(out, png);
// report what actually came back, not what was asked for: a dpr below 1 makes
// the file smaller than the viewport, and that is easy to misread
console.log(`${out}  ${png.readUInt32BE(16)}x${png.readUInt32BE(20)} (viewport ${w}x${h} @dpr ${dpr})${clip ? `  clip ${clip}` : ''}`);
if (problems.length) console.log('page errors:\n  ' + problems.join('\n  '));
ws.close();
