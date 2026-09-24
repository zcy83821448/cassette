import { labelTexture } from '../src/textures.js';

/* dev harness: draws both J-card faces full width so the painting can be
   eyeballed without loading the whole 3D scene, with the smoke window's
   cut-out marked — everything inside the dashed box is dropped by the plate.
   Build with
   `node build.mjs tools/label-preview.js dist/label-preview.js` or the
   tools/preview.bat shortcut, then headless-screenshot the html. */

const TRACK = {
  title: 'Sacred Play Secret Place',
  artist: 'Matryoshka',
  album: 'Laideronnette',
  minutes: '05',
};

const DISPLAY = 1000;                 // on-screen width of a 2048px canvas
const TAPE_W = 440;                   // roughly how wide the label reads on the tape
const WIN = { x: 271, y: 275, w: 1506, h: 753 };   // canvas px, from textures.js

// ?small=1 shows only the at-tape-size panel: the full-size sheets are taller
// than a screenshot window, and the small one is the one that decides things
const ONLY_SMALL = new URLSearchParams(location.search).has('small');

for (const face of ['A', 'B']) {
  try {
    const t0 = performance.now();
    const canvas = labelTexture(face, TRACK).image;
    const build = Math.round(performance.now() - t0);
    const k = DISPLAY / canvas.width;
    const box = document.createElement('div');
    box.className = 'card';
    canvas.style.width = `${DISPLAY}px`;
    const win = document.createElement('div');
    win.className = 'win';
    win.style.cssText = `left:${WIN.x * k}px;top:${WIN.y * k}px;`
      + `width:${WIN.w * k}px;height:${WIN.h * k}px`;
    win.textContent = 'window cut-out';
    // and the same card as the tape shows it: the window is a hole, so what
    // matters is the frame. Judging a face from the full sheet is how the first
    // day card ended up composed around a centre nobody ever sees.
    const seen = document.createElement('div');
    seen.className = 'seen';
    seen.style.cssText = `left:${WIN.x * k}px;top:${WIN.y * k}px;`
      + `width:${WIN.w * k}px;height:${WIN.h * k}px`;
    const cap = document.createElement('figcaption');
    cap.textContent = `FACE ${face} — ${canvas.width}×${canvas.height}  ·  built in ${build} ms`;
    const cap2 = document.createElement('figcaption');
    cap2.textContent = `FACE ${face} — as the tape shows it (window is a hole)`;
    box.append(canvas, win);
    const box2 = document.createElement('div');
    box2.className = 'card';
    const cv2 = document.createElement('img');
    cv2.src = canvas.toDataURL();
    cv2.style.width = `${DISPLAY}px`;
    box2.append(cv2, seen);
    // and again at the size the card is actually looked at on the tape — a
    // texture judged at 1000px is not the texture anyone sees, and the whole
    // reason the first day face read as a stain was that nobody checked this
    const cap3 = document.createElement('figcaption');
    cap3.textContent = `FACE ${face} — at tape size (${TAPE_W}px across)`;
    const small = new Image();
    small.src = canvas.toDataURL();
    small.style.width = `${TAPE_W}px`;
    small.style.marginBottom = '6px';
    small.style.display = 'block';
    const box3 = document.createElement('div');
    box3.className = 'card';
    box3.style.width = `${TAPE_W}px`;
    const seen3 = document.createElement('div');
    seen3.className = 'seen';
    seen3.style.cssText = `left:${(WIN.x * TAPE_W) / canvas.width}px;top:${(WIN.y * TAPE_W) / canvas.width}px;`
      + `width:${(WIN.w * TAPE_W) / canvas.width}px;height:${(WIN.h * TAPE_W) / canvas.width}px`;
    box3.append(small, seen3);

    const fig = document.createElement('figure');
    if (ONLY_SMALL) fig.append(cap3, box3);
    else fig.append(cap, box, cap2, box2, cap3, box3);
    document.body.append(fig);
  } catch (e) {
    const pre = document.createElement('pre');
    pre.style.color = '#ffb4a0';
    pre.textContent = `FACE ${face} failed: ${e.stack || e.message}`;
    document.body.append(pre);
  }
}
document.body.dataset.ready = '1';
