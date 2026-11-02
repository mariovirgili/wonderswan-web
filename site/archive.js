// SPDX-License-Identifier: GPL-2.0-only
/* ROMs inside .zip and .7z archives.
 *
 * ZIP is read here: central directory + stored/deflate entries, inflated with
 * the browser's DecompressionStream. Anything else (7z, or ZIP methods such as
 * Deflate64/LZMA) goes to 7-Zip compiled to WebAssembly (7z-wasm, LGPL),
 * which the build copies to vendor/7z/ and which is loaded only when needed.
 * Everything happens in memory, in the browser.
 */
'use strict';
const SwanArchive = (() => {
  const ROM_RE = /\.(ws|wsc|pc2)$/i;
  const VENDOR = './vendor/7z/';
  const MAX_ROM = 64 * 1024 * 1024;

  class ArchiveError extends Error {}
  class Unsupported extends Error {}

  // ------------------------------------------------------------------ ZIP
  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') throw new Unsupported('no DecompressionStream');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readZip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ArchiveError('Not a valid ZIP file');
    const count = dv.getUint16(eocd + 10, true), cdOffset = dv.getUint32(eocd + 16, true);
    if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) throw new Unsupported('ZIP64');
    const out = [];
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014B50) throw new ArchiveError('Damaged ZIP directory');
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'ibm866').decode(bytes.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/') || !ROM_RE.test(name)) continue;
      if (flags & 1) throw new ArchiveError(`${name} is encrypted`);
      if (usize > MAX_ROM) throw new ArchiveError(`${name} is too large`);
      if (dv.getUint32(local, true) !== 0x04034B50) throw new ArchiveError('Damaged ZIP entry');
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = bytes.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Unsupported(`ZIP method ${method}`);
      if (data.length !== usize) throw new ArchiveError(`${name}: size mismatch`);
      out.push({ name, bytes: data });
    }
    return out;
  }

  // ------------------------------------------------------------------- 7z
  let sevenZipFactory = null, wasmBinary = null;
  async function loadSevenZip() {
    if (!sevenZipFactory) {
      if (typeof SevenZip === 'undefined') {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = VENDOR + '7zz.umd.js';
          s.onload = resolve;
          s.onerror = () => reject(new ArchiveError('7-Zip support files are missing (vendor/7z)'));
          document.head.append(s);
        });
      }
      sevenZipFactory = SevenZip; // eslint-disable-line no-undef
    }
    if (!wasmBinary && typeof fetch === 'function' && typeof document !== 'undefined') {
      const r = await fetch(VENDOR + '7zz.wasm');
      if (!r.ok) throw new ArchiveError('7-Zip support files are missing (vendor/7z)');
      wasmBinary = await r.arrayBuffer();
    }
    // A fresh instance per archive: 7-Zip's main() is not meant to be re-entered.
    return sevenZipFactory({ ...(wasmBinary ? { wasmBinary } : {}), print: () => {}, printErr: () => {} });
  }

  async function readWith7z(name, bytes) {
    const sz = await loadSevenZip();
    const input = '/in' + (name.match(/\.[^.]+$/)?.[0] || '.7z');
    sz.FS.writeFile(input, bytes);
    sz.FS.mkdir('/out');
    try { sz.callMain(['x', input, '-o/out', '-y', '-bso0', '-bsp0', '-bse0']); }
    catch (e) { if (!(e && typeof e === 'object' && (e.name === 'ExitStatus' || 'status' in e))) throw e; }
    const out = [];
    const walk = dir => {
      for (const f of sz.FS.readdir(dir)) {
        if (f === '.' || f === '..') continue;
        const path = `${dir}/${f}`, st = sz.FS.stat(path);
        if (sz.FS.isDir(st.mode)) walk(path);
        else if (ROM_RE.test(f) && st.size <= MAX_ROM) out.push({ name: path.slice(5), bytes: sz.FS.readFile(path) });
      }
    };
    walk('/out');
    if (!out.length && !sz.FS.readdir('/out').some(f => f !== '.' && f !== '..')) {
      // Nothing extracted at all: probably not an archive 7-Zip can open, or a password.
      throw new ArchiveError('7-Zip could not open this archive');
    }
    return out;
  }

  // ------------------------------------------------------------------ API
  const isArchive = name => /\.(zip|7z)$/i.test(name);

  /** All WonderSwan ROMs ({name, bytes}) inside the archive, sorted by name. */
  async function extractRoms(name, bytes) {
    let roms;
    if (/\.zip$/i.test(name)) {
      try { roms = await readZip(bytes); }
      catch (e) { if (e instanceof Unsupported) roms = await readWith7z(name, bytes); else throw e; }
    } else {
      roms = await readWith7z(name, bytes);
    }
    return roms.sort((a, b) => a.name.localeCompare(b.name));
  }

  return { isArchive, extractRoms, readZip, readWith7z, ArchiveError, ROM_RE };
})();
if (typeof module !== 'undefined') module.exports = SwanArchive;
