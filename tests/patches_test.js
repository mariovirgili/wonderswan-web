// Unit tests for site/patches.js (BPS/IPS appliers, CRC32, ordering). Run: node tests/patches_test.js
'use strict';
const assert = require('assert');
const P = require('../site/patches.js');

const rnd = (n, seed) => { const a = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = x >>> 24; } return a; };
const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
function num(n) { const o = []; for (;;) { const x = n % 128; n = Math.floor(n / 128); if (n === 0) { o.push(0x80 | x); return o; } o.push(x); n -= 1; } }
const signed = v => num((Math.abs(v) * 2) + (v < 0 ? 1 : 0));

// Hand-built BPS using all four actions: SourceRead, TargetRead, SourceCopy (backwards), TargetCopy (overlapping RLE).
const src = rnd(4096, 7);
const ops = []; const dst = [];
const action = (cmd, len) => ops.push(...num(((len - 1) * 4) + cmd));
action(0, 100); dst.push(...src.subarray(0, 100));                                   // SourceRead 0..99
const lit = [1, 2, 3, 4, 5]; action(1, 5); ops.push(...lit); dst.push(...lit);       // TargetRead
action(2, 50); ops.push(...signed(3000)); dst.push(...src.subarray(3000, 3050));     // SourceCopy +3000
action(2, 20); ops.push(...signed(-3050 + 10)); dst.push(...src.subarray(10, 30));    // SourceCopy backwards to 10
action(1, 1); ops.push(0xAA); dst.push(0xAA);
action(3, 40); ops.push(...signed(dst.length - 1)); for (let k = 0; k < 40; k++) dst.push(0xAA); // TargetCopy RLE
const out = Uint8Array.from(dst);
const body = [0x42, 0x50, 0x53, 0x31, ...num(src.length), ...num(out.length), ...num(3), 0x6d, 0x65, 0x74, ...ops,
  ...u32(P.crc32(src)), ...u32(P.crc32(out))];
const bps = Uint8Array.from([...body, ...u32(P.crc32(Uint8Array.from(body)))]);
assert.deepStrictEqual(P.applyBps(src, bps), out, 'BPS: all four actions');
console.log('ok - BPS SourceRead/TargetRead/SourceCopy/TargetCopy');

const wrong = src.slice(); wrong[5] ^= 1;
assert.throws(() => P.applyBps(wrong, bps), /needs the ROM with CRC32/);
const bad = bps.slice(); bad[10] ^= 1;
assert.throws(() => P.applyBps(src, bad), /corrupted/);
console.log('ok - BPS rejects the wrong ROM and a corrupted patch');

assert.strictEqual(P.hex(P.crc32(new TextEncoder().encode('123456789'))), 'CBF43926');
console.log('ok - CRC32 check value');

// IPS: normal record, RLE record, growth past the end, truncation.
const isrc = rnd(256, 3);
const ips = Uint8Array.from([...'PATCH'].map(c => c.charCodeAt(0)).concat(
  [0, 0, 0x10, 0, 3, 9, 8, 7],          // 0x10: 9 8 7
  [0, 0, 0x20, 0, 0, 0, 4, 0x55],       // RLE 0x20..0x23 = 0x55
  [0, 1, 0x02, 0, 2, 1, 1],             // 0x102: grows the ROM to 0x104
  [0x45, 0x4F, 0x46]));
const io = P.applyIps(isrc, ips);
assert.strictEqual(io.length, 0x104);
assert.deepStrictEqual([...io.subarray(0x10, 0x13)], [9, 8, 7]);
assert.deepStrictEqual([...io.subarray(0x20, 0x24)], [0x55, 0x55, 0x55, 0x55]);
assert.strictEqual(io[0x24], isrc[0x24]);
const ipsT = Uint8Array.from([...ips, 0, 0, 0x80]);
assert.strictEqual(P.applyIps(isrc, ipsT).length, 0x80);
assert.throws(() => P.apply(isrc, ips, { format: 'ips', target_crc32: '00000000' }), /expected 00000000/);
console.log('ok - IPS records, RLE, growth, truncation, expected-CRC check');

const sorted = P.sortPatches([
  { variant: 'g-old', source: 'Gand46/BWB', version: '4.9.0' },
  { variant: 'pk', source: 'PokemonGoDB/patches', version: '1.1', latest: true },
  { variant: 'g-new', source: 'Gand46/BWB', version: '5.0.0-test.1', latest: true },
  { variant: 'm-old', source: 'mariovirgili/WonderSwanColor-AI_Translation', version: '0.9', superseded: true },
  { variant: 'g-nover', source: 'Gand46/BWB', version: null },
  { variant: 'm-new', source: 'mariovirgili/WonderSwanColor-AI_Translation', version: '0.9.10', latest: true },
  { variant: 'm-mid', source: 'mariovirgili/WonderSwanColor-AI_Translation', version: '0.9.9' },
  { variant: 'g-other-repo', source: 'Gand46/Another', version: '4.9.5' },
]).map(p => p.variant);
assert.deepStrictEqual(sorted, ['m-new', 'm-mid', 'm-old', 'g-new', 'g-other-repo', 'g-old', 'g-nover', 'pk']);
console.log('ok - mariovirgili first, then other authors; highest version first inside each author, across repos');
assert.deepStrictEqual(P.sortPatches([
  { variant: 'Ring Infinity (Japan) [WonderGate unlock]', source: 'mariovirgili/x', version: '0.9', latest: true },
  { variant: 'Ring Infinity [T-En v0.9]', source: 'mariovirgili/x', version: '0.9', latest: true },
  { variant: 'ring-infinity-en-special-1.1', source: 'PokemonGoDB/x', version: '1.1', latest: true },
  { variant: 'ring-infinity-en-1.1', source: 'PokemonGoDB/x', version: '1.1', latest: true },
]).map(p => p.variant), ['Ring Infinity [T-En v0.9]', 'Ring Infinity (Japan) [WonderGate unlock]', 'ring-infinity-en-1.1', 'ring-infinity-en-special-1.1']);
console.log('ok - at equal version the main translation precedes extra editions');
console.log('all patch tests passed');
