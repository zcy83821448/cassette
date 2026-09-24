/** Track titles off a file the user picked.
 *
 *  The page needs three strings and nothing else, so this reads the front of
 *  the file (where the ID3v2 frames live) and, failing that, the last 128 bytes
 *  (ID3v1) — a 10 MB track is never pulled through the main thread just to find
 *  out what it is called. Every path is guarded: a file this cannot read is a
 *  file that still plays, it is just named after itself.
 *
 *  ID3v2 comes in three shapes and all three are in the wild, so the frame
 *  header is read per the version in byte 3: v2.2 uses 3-character ids with a
 *  6-byte header, v2.3/2.4 use 4-character ids with a 10-byte one, and v2.4
 *  switched the frame size to a syncsafe integer (v2.3 kept a plain big-endian
 *  one). The tag's own size is syncsafe in every version.
 */

const HEAD = 10;
const MAX_TAG = 2 << 20;            // frames sit at the front; 2 MB is plenty
const LATIN1 = new TextDecoder('iso-8859-1');
const UTF8 = new TextDecoder('utf-8');

/** 7 bits per byte, the one field in the format that had to survive phones */
const syncsafe = (d, i) =>
  ((d[i] & 0x7f) << 21) | ((d[i + 1] & 0x7f) << 14) | ((d[i + 2] & 0x7f) << 7) | (d[i + 3] & 0x7f);
const be32 = (d, i) => ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;

/** Text frames are NUL-terminated, and some writers pad the rest of the frame
    out with more of them — everything after the first one is not the title. */
function cut(s) {
  const i = s.indexOf('\0');
  return (i < 0 ? s : s.slice(0, i)).trim();
}

/** id -> which field it fills. v2.2's three-letter ids still turn up on old rips */
const FIELDS = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TALB: 'album', TAL: 'album',
};

function frameText(bytes) {
  if (bytes.length < 2) return '';
  const enc = bytes[0];
  const body = bytes.subarray(1);
  if (enc === 1) {
    // UTF-16 with a BOM; without one the spec says little-endian, and every
    // other tagger writes one anyway
    const bom = body.length >= 2 && ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff)) ? 2 : 0;
    const le = bom === 0 ? true : body[0] === 0xff;
    return cut(new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(body.subarray(bom)));
  }
  if (enc === 2) return cut(new TextDecoder('utf-16be').decode(body));
  if (enc === 3) return cut(UTF8.decode(body));
  return cut(LATIN1.decode(body));
}

function parseV2(d, out) {
  if (d.length < HEAD || d[0] !== 0x49 || d[1] !== 0x44 || d[2] !== 0x33) return;
  const major = d[3], flags = d[5];
  const end = Math.min(d.length, HEAD + syncsafe(d, 6));
  let i = HEAD;
  // extended header, if the tagger wrote one — its size counts itself in v2.4
  // and excludes itself in v2.3, which is exactly the kind of thing that turns
  // the first frame into noise if you get it wrong
  if (major >= 3 && (flags & 0x40)) {
    if (i + 4 > end) return;
    i += major === 4 ? syncsafe(d, i) : be32(d, i) + 4;
  }
  const idLen = major === 2 ? 3 : 4;
  const headLen = major === 2 ? 6 : 10;
  while (i + headLen <= end) {
    let id = '';
    for (let k = 0; k < idLen; k++) id += String.fromCharCode(d[i + k]);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size = major === 2 ? (d[i + 3] << 16) | (d[i + 4] << 8) | d[i + 5]
      : major === 4 ? syncsafe(d, i + 4) : be32(d, i + 4);
    const body = i + headLen;
    if (size <= 0 || body + size > end) break;
    const key = FIELDS[id];
    if (key && !out[key]) out[key] = frameText(d.subarray(body, body + size));
    i = body + size;
  }
}

function parseV1(tail, out) {
  if (tail.length < 128 || tail[0] !== 0x54 || tail[1] !== 0x41 || tail[2] !== 0x47) return;
  const s = (a, b) => cut(LATIN1.decode(tail.subarray(a, b)));
  out.title ||= s(3, 33);
  out.artist ||= s(33, 63);
  out.album ||= s(63, 93);
}

/** "01 - my_song.mp3" -> "01 - my song": the file's own name is a better
    answer than an empty label when it carries no tags at all */
export function titleFromFilename(name) {
  return name
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function readTags(file) {
  const out = { title: '', artist: '', album: '' };
  try {
    const head = new Uint8Array(await file.slice(0, HEAD).arrayBuffer());
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const total = HEAD + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);   // + footer
      const d = new Uint8Array(await file.slice(0, Math.min(total, MAX_TAG)).arrayBuffer());
      parseV2(d, out);
    }
    if (!out.title && !out.artist && file.size > 128) {
      parseV1(new Uint8Array(await file.slice(file.size - 128).arrayBuffer()), out);
    }
  } catch { /* unreadable or not a tag at all — the name still works */ }
  if (!out.title) out.title = titleFromFilename(file.name || '');
  return out;
}

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|flac|wav|wave|ogg|oga|opus|weba|webm|mp4|aif|aiff|wma)$/i;

/** What the picker's `accept` cannot enforce: a drag-and-drop has no filter at
    all, and Windows hands over an empty type for plenty of real audio files. */
export function looksLikeAudio(file) {
  return (file.type || '').startsWith('audio/') || AUDIO_EXT.test(file.name || '');
}
