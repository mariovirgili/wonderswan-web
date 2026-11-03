// SPDX-License-Identifier: GPL-2.0-or-later
/* The emulator core runs here, in a Web Worker, so the page stays smooth while it works.
 *
 * One worker per core (core.js, core-ares.js, core-mesen.js: all export the same ws_* C API).
 * The page sends requests {id, cmd, args} and gets {id, ok, result | error} back, in order:
 * requests are handled one at a time. 'run' runs a batch of frames, one input mask per frame,
 * and returns the last picture (RGBA) and the sound of the whole batch, both transferred.
 * Log lines go to the page as {log: {level, text}}.
 */
'use strict';
let m = null;

const log = (level, text) => postMessage({ log: { level, text: String(text) } });

function withBytes(bytes, cb) {
  const p = m._malloc(bytes.length || 1);
  if (!p) throw Error('Out of WASM memory');
  try { m.HEAPU8.set(bytes, p); return cb(p, bytes.length); } finally { m._free(p); }
}
function copy(ptr, n) { return ptr && n ? m.HEAPU8.slice(ptr, ptr + n) : null; }
function info() {
  return { width: m._ws_get_width(), height: m._ws_get_height(), fps: m._ws_get_fps(),
           rate: m._ws_get_sample_rate(), saveSize: m._ws_get_save_size() };
}
let setOptionFn = null;
const setOption = (key, value) => (setOptionFn ||= m.cwrap('ws_set_option', 'number', ['string', 'string']))(key, value);

const handlers = {
  async init({ script, factory }) {
    try { importScripts(script); } catch { throw Error(`${script.replace(/^\.\//, '')} is missing. Build the project with Emscripten first.`); }
    m = await self[factory]({
      locateFile: path => new URL(path, self.location.href).href,
      print: text => log('debug', text),
      // A core's stderr: Mesen's libretro front end reports normal progress there ('[libretro] ...').
      printErr: text => log(/^\[libretro\]/.test(text) ? 'debug' : 'error', text),
    });
    m._ws_init();
    return {};
  },
  load({ rom }) {
    const ok = withBytes(rom, (p, n) => m._ws_load(p, n));
    return { ok: !!ok, ...info() };
  },
  unload() { m._ws_unload(); return {}; },
  reset() { m._ws_reset(); return {}; },
  setOption({ key, value }) { return setOption(key, value); },
  run({ masks, wantAudio }) {
    const t0 = performance.now(), parts = [];
    let total = 0;
    for (const mask of masks) {
      m._ws_set_input(mask >>> 0);
      m._ws_run();
      if (wantAudio) {
        const n = m._ws_get_audio_frames();
        if (n) { parts.push(copy(m._ws_get_audio(), n * 4)); total += n; }
      }
    }
    const w = m._ws_get_width(), h = m._ws_get_height();
    const video = w && h && w <= 1024 && h <= 1024 ? copy(m._ws_get_video(), w * h * 4) : new Uint8Array(0);
    const pcm = new Int16Array(total * 2);
    let o = 0;
    for (const part of parts) { const s = new Int16Array(part.buffer); pcm.set(s, o); o += s.length; }
    const result = { video, width: w, height: h, fps: m._ws_get_fps(), rate: m._ws_get_sample_rate(), pcm, frames: masks.length,
                     ms: performance.now() - t0 };
    return [result, [video.buffer, pcm.buffer]];
  },
  getSave() { return copy(m._ws_get_save(), m._ws_get_save_size()); },
  setSave({ bytes }) { return !!withBytes(bytes, (p, n) => m._ws_set_save(p, n)); },
  saveState() {
    m._ws_prepare_state();
    const n = m._ws_get_state_size();
    if (!n) return null;
    return withBytes(new Uint8Array(n), (p, len) => (m._ws_save_state(p, len) ? m.HEAPU8.slice(p, p + len) : null));
  },
  loadState({ bytes }) { return !!withBytes(bytes, (p, n) => m._ws_load_state(p, n)); },
};

onmessage = async e => {
  const { id, cmd, args } = e.data;
  try {
    if (!handlers[cmd]) throw Error(`unknown request ${cmd}`);
    if (cmd !== 'init' && !m) throw Error('core not started');
    let result = await handlers[cmd](args || {}), transfer = [];
    if (Array.isArray(result)) [result, transfer] = result;
    postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
