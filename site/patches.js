/* Translation patches for the ROM being loaded.
 *
 * The ROM's CRC32 is looked up in mariovirgili/WonderSwan_bps_repo
 * (lookup/crc32/<CRC32>.json, refreshed daily by its crawler). If patches are
 * listed, the player picks one (newest first) or plays the original; the patch
 * is downloaded, checked against its SHA-256, applied in memory (BPS or IPS)
 * and the result is checked against the expected CRC32. Nothing is uploaded:
 * only the 8-digit CRC32 goes into the lookup URL.
 */
'use strict';
const SwanPatches = (() => {
  const REPO_BASE = 'https://raw.githubusercontent.com/mariovirgili/WonderSwan_bps_repo/main/';
  const CACHE_NAME = 'swanweb-patches-v1';

  // ---------------------------------------------------------------- CRC32
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(b, start = 0, end = b.length) {
    let c = 0xFFFFFFFF;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const hex = n => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

  class PatchError extends Error {}

  // ------------------------------------------------------------------ BPS
  function applyBps(src, p) {
    if (p.length < 19 || p[0] !== 0x42 || p[1] !== 0x50 || p[2] !== 0x53 || p[3] !== 0x31) throw new PatchError('Not a BPS patch');
    let i = 4;
    const num = () => {
      let v = 0, s = 1;
      for (;;) {
        if (i >= p.length) throw new PatchError('Truncated BPS patch');
        const x = p[i++];
        v += (x & 0x7F) * s;
        if (x & 0x80) return v;
        s *= 128;
        v += s;
      }
    };
    const srcSize = num(), dstSize = num(), metaSize = num();
    i += metaSize;
    const end = p.length - 12;
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const srcCrc = dv.getUint32(end, true), dstCrc = dv.getUint32(end + 4, true), patchCrc = dv.getUint32(end + 8, true);
    if (crc32(p, 0, p.length - 4) !== patchCrc) throw new PatchError('The patch file is corrupted');
    if (src.length !== srcSize || crc32(src) !== srcCrc) throw new PatchError(`This patch needs the ROM with CRC32 ${hex(srcCrc)}`);
    const out = new Uint8Array(dstSize);
    let o = 0, sr = 0, tr = 0;
    while (i < end) {
      const d = num(), cmd = d % 4, len = Math.floor(d / 4) + 1;
      if (o + len > dstSize) throw new PatchError('Invalid BPS patch (writes past the end)');
      if (cmd === 0) {            // SourceRead
        if (o + len > src.length) throw new PatchError('Invalid BPS patch (reads past the source)');
        out.set(src.subarray(o, o + len), o); o += len;
      } else if (cmd === 1) {     // TargetRead
        if (i + len > end) throw new PatchError('Truncated BPS patch');
        out.set(p.subarray(i, i + len), o); i += len; o += len;
      } else {
        const r = num(), off = (r % 2 ? -1 : 1) * Math.floor(r / 2);
        if (cmd === 2) {          // SourceCopy
          sr += off;
          if (sr < 0 || sr + len > src.length) throw new PatchError('Invalid BPS patch (source copy)');
          out.set(src.subarray(sr, sr + len), o); sr += len; o += len;
        } else {                  // TargetCopy (may overlap: byte by byte)
          tr += off;
          if (tr < 0 || tr >= o) throw new PatchError('Invalid BPS patch (target copy)');
          for (let k = 0; k < len; k++) out[o++] = out[tr++];
        }
      }
    }
    if (o !== dstSize) throw new PatchError('Invalid BPS patch (short output)');
    if (crc32(out) !== dstCrc) throw new PatchError('The patched ROM failed its CRC32 check');
    return out;
  }

  // ------------------------------------------------------------------ IPS
  function applyIps(src, p) {
    if (p.length < 8 || String.fromCharCode(...p.subarray(0, 5)) !== 'PATCH') throw new PatchError('Not an IPS patch');
    let i = 5, size = src.length;
    const recs = [];
    for (;;) {
      if (i + 3 > p.length) throw new PatchError('Truncated IPS patch');
      if (p[i] === 0x45 && p[i + 1] === 0x4F && p[i + 2] === 0x46) { i += 3; break; }   // "EOF"
      if (i + 5 > p.length) throw new PatchError('Truncated IPS patch');
      const off = (p[i] << 16) | (p[i + 1] << 8) | p[i + 2], n = (p[i + 3] << 8) | p[i + 4];
      i += 5;
      if (n === 0) {              // RLE record
        if (i + 3 > p.length) throw new PatchError('Truncated IPS patch');
        const rl = (p[i] << 8) | p[i + 1];
        recs.push([off, rl, p[i + 2], null]); i += 3; size = Math.max(size, off + rl);
      } else {
        if (i + n > p.length) throw new PatchError('Truncated IPS patch');
        recs.push([off, n, 0, p.subarray(i, i + n)]); i += n; size = Math.max(size, off + n);
      }
    }
    const out = new Uint8Array(size);
    out.set(src);
    for (const [off, n, v, d] of recs) d ? out.set(d, off) : out.fill(v, off, off + n);
    const trunc = i + 3 <= p.length ? (p[i] << 16) | (p[i + 1] << 8) | p[i + 2] : null;
    return trunc !== null && trunc < out.length ? out.slice(0, trunc) : out;
  }

  // --------------------------------------------------------- repository I/O
  async function lookup(crc) {
    const r = await fetch(`${REPO_BASE}lookup/crc32/${hex(crc)}.json`, { cache: 'no-cache' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`patch index: HTTP ${r.status}`);
    return r.json();
  }

  async function sha256hex(bytes) {
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(h), x => x.toString(16).padStart(2, '0')).join('');
  }

  async function download(entry) {
    let cache = null, cached = null;
    try { cache = await caches.open(CACHE_NAME); cached = await cache.match(entry.url); } catch { /* no Cache API */ }
    let bytes = cached ? new Uint8Array(await cached.arrayBuffer()) : null;
    if (!bytes || await sha256hex(bytes) !== entry.sha256) {
      const r = await fetch(entry.url);
      if (!r.ok) throw new Error(`patch download: HTTP ${r.status}`);
      bytes = new Uint8Array(await r.arrayBuffer());
      if (await sha256hex(bytes) !== entry.sha256) throw new PatchError('The downloaded patch does not match the catalog (SHA-256)');
      try { await cache?.put(entry.url, new Response(bytes)); } catch { /* quota / private mode */ }
    }
    return bytes;
  }

  function apply(rom, patchBytes, entry) {
    const out = entry.format === 'bps' ? applyBps(rom, patchBytes) : applyIps(rom, patchBytes);
    if (entry.target_crc32 && hex(crc32(out)) !== entry.target_crc32) {
      throw new PatchError(`The patched ROM has CRC32 ${hex(crc32(out))}, expected ${entry.target_crc32}`);
    }
    return out;
  }

  // ------------------------------------------------------------------- UI
  const LANGS = { en: 'English', ja: 'Japanese', it: 'Italian', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', ru: 'Russian', zh: 'Chinese', ko: 'Korean' };
  const vkey = v => (v || '').toLowerCase().match(/\d+|[a-z]+/g)?.map(x => (/\d/.test(x) ? +x : x)) || [];
  function cmpVersion(a, b) {
    const x = vkey(a), y = vkey(b);
    for (let k = 0; k < Math.max(x.length, y.length); k++) {
      if (x[k] === undefined) return -1;
      if (y[k] === undefined) return 1;
      if (x[k] !== y[k]) return typeof x[k] === typeof y[k] ? (x[k] < y[k] ? -1 : 1) : (typeof x[k] === 'number' ? 1 : -1);
    }
    return 0;
  }
  /** Newest first: latest of each source, then not superseded, then by version. */
  function sortPatches(list) {
    return [...list].sort((a, b) => (!!b.latest - !!a.latest) || (!!a.superseded - !!b.superseded)
      || cmpVersion(b.version, a.version) || (a.game || '').localeCompare(b.game || '') || (a.variant || '').localeCompare(b.variant || ''));
  }

  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };

  /** Show the choice. Resolves to the chosen entry, or null for "play original". */
  function choose(info, fileName) {
    const dlg = document.getElementById('patch-dialog'), list = document.getElementById('patch-list');
    const patches = sortPatches(info.patches);
    list.replaceChildren();
    const romName = info.names?.[0] || fileName;
    document.getElementById('patch-rom').textContent = `${romName} · CRC32 ${info.crc32}`;
    patches.forEach((p, k) => {
      const chips = [
        p.version && `v${p.version}`, LANGS[p.language] || p.language, p.format?.toUpperCase(),
      ].filter(Boolean).map(t => el('span', { className: 'chip', textContent: t }));
      if (p.latest) chips.unshift(el('span', { className: 'chip new', textContent: 'Latest' }));
      if (p.superseded) chips.push(el('span', { className: 'chip old', textContent: 'Superseded' }));
      const page = p.page ? el('a', { href: p.page, target: '_blank', rel: 'noopener', textContent: p.source }) : document.createTextNode(p.source);
      const radio = el('input', { type: 'radio', name: 'patch', value: String(k), checked: k === 0 });
      list.append(el('label', { className: 'patch-item' }, radio,
        el('span', { className: 'patch-text' },
          el('strong', { textContent: p.game || p.variant }),
          el('span', { className: 'patch-variant', textContent: p.variant }),
          el('span', { className: 'patch-meta' }, ...chips, el('span', { className: 'patch-src' }, 'by ', page)))));
    });
    document.getElementById('patch-count').textContent =
      `${patches.length} patch${patches.length === 1 ? '' : 'es'} found for this ROM. Pick one to apply on the fly, or play the original.`;
    return new Promise(resolve => {
      dlg.addEventListener('close', () => {
        const picked = list.querySelector('input[name=patch]:checked');
        resolve(dlg.returnValue === 'apply' && picked ? patches[+picked.value] : null);
      }, { once: true });
      dlg.returnValue = '';
      dlg.showModal();
      document.getElementById('patch-apply').focus();
    });
  }

  /**
   * Offer the patches known for `rom`. Resolves to {bytes, name, patch} for a
   * patched ROM, or {bytes: rom, name, patch: null} for the original.
   * `status(text)` reports progress.
   */
  async function offer(rom, fileName, status) {
    const crc = crc32(rom);
    let info = null;
    try {
      status(`ROM CRC32 ${hex(crc)} · checking for translation patches…`);
      info = await lookup(crc);
    } catch (e) {
      console.warn('Patch lookup failed:', e);
      status('Patch catalog unreachable · loading the original ROM');
      return { bytes: rom, name: fileName, patch: null, crc };
    }
    const recognised = info?.produced_by?.[0];
    if (!info?.patches?.length) {
      return { bytes: rom, name: fileName, patch: null, crc, recognised };
    }
    const entry = await choose(info, fileName);
    if (!entry) return { bytes: rom, name: fileName, patch: null, crc, recognised };
    status(`Downloading ${entry.variant}…`);
    const patchBytes = await download(entry);
    status(`Applying ${entry.variant}…`);
    const bytes = apply(rom, patchBytes, entry);
    const stem = fileName.replace(/\.[^.]+$/, ''), ext = (fileName.match(/\.[^.]+$/) || ['.wsc'])[0];
    return { bytes, name: `${stem} [${entry.variant}]${ext}`, patch: entry, crc, recognised };
  }

  return { crc32, hex, applyBps, applyIps, apply, lookup, download, sortPatches, cmpVersion, offer, PatchError, REPO_BASE };
})();
if (typeof module !== 'undefined') module.exports = SwanPatches;
