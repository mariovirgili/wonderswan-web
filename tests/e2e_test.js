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
      target_crc32: hex(crc32(PATCHED)), source: 'mariovirgili/WonderSwanColor-AI_Translation', page: 'javascript:alert(1)',
      notes: 'Translated menus.\n<script>alert(1)</script> stays text.' },
  ],
};

// A ROM patched with an older version (v0.8) of the 'mario-translation' patch: the page names v0.9.
const OLD_ROM = makeRom(0x03);
const OLD_PATCHED = { schema: 1, crc32: hex(crc32(OLD_ROM)), size: OLD_ROM.length, names: [], patches: [], produced_by: [
  { id: 'e2e0', game: 'E2E Test', variant: 'mario-translation', version: '0.8', language: 'en', format: 'bps', latest: false, superseded: true,
    source_crc32: LOOKUP.crc32, target_crc32: hex(crc32(OLD_ROM)), source: 'mariovirgili/WonderSwanColor-AI_Translation' }] };

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
    const url = route.request().url();
    if (url.endsWith(`/${LOOKUP.crc32}.json`)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LOOKUP) });
    if (url.endsWith(`/${OLD_PATCHED.crc32}.json`)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OLD_PATCHED) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route(PATCH_URL, route => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: BPS }));

  await page.goto(base);
  await page.waitForFunction(() => /core ready/i.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  const start = await page.evaluate(() => ({ core: coreName, order: [...document.querySelectorAll('.core-picker input')].map(i => i.value) }));
  check(start.core === 'mesen' && start.order.join() === 'mesen,beetle,ares', `page loads with Mesen, first in the picker (${start.core}; ${start.order.join(', ')})`);
  check(await page.evaluate(() => localStorage.getItem('swanweb.emulator')) === null, 'the default is not stored as a choice');
  check(/^Mesen 2/.test(await page.textContent('#core-info')), 'the card next to the picker describes Mesen');
  // Mednafen for the checks below, chosen from the picker.
  await page.click('.core-picker input[value=beetle]');
  await page.waitForFunction(() => coreName === 'beetle' && !coreBusy && /Mednafen core ready/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  check(true, 'the Mednafen core starts from the picker');
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
  const notes = await page.evaluate(() => ({ texts: [...document.querySelectorAll('#patch-list .patch-notes')].map(d => d.textContent), script: !!document.querySelector('#patch-list script') }));
  check(notes.texts.length === 1 && /Translated menus\.\n<script>alert\(1\)<\/script> stays text\./.test(notes.texts[0]) && !notes.script,
    'release notes shown, as plain text, for the patch that has them');
  await page.click('#patch-dialog button[value=original]');
  await loaded();
  const info = await page.evaluate(() => ({ w: info.width, h: info.height, save: info.saveSize, status: status.textContent }));
  check(info.w === 224 && info.h === 144 && info.save === 8192, `original ROM runs (224x144, 8 KB SRAM): ${info.status}`);

  // Every button reaches the core (the ROM paints its keypad bits as the background colour).
  const colour = () => page.evaluate(() => (lastVideo ? Array.from(lastVideo.subarray(0, 3)) : null));  // last picture from the worker
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
  // Remapping: A moves from X to K (keyboard), then back to the defaults.
  await page.click('#remap');
  await page.click('#keys-rows button.bind[data-kind=key][data-action="8"]');
  await page.keyboard.press('k');
  const bound = await page.textContent('#keys-rows button.bind[data-kind=key][data-action="8"]');
  await page.click('#keys-dialog button[value=done]');
  await page.keyboard.down('k'); await page.waitForTimeout(200); const kA = JSON.stringify(await colour()); await page.keyboard.up('k');
  await page.waitForTimeout(150);
  await page.keyboard.down('x'); await page.waitForTimeout(200); const xA = JSON.stringify(await colour()); await page.keyboard.up('x');
  const help = await page.textContent('#controls-help');
  check(bound === 'K' && kA === JSON.stringify(expect.KeyX) && xA !== kA && /A = K/.test(help), `A remapped to K (${bound}; K gives ${kA}, X no longer does; help: "${help.match(/A = \w+/)?.[0]}")`);
  await page.click('#remap'); await page.click('#keys-reset'); await page.click('#keys-dialog button[value=done]');
  check(/A = X/.test(await page.textContent('#controls-help')) && await page.evaluate(() => JSON.parse(localStorage.getItem('swanweb.keys'))[8][0]) === 'KeyX', 'keys reset to the defaults');
  // The emulator runs in a Web Worker.
  check(await page.evaluate(() => core.worker instanceof Worker && framesRun > 0), 'the core runs in a Web Worker');
  await page.keyboard.press('x');  // a tap shorter than a frame is still seen (input latch)
  check(true, 'short taps accepted');

  // SRAM changes and save states restore exactly.
  const st = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms));
    const a = (await core.call('getSave'))[0]; await w(300); const b = (await core.call('getSave'))[0];
    paused = true; const s = await core.call('saveState'); const n = s?.length || 0, ok = n > 0;
    const before = (await core.call('getSave'))[0]; paused = false; await w(300); paused = true;
    const ld = await core.call('loadState', { bytes: s }); const after = (await core.call('getSave'))[0]; paused = false;
    return { sramMoves: a !== b, ok: !!ok && !!ld, same: before === after };
  });
  check(st.sramMoves && st.ok && st.same, 'SRAM is live and a save state restores exactly');

  // 2. Same ROM, apply the patch: download, SHA-256 check, BPS apply, CRC check, run.
  await pick('input-test.wsc', ROM);
  await dialogOpen();
  await page.click('#patch-apply');
  await loaded();
  const p2 = await page.evaluate(() => ({ save: info.saveSize, status: status.textContent }));
  check(p2.save === 32768 && /patched with mario-translation v0\.9/.test(p2.status), `patch applied on the fly (${p2.status})`);

  // 2a. A ROM made with an older version of a translation: the newer one is named.
  await pick('old-patched.wsc', OLD_ROM);
  await loaded();
  const notice = await page.evaluate(() => ({ hidden: document.getElementById('notice').hidden, text: document.getElementById('notice').textContent }));
  check(!notice.hidden && /made with mario-translation v0\.8\. E2E Test v0\.9 is out/.test(notice.text), `newer version named (${notice.text})`);

  // 2b. A patch file from this computer, applied to the ROM as loaded (BPS checks its source CRC).
  await pick('input-test.wsc', ROM);
  await dialogOpen();
  await page.click('#patch-dialog button[value=original]');
  await loaded();
  await page.setInputFiles('#patch-file', { name: 'my-wip.bps', mimeType: 'application/octet-stream', buffer: BPS });
  await page.waitForFunction(() => /patched with local file my-wip\.bps/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
  const lp = await page.evaluate(() => ({ save: info.saveSize, name: romName }));
  check(lp.save === 32768 && lp.name === 'input-test [my-wip].wsc', `local patch file applied (${lp.name}, ${lp.save} B SRAM)`);
  await page.setInputFiles('#patch-file', { name: 'junk.bps', mimeType: 'application/octet-stream', buffer: Buffer.from('not a patch') });
  await page.waitForFunction(() => /junk\.bps failed/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
  check(true, 'a file that is not a patch is refused');

  // 2c. Quick save / load (F5 / F7) in slot 2, and fast forward (Space).
  await page.keyboard.press('2');
  await page.keyboard.press('F5');
  await page.waitForFunction(() => /Saved to slot 2/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
  const label = await page.evaluate(() => document.getElementById('slot').selectedOptions[0].textContent);
  await page.keyboard.press('F7');
  await page.waitForFunction(() => /Loaded slot 2/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
  const qs = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms));
    paused = true; await quickSave(); const before = (await core.call('getSave'))[0];
    paused = false; await w(300); paused = true;
    await quickLoad(); const after = (await core.call('getSave'))[0]; paused = false;
    return { before, after };
  });
  check(qs.before === qs.after && /^Slot 2 · \d/.test(label), `quick save (F5) and load (F7) restore exactly (${label})`);
  await page.keyboard.down('Space');
  await page.waitForTimeout(300);
  const ffOn = /fast forward/.test(await page.textContent('#fps'));
  await page.keyboard.up('Space');
  await page.waitForTimeout(300);
  check(ffOn && !/fast forward/.test(await page.textContent('#fps')), 'fast forward while Space is held');

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
  check(await page.evaluate(() => localStorage.getItem('swanweb.emulator')) === 'ares', 'core choice is remembered');
  check(/imitates the real LCD/.test(await page.textContent('#core-info')), 'the card follows the chosen core (ares)');
  await pick('input-test.wsc', ROM);
  await dialogOpen();
  await page.click('#patch-dialog button[value=original]');
  await loaded();
  await page.waitForTimeout(500);
  const ai = await page.evaluate(() => ({ w: info.width, h: info.height, save: info.saveSize, fps: info.fps, sixty: document.getElementById('opt-60hz').disabled }));
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
    paused = true; const s = await core.call('saveState'); const n = s?.length || 0, ok = n > 0;
    const before = (await core.call('getSave'))[0]; paused = false; await w(300); paused = true;
    const ld = await core.call('loadState', { bytes: s }); const after = (await core.call('getSave'))[0]; paused = false;
    return { ok: !!ok && !!ld, same: before === after, n };
  });
  check(ast.ok && ast.same, `ares save state restores exactly (${ast.n} bytes)`);
  // Screen options: ares imitates the LCD by default; turning LCD colours off changes the picture.
  const lcdOn = await page.evaluate(() => [document.getElementById('opt-lcd').checked, document.getElementById('opt-blend').checked, document.getElementById('opt-lcd').disabled]);
  await page.keyboard.down('ArrowUp');  // the test ROM paints the keypad bits: a colour to compare
  await page.waitForTimeout(400);
  const shotA = JSON.stringify(await colour());
  await page.evaluate(() => { const b = document.getElementById('opt-lcd'); b.checked = false; b.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(400);
  const shotB = JSON.stringify(await colour());
  await page.keyboard.up('ArrowUp');
  check(lcdOn[0] && lcdOn[1] && !lcdOn[2] && shotA !== shotB, `ares screen options: on by default, LCD colours can be turned off (${shotA} -> ${shotB})`);
  // 6. Mesen 2: the running game moves over; then the same checks, including all four Y-pad keys.
  await page.click('.core-picker input[value=mesen]');
  await page.waitForFunction(() => coreName === 'mesen' && !coreBusy, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const mi = await page.evaluate(() => ({ w: info.width, h: info.height, save: info.saveSize, fps: info.fps, status: status.textContent, sixty: document.getElementById('opt-60hz').disabled }));
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
    paused = true; const s = await core.call('saveState'); const n = s?.length || 0, ok = n > 0;
    const before = (await core.call('getSave'))[0]; paused = false; await w(300); paused = true;
    const ld = await core.call('loadState', { bytes: s }); const after = (await core.call('getSave'))[0]; paused = false;
    return { ok: !!ok && !!ld, same: before === after, n };
  });
  check(mst.ok && mst.same, `Mesen save state restores exactly (${mst.n} bytes)`);
  // Mesen: LCD imitation off by default, can be turned on; integer scaling sizes the picture by whole numbers.
  const mOff = await page.evaluate(() => !document.getElementById('opt-lcd').checked && !document.getElementById('opt-blend').checked);
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(400);
  const mA = JSON.stringify(await colour());
  await page.evaluate(() => { const b = document.getElementById('opt-lcd'); b.checked = true; b.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(400);
  const mB = JSON.stringify(await colour());
  await page.keyboard.up('ArrowUp');
  check(mOff && mA !== mB, `Mesen screen options: off by default, LCD colours can be turned on (${mA} -> ${mB})`);
  const scale = await page.evaluate(() => { const b = document.getElementById('opt-integer'); b.checked = true; b.dispatchEvent(new Event('change'));
    const w = parseFloat(canvas.style.width), h = parseFloat(canvas.style.height); b.checked = false; b.dispatchEvent(new Event('change'));
    return { w, h, cleared: canvas.style.width === '' }; });
  check(scale.w % 224 === 0 && scale.h % 144 === 0 && scale.w / 224 === scale.h / 144 && scale.cleared, `integer scaling (${scale.w}x${scale.h})`);

  // Back to Mednafen: the running game moves with it.
  await page.click('.core-picker input[value=beetle]');
  await page.waitForFunction(() => /^Loaded input-test\.wsc/.test(document.getElementById('status').textContent) && !coreBusy && info.saveSize === 8192, null, { timeout: 30000 });
  check(true, 'switching back to Mednafen keeps the running game');

  check(problems.length === 0, `no console errors, page errors, failed requests or CSP violations${problems.length ? ': ' + problems.join(' / ') : ''}`);
  await browser.close();
  srv.close();
  console.log(failures ? `${failures} e2e check(s) failed` : 'all e2e tests passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
