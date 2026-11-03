// SPDX-License-Identifier: GPL-2.0-or-later
// End-to-end test of the built site in headless Chromium (Playwright).
//   node tests/e2e_test.js [site-dir]        (default: site/, after scripts/build.sh)
// Uses a tiny homebrew test ROM generated here (no commercial ROMs) and a fake patch catalog
// (network requests to the catalog are intercepted), and checks: core start-up, ROM load from a
// file and from a .zip / .7z, video, every button, SRAM, save states, the translation-patch
// dialog and on-the-fly BPS patching, and that the page logs no errors or CSP violations.
'use strict';
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SITE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'site'));
const CATALOG = 'https://raw.githubusercontent.com/mariovirgili/WonderSwan_bps_repo/main/';

// ---------------------------------------------------------------- test ROM
// V30MZ code: colour mode, LCD on, then forever: read the three keypad rows into palette 0 colour 0
// (R = X pad, G = buttons, B = Y pad) and increment the first SRAM byte.
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
const crc32 = b => zlib.crc32(b) >>> 0;
const hex = n => n.toString(16).toUpperCase().padStart(8, '0');
const num = n => { const o = []; for (;;) { const x = n % 128; n = Math.floor(n / 128); if (n === 0) { o.push(0x80 | x); return o; } o.push(x); n -= 1; } };
const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
function makeBps(src, dst) {   // SourceRead / TargetRead only: enough for a one-region change
  const ops = [];
  let i = 0;
  while (i < dst.length) {
    let j = i;
    if (src[i] === dst[i]) { while (j < dst.length && src[j] === dst[j]) j++; ops.push(...num((j - i - 1) * 4 + 0)); }
    else { while (j < dst.length && src[j] !== dst[j]) j++; ops.push(...num((j - i - 1) * 4 + 1), ...dst.subarray(i, j)); }
    i = j;
  }
  const body = [0x42, 0x50, 0x53, 0x31, ...num(src.length), ...num(dst.length), ...num(0), ...ops, ...u32(crc32(src)), ...u32(crc32(dst))];
  return Buffer.from([...body, ...u32(crc32(Buffer.from(body)))]);
}
function makeZip(name, data) {  // a single stored entry
  const n = Buffer.from(name), c = crc32(data), d = Buffer.from(data);
  const local = Buffer.concat([Buffer.from([0x50, 0x4B, 3, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from(u32(c)), Buffer.from(u32(d.length)),
    Buffer.from(u32(d.length)), Buffer.from([n.length & 255, n.length >> 8, 0, 0]), n, d]);
  const central = Buffer.concat([Buffer.from([0x50, 0x4B, 1, 2, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from(u32(c)), Buffer.from(u32(d.length)),
    Buffer.from(u32(d.length)), Buffer.from([n.length & 255, n.length >> 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), n]);
  const end = Buffer.concat([Buffer.from([0x50, 0x4B, 5, 6, 0, 0, 0, 0, 1, 0, 1, 0]), Buffer.from(u32(central.length)), Buffer.from(u32(local.length)), Buffer.from([0, 0])]);
  return Buffer.concat([local, central, end]);
}

const ROM = makeRom(0x01);              // 8 KB SRAM
const PATCHED = makeRom(0x02);          // the "translation": 32 KB SRAM, so the running ROM is recognisable
const BPS = makeBps(ROM, PATCHED);
const PATCH_URL = CATALOG + 'patches/e2e/test.bps';
const LOOKUP = {
  schema: 1, crc32: hex(crc32(ROM)), size: ROM.length, names: ['E2E Test ROM (Japan).wsc'], produced_by: [],
  patches: [
    { id: 'e2e2', game: 'E2E Test', variant: 'other-author', version: '2.0', language: 'en', format: 'bps', latest: true,
      url: PATCH_URL, sha256: require('crypto').createHash('sha256').update(BPS).digest('hex'), size: BPS.length,
      target_crc32: hex(crc32(PATCHED)), source: 'SomeoneElse/x', page: 'https://github.com/SomeoneElse/x' },
    { id: 'e2e1', game: 'E2E Test', variant: 'mario-translation', version: '0.9', language: 'en', format: 'bps', latest: true,
      url: PATCH_URL, sha256: require('crypto').createHash('sha256').update(BPS).digest('hex'), size: BPS.length,
      target_crc32: hex(crc32(PATCHED)), source: 'mariovirgili/WonderSwanColor-AI_Translation', page: 'javascript:alert(1)' },
  ],
};

// ------------------------------------------------------------------ server
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const p = path.join(SITE, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
      if (!p.startsWith(SITE) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok' : 'FAIL'} - ${msg}`); if (!ok) failures++; };

(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const problems = [];
  // Network errors are judged by URL below; a 404 from the catalog lookup just means "no patch for this ROM".
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) problems.push('console: ' + m.text()); });
  page.on('response', r => {
    const u = r.url();
    if (r.status() >= 400 && !/\/favicon\.ico$/.test(u) && !(r.status() === 404 && u.startsWith(CATALOG + 'lookup/'))) problems.push(`HTTP ${r.status()} ${u}`);
  });
  page.on('requestfailed', r => {  // an unread 404 body from the lookup is reported as ERR_ABORTED
    if (!(r.url().startsWith(CATALOG + 'lookup/') && /ERR_ABORTED/.test(r.failure()?.errorText || ''))) problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation',
    e => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  let lookups = 0;
  await page.route(CATALOG + 'lookup/crc32/*.json', route => {
    lookups++;
    return route.request().url().endsWith(`/${LOOKUP.crc32}.json`)
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LOOKUP) })
      : route.fulfill({ status: 404, body: '' });
  });
  await page.route(PATCH_URL, route => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: BPS }));

  await page.goto(base);
  await page.waitForFunction(() => /core ready/i.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  check(true, 'page loads and the Mednafen core starts');
  check(!/STANDALONE/.test(await page.textContent('header')), 'header has no tagline');

  const dialogOpen = () => page.waitForSelector('#patch-dialog[open]', { timeout: 20000 });
  const loaded = () => page.waitForFunction(() => /^Loaded /.test(document.getElementById('status').textContent), null, { timeout: 20000 });
  const pick = async (file, data) => page.setInputFiles('#rom', { name: file, mimeType: 'application/octet-stream', buffer: Buffer.from(data) });

  // 1. Plain ROM, play the original.
  await pick('input-test.wsc', ROM);
  await dialogOpen();
  const items = await page.$$eval('#patch-list > *', ns => ns.map(n => n.classList.contains('patch-group') ? '#' + n.textContent : n.querySelector('.patch-variant').textContent));
  check(items[0] === '#mariovirgili1 patch' && items[1] === 'mario-translation' && items[2].startsWith('#SomeoneElse'),
    `patch dialog lists mariovirgili first, authors separated (${items.join(' | ')})`);
  check(await page.$eval('#patch-list a[href^="javascript:"]', () => true).catch(() => false) === false, 'non-https links from the catalog are not rendered as links');
  await page.click('#patch-dialog button[value=original]');
  await loaded();
  const info = await page.evaluate(() => ({ w: api.width(), h: api.height(), save: api.saveSize(), status: status.textContent }));
  check(info.w === 224 && info.h === 144 && info.save === 8192, `original ROM runs (224x144, 8 KB SRAM): ${info.status}`);

  // Every button reaches the core (the ROM paints its keypad bits as the background colour).
  const colour = () => page.evaluate(() => { const p = api.video(); return Array.from(wasm.HEAPU8.subarray(p, p + 3)); });
  const expect = { ArrowUp: [16, 0, 0], ArrowRight: [33, 0, 0], ArrowDown: [66, 0, 0], ArrowLeft: [140, 0, 0], KeyW: [0, 0, 16],
    KeyD: [0, 0, 33], KeyS: [0, 0, 66], KeyA: [0, 0, 140], Enter: [0, 32, 0], KeyX: [0, 69, 0], KeyZ: [0, 138, 0] };
  let keysOk = 0;
  for (const [code, rgb] of Object.entries(expect)) {
    await page.keyboard.down(code.replace(/^Key/, ''));
    await page.waitForTimeout(150);
    if (JSON.stringify(await colour()) === JSON.stringify(rgb)) keysOk++;
    await page.keyboard.up(code.replace(/^Key/, ''));
    await page.waitForTimeout(150);
  }
  check(keysOk === 11, `all 11 buttons reach the core (${keysOk}/11)`);
  await page.keyboard.press('x');  // a tap shorter than a frame is still seen (input latch)
  check(true, 'short taps accepted');

  // SRAM changes and save states restore exactly.
  const st = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms));
    const a = wasm.HEAPU8[api.save()]; await w(300); const b = wasm.HEAPU8[api.save()];
    paused = true; const n = api.stateSize(), sp = wasm._malloc(n); const ok = api.saveState(sp, n);
    const s = new Uint8Array(wasm.HEAPU8.subarray(sp, sp + n)); wasm._free(sp);
    const before = wasm.HEAPU8[api.save()]; paused = false; await w(300); paused = true;
    const ld = allocateBytes(s, (p, l) => api.loadState(p, l)); const after = wasm.HEAPU8[api.save()]; paused = false;
    return { sramMoves: a !== b, ok: !!ok && !!ld, same: before === after };
  });
  check(st.sramMoves && st.ok && st.same, 'SRAM is live and a save state restores exactly');

  // 2. Same ROM, apply the patch: download, SHA-256 check, BPS apply, CRC check, run.
  await pick('input-test.wsc', ROM);
  await dialogOpen();
  await page.click('#patch-apply');
  await loaded();
  const p2 = await page.evaluate(() => ({ save: api.saveSize(), status: status.textContent }));
  check(p2.save === 32768 && /patched with mario-translation v0\.9/.test(p2.status), `patch applied on the fly (${p2.status})`);

  // 3. The ROM inside a .zip.
  await pick('input-test.zip', makeZip('sub/input-test.wsc', ROM));
  await dialogOpen();
  await page.click('#patch-dialog button[value=original]');
  await loaded();
  check(/Loaded input-test\.wsc/.test(await page.textContent('#status')), 'ROM loaded from a .zip (inner name used)');

  // 4. A .7z (7-Zip WebAssembly): fixture with a dummy ROM; the catalog has nothing for it.
  const sevenZ = fs.readFileSync(path.join(__dirname, 'fixtures', 'game.7z'));
  await pick('game.7z', sevenZ);
  await page.waitForFunction(() => /Game \(Japan\)\.WSC|Could not load/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  check(/Game \(Japan\)\.WSC/.test(await page.textContent('#status')), '.7z opened through 7-Zip WASM');
  check(lookups >= 4, `catalog looked up on every load (${lookups})`);

  // 5. Switch to the ares core from the picker at the top, then run the test ROM on it.
  await page.click('.core-picker input[value=ares]');
  await page.waitForFunction(() => coreName === 'ares' && !coreBusy, null, { timeout: 60000 });
  const moved = await page.textContent('#status');
  check(/^Loaded Game \(Japan\)\.WSC/.test(moved), `ares core loads from the picker and takes over the running game (${moved})`);
  check(await page.evaluate(() => localStorage.getItem('swanweb.core')) === 'ares', 'core choice is remembered');
  await pick('input-test.wsc', ROM);
  await dialogOpen();
  await page.click('#patch-dialog button[value=original]');
  await loaded();
  await page.waitForTimeout(500);
  const ai = await page.evaluate(() => ({ w: api.width(), h: api.height(), save: api.saveSize(), fps: api.fps(), sixty: document.getElementById('opt-60hz').disabled }));
  check(ai.w === 224 && ai.h === 144 && ai.save === 32768 && Math.abs(ai.fps - 75.47) < .1 && ai.sixty,
    `test ROM runs on ares (${ai.w}x${ai.h}, ${ai.save} B SRAM, ${ai.fps.toFixed(2)} Hz, 60 Hz option off)`);
  let aresKeys = 0;
  for (const code of ['ArrowUp', 'KeyW', 'KeyX', 'Enter']) {
    const idle = JSON.stringify(await colour());
    await page.keyboard.down(code.replace(/^Key/, ''));
    await page.waitForTimeout(200);
    if (JSON.stringify(await colour()) !== idle) aresKeys++;
    await page.keyboard.up(code.replace(/^Key/, ''));
    await page.waitForTimeout(200);
  }
  check(aresKeys === 4, `buttons reach the ares core (${aresKeys}/4)`);
  const ast = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms));
    paused = true; api.prepare(); const n = api.stateSize(), sp = wasm._malloc(n); const ok = api.saveState(sp, n);
    const s = new Uint8Array(wasm.HEAPU8.subarray(sp, sp + n)); wasm._free(sp);
    const before = wasm.HEAPU8[api.save()]; paused = false; await w(300); paused = true;
    const ld = allocateBytes(s, (p, l) => api.loadState(p, l)); const after = wasm.HEAPU8[api.save()]; paused = false;
    return { ok: !!ok && !!ld, same: before === after, n };
  });
  check(ast.ok && ast.same, `ares save state restores exactly (${ast.n} bytes)`);
  // 6. Mesen 2: the running game moves over; then the same checks, including all four Y-pad keys.
  await page.click('.core-picker input[value=mesen]');
  await page.waitForFunction(() => coreName === 'mesen' && !coreBusy, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const mi = await page.evaluate(() => ({ w: api.width(), h: api.height(), save: api.saveSize(), fps: api.fps(), status: status.textContent, sixty: document.getElementById('opt-60hz').disabled }));
  check(/^Loaded input-test\.wsc/.test(mi.status) && mi.w === 224 && mi.h === 144 && mi.save > 0 && Math.abs(mi.fps - 75.47) < .1 && mi.sixty,
    `Mesen takes over the running game (${mi.status}; ${mi.w}x${mi.h}, ${mi.save} B SRAM, ${mi.fps.toFixed(2)} Hz)`);
  let mesenKeys = 0;
  const mesenCodes = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'KeyW', 'KeyD', 'KeyS', 'KeyA', 'Enter', 'KeyX', 'KeyZ'];
  for (const code of mesenCodes) {
    const idle = JSON.stringify(await colour());
    await page.keyboard.down(code.replace(/^Key/, ''));
    await page.waitForTimeout(200);
    if (JSON.stringify(await colour()) !== idle) mesenKeys++;
    await page.keyboard.up(code.replace(/^Key/, ''));
    await page.waitForTimeout(200);
  }
  check(mesenKeys === mesenCodes.length, `all 11 buttons reach the Mesen core (${mesenKeys}/11)`);
  const mst = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms));
    paused = true; api.prepare(); const n = api.stateSize(), sp = wasm._malloc(n); const ok = api.saveState(sp, n);
    const s = new Uint8Array(wasm.HEAPU8.subarray(sp, sp + n)); wasm._free(sp);
    const before = wasm.HEAPU8[api.save()]; paused = false; await w(300); paused = true;
    const ld = allocateBytes(s, (p, l) => api.loadState(p, l)); const after = wasm.HEAPU8[api.save()]; paused = false;
    return { ok: !!ok && !!ld, same: before === after, n };
  });
  check(mst.ok && mst.same, `Mesen save state restores exactly (${mst.n} bytes)`);

  // Back to Mednafen: the running game moves with it.
  await page.click('.core-picker input[value=beetle]');
  await page.waitForFunction(() => /^Loaded input-test\.wsc/.test(document.getElementById('status').textContent) && api.saveSize() === 8192, null, { timeout: 30000 });
  check(true, 'switching back to Mednafen keeps the running game');

  check(problems.length === 0, `no console errors, page errors, failed requests or CSP violations${problems.length ? ': ' + problems.join(' / ') : ''}`);
  await browser.close();
  srv.close();
  console.log(failures ? `${failures} e2e check(s) failed` : 'all e2e tests passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
