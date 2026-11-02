// Tests for site/archive.js. ZIP runs anywhere (Node 18+); 7z needs the 7z-wasm package:
// set SEVENZIP_DIR to its folder (scripts/build.sh unpacks it to .build/7z-wasm/package).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../site/archive.js');
const F = path.join(__dirname, 'fixtures');
const rd = n => new Uint8Array(fs.readFileSync(path.join(F, n)));
const rom = Uint8Array.from({ length: 64 * 1024 }, (_, i) => (i * 7 + 3) % 256);
const rom2 = Uint8Array.from({ length: 8 * 1024 }, (_, i) => (i * 13 + 1) % 256);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

(async () => {
  let r = await A.extractRoms('deflate.zip', rd('deflate.zip'));
  assert.deepStrictEqual(r.map(x => x.name), ['Game (Japan).wsc']);
  assert.ok(same(r[0].bytes, rom));
  console.log('ok - ZIP deflate, non-ROM files ignored');
  r = await A.extractRoms('stored.zip', rd('stored.zip'));
  assert.deepStrictEqual(r.map(x => x.name), ['dir/Game.WS']);
  assert.ok(same(r[0].bytes, rom2));
  console.log('ok - ZIP stored, upper-case extension, sub-folder');
  r = await A.extractRoms('two.zip', rd('two.zip'));
  assert.deepStrictEqual(r.map(x => x.name), ['a.wsc', 'b.ws']);
  console.log('ok - several ROMs, sorted');
  await assert.rejects(A.extractRoms('x.zip', new Uint8Array(100)), /Not a valid ZIP/);
  console.log('ok - not a ZIP');

  const dir = process.env.SEVENZIP_DIR;
  if (!dir) { console.log('skip - 7z tests (SEVENZIP_DIR not set)'); return; }
  global.SevenZip = require(path.resolve(dir, '7zz.umd.js'));
  r = await A.extractRoms('game.7z', rd('game.7z'));
  assert.deepStrictEqual(r.map(x => x.name), ['sub/Game (Japan).WSC']);
  assert.ok(same(r[0].bytes, rom));
  console.log('ok - 7z (LZMA2) through 7-Zip WASM');
  r = await A.extractRoms('bzip2.zip', rd('bzip2.zip'));
  assert.ok(r.length === 1 && same(r[0].bytes, rom));
  console.log('ok - ZIP with an unsupported method falls back to 7-Zip');
  await assert.rejects(A.extractRoms('junk.7z', rd('junk.7z')), /could not open/);
  console.log('ok - not a 7z');
  console.log('all archive tests passed');
  process.exitCode = 0; // 7-Zip's runtime sets the exit code of its last command
})().catch(e => { console.error(e); process.exit(1); });
