// SPDX-License-Identifier: GPL-2.0-or-later
// Test of a WebAssembly core in Node (ares: site/core-ares.js, Mesen 2: site/core-mesen.js), with
// the homebrew test ROM of tests/e2e_test.js: start-up, video, input, battery RAM, save states,
// reset, and the time an emulated frame takes.
//   node tests/core_test.js [site-dir] [ares|mesen]
'use strict';
const path = require('path');
const SITE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'site'));
const CORES = { ares: ['core-ares.js', 'createAres'], mesen: ['core-mesen.js', 'createMesen'] };
const NAME = process.argv[3] || 'ares';
if (!CORES[NAME]) { console.error(`unknown core ${NAME}`); process.exit(2); }

// Same program as tests/e2e_test.js: colour mode, LCD on, then forever: keypad rows -> palette 0
// colour 0 (R = X pad, G = buttons, B = Y pad) and increment the first SRAM byte.
const CODE = 'fa31c08ed88ed0bc0020b080e660b001e61430c0e600e601b020e6b59090e4b5240f88c4b040e6b59090e4b5240fc0e00488c2b010e6b59090e4b5240f08d0a300febb00108ec326fe060000ebca';
function makeRom(saveType) {
  const rom = new Uint8Array(0x20000).fill(0xFF);
  CODE.match(/../g).forEach((h, i) => { rom[0x10000 + i] = parseInt(h, 16); });
  rom.set([0xEA, 0x00, 0x00, 0x00, 0xF0, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, saveType, 0x04, 0x00, 0x00, 0x00], 0x1FFF0);
  let s = 0;
  for (let i = 0; i < 0x1FFFE; i++) s = (s + rom[i]) & 0xFFFF;
  rom[0x1FFFE] = s & 255; rom[0x1FFFF] = s >> 8;
  return rom;
}

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok' : 'FAIL'} - ${msg}`); if (!ok) failures++; };

(async () => {
  const create = require(path.join(SITE, CORES[NAME][0]));
  const m = await create({ locateFile: f => path.join(SITE, f), printErr: () => {}, print: () => {} });
  const c = (n, r, a) => m.cwrap(n, r, a);
  const api = {
    init: c('ws_init', 'number', []), load: c('ws_load', 'number', ['number', 'number']), run: c('ws_run', null, []),
    input: c('ws_set_input', null, ['number']), width: c('ws_get_width', 'number', []), height: c('ws_get_height', 'number', []),
    video: c('ws_get_video', 'number', []), frames: c('ws_get_audio_frames', 'number', []), rate: c('ws_get_sample_rate', 'number', []),
    fps: c('ws_get_fps', 'number', []), saveSize: c('ws_get_save_size', 'number', []), save: c('ws_get_save', 'number', []),
    setSave: c('ws_set_save', 'number', ['number', 'number']), prepare: c('ws_prepare_state', null, []),
    stateSize: c('ws_get_state_size', 'number', []), saveState: c('ws_save_state', 'number', ['number', 'number']),
    loadState: c('ws_load_state', 'number', ['number', 'number']), reset: c('ws_reset', null, []), unload: c('ws_unload', null, []),
  };
  check(api.init() === 1, 'core initialises');
  const rom = makeRom(0x02);
  const p = m._malloc(rom.length); m.HEAPU8.set(rom, p);
  check(api.load(p, rom.length) === 1, 'ROM loads');
  m._free(p);
  const pixel = () => { const v = api.video(); return Array.from(m.HEAPU8.subarray(v, v + 3)); };
  const frames = n => { for (let i = 0; i < n; i++) api.run(); };

  const t0 = process.hrtime.bigint();
  let audio = 0;
  for (let i = 0; i < 600; i++) { api.run(); audio += api.frames(); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 600;
  console.log(`# ${NAME}: ${ms.toFixed(3)} ms per emulated frame (${(1000 / 75.47 / ms).toFixed(1)}x real time), ${(audio / 600).toFixed(1)} audio frames/frame at ${api.rate()} Hz`);
  check(api.width() === 224 && api.height() === 144, `video is 224x144 (${api.width()}x${api.height()})`);
  check(Math.abs(api.fps() - 75.47) < 0.1, `75.47 Hz (${api.fps()})`);
  check(Math.abs(audio / 600 - api.rate() / api.fps()) < 20, 'audio arrives at the stated rate');
  check(ms < 13.25, 'faster than real time in Node');

  const black = JSON.stringify(pixel());
  const seen = {};
  // The cores emulate the LCD's colour response, so each button gives a distinct mix, not a pure channel.
  for (const bit of [4, 7, 5, 6, 13, 11, 12, 10, 3, 8, 0]) {
    api.input(1 << bit); frames(4);
    const px = pixel(); seen[bit] = px;
    api.input(0); frames(4);
  }
  const distinct = new Set(Object.values(seen).map(String)).size;
  check(distinct === 11 && !Object.values(seen).some(px => JSON.stringify(px) === black), `all 11 buttons reach the core (${distinct} distinct colours)`);

  check(api.saveSize() === 32768, `32 KB SRAM (${api.saveSize()})`);
  const sram = () => { const s = api.save(); return m.HEAPU8[s]; };
  const a = sram(); frames(10); const b = sram();
  check(a !== b, 'SRAM is live');

  api.prepare();
  const n = api.stateSize(), sp = m._malloc(n);
  check(n > 1000 && api.saveState(sp, n) === 1, `save state (${n} bytes)`);
  const before = sram(); frames(30);
  check(api.loadState(sp, n) === 1 && sram() === before, 'state restores exactly');
  m._free(sp);
  frames(5);

  const saved = new Uint8Array(m.HEAPU8.subarray(api.save(), api.save() + api.saveSize()));
  saved[0] = 0x5A;
  const q = m._malloc(saved.length); m.HEAPU8.set(saved, q);
  check(api.setSave(q, saved.length) === 1 && m.HEAPU8[api.save()] === 0x5A, 'SRAM import');
  m._free(q);
  api.reset(); frames(5);
  check(api.width() === 224, 'reset');
  api.unload();
  {
    // A Color-only game whose header lacks the Color flag (as Judgement Silversword): as a .wsc file
    // (option bridge_content_ext = "wsc") it runs on the WonderSwan Color, otherwise on the mono model.
    const setOpt = c('ws_set_option', 'number', ['string', 'string']);
    const rom = makeRom(0x01); rom[0x1FFF7] = 0;
    let sum = 0; for (let i = 0; i < 0x1FFFE; i++) sum = (sum + rom[i]) & 0xFFFF; rom[0x1FFFE] = sum & 255; rom[0x1FFFF] = sum >> 8;
    const upColour = ext => {
      setOpt('bridge_content_ext', ext);
      const p = m._malloc(rom.length); m.HEAPU8.set(rom, p); const ok = api.load(p, rom.length); m._free(p);
      frames(40); api.input(1 << 4); frames(6); const px = pixel(); api.input(0); api.unload(); return ok ? px : null;
    };
    const asWsc = upColour('wsc'), asWs = upColour('');
    setOpt('bridge_content_ext', '');
    const red = px => !!px && px[0] > px[1] && px[0] > px[2];  // the X-pad colour (red; ares tints it like the LCD); the mono model is grey
    check(red(asWsc) && !red(asWs),
      `a .wsc ROM without the Color flag runs on the WonderSwan Color (${asWsc}; as .ws: ${asWs})`);
  }
  if (NAME === 'mesen') {
    // Mesen also runs other systems, chosen by the file extension the bridge gives the ROM
    // (option bridge_content_ext): tiny homebrew ROMs boot at each system's screen size.
    const roms = require('./other_systems.js'), setOpt = c('ws_set_option', 'number', ['string', 'string']);
    const sizes = { nes: [roms.nes, '256x240'], gb: [roms.gb, '160x144'], gbc: [roms.gb, '160x144'], sms: [roms.sms, '256x192'],
      gg: [roms.sms, '160x144'], pce: [roms.pce, ''], sfc: [roms.snes, '256x224'] };
    for (const [ext, [make, size]] of Object.entries(sizes)) {
      const rom = make(); setOpt('bridge_content_ext', ext);
      const p = m._malloc(rom.length); m.HEAPU8.set(rom, p); const ok = api.load(p, rom.length); m._free(p);
      frames(30);
      const got = `${api.width()}x${api.height()}`;
      check(ok === 1 && (!size || got === size) && api.fps() > 50, `${ext} ROM boots on Mesen (${got}, ${api.fps().toFixed(2)} Hz)`);
      if (ext === 'gb') { const [r, g, b] = pixel(); check(r === g && g === b, `an original Game Boy game runs on the Game Boy, in greys, not GBC colours (${r},${g},${b})`); }
      if (ext === 'nes') {
        const idle = pixel(); api.input(1 << 8); frames(4); const held = pixel(); api.input(0);
        check(JSON.stringify(idle) !== JSON.stringify(held), `NES controller reaches the game (${idle} -> ${held})`);
      }
      api.unload();
    }
    setOpt('bridge_content_ext', '');
  }
  console.log(failures ? `${failures} ${NAME} check(s) failed` : `all ${NAME} core tests passed`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
