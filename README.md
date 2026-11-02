# WonderSwan AI/MTL Tester — standalone Mednafen / Beetle WASM

A browser emulator for testing WonderSwan AI / machine translations: when a ROM is loaded, its CRC32 is looked up in
[WonderSwan_bps_repo](https://github.com/mariovirgili/WonderSwan_bps_repo) and every matching `.bps` / `.ips`
translation patch is offered (newest first) and applied on the fly, in memory.

ROMs can be loaded directly or inside `.zip` / `.7z` archives. A **no-RetroArch** browser frontend using the actual Beetle WonderSwan (Mednafen) Libretro core, linked as a single Emscripten WebAssembly module. Supports `.ws`, `.wsc`, `.pc2` ROMs, RGB565/0RGB1555/XRGB8888 video, stereo audio, keyboard/touch/gamepad input, SRAM backup/restore, save states, and IndexedDB SRAM autosaving.

**Status:** builds in CI and runs commercial WonderSwan / WonderSwan Color ROMs (tested with several titles, with and without translation patches). The WASM binaries are not checked in: CI builds them and publishes the site to the `wasm-build` branch.

## Private development setup

This project is intentionally hosted in a **private** repository while the WebAssembly build and ROM behavior are tested. It does **not** enable GitHub Pages or publish content to the web.

The GitHub Actions workflow `.github/workflows/build.yml` checks out this repository, installs Emscripten, builds the Beetle WonderSwan core into `site/core.wasm`/`site/core.js`, verifies the outputs, and stores the result as a **private workflow artifact** for 7 days. You can inspect it under **Actions → Build private WonderSwan WASM prototype → Artifacts**. No ROMs or BIOS are bundled.

When testing is complete, a separate Pages deployment workflow may be added after making an explicit deployment decision and reviewing GitHub Pages visibility rules for your account. Do not assume that repository privacy guarantees a private Pages website.

## Build locally

Install the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) and activate its environment (`source emsdk_env.sh`). Then:

```sh
bash scripts/build.sh
python3 -m http.server 8000 --directory site
```

Open `http://localhost:8000`. Do not use `file://` for WebAssembly.

The build uses the upstream `platform=emscripten` Makefile target to produce a static library and links `src/bridge.c` directly into one Emscripten program. The browser app communicates with `ws_*` C functions through `cwrap`. A Libretro **API** is used internally, but **RetroArch is not required**.

### Controls

| Hardware | Keyboard | Libretro mapping |
|--|--|--|
| X cursor | Arrows | Up/Down/Left/Right |
| Y cursor | W/A/S/D | R2/L/L2/R |
| A/B | X/Z | A/B |
| Start | Enter | Start |
| Rotate pad/screen | Shift | Select |

The hardware has two directional clusters. Some games require the Y cursor; mobile touch controls provide both. The frontend also handles typical gamepads.

## ROM archives

`.zip` and `.7z` files are opened in the browser, in memory. ZIP (stored/deflate) uses the browser's own
`DecompressionStream`; `.7z`, and ZIP files using other methods, go through 7-Zip compiled to WebAssembly
([7z-wasm](https://github.com/use-strict/7z-wasm) 1.2.0, GNU LGPL + unRAR restriction), which `scripts/build.sh` copies
into `site/vendor/7z/` and the page loads only when needed. If an archive holds several ROMs, a dialog asks which one
to load. The ROM inside is then looked up for translation patches as usual.

## Translation patches

On every ROM load the emulator computes the ROM's CRC32 and fetches `lookup/crc32/<CRC32>.json` from
WonderSwan_bps_repo (only those 8 hex digits leave the browser; the ROM never does). If patches are listed, a dialog
lists them grouped by author — mariovirgili first, then the other authors alphabetically, each author set off by a thin bar — and, inside each author, from the highest version down with version, language, format
and author. The chosen patch is downloaded, checked against the SHA-256 in the catalog, applied in memory (BPS or IPS;
BPS also verifies the source and result CRC32s, IPS results are checked when the catalog knows the expected CRC32) and
the patched ROM is started. Patches are cached with the Cache API. **Play original** (or Esc) skips patching; the
**Offer translation patches** option turns the lookup off. Battery saves are keyed by the SHA-256 of the ROM actually
running, so each patch keeps its own saves.

## Save format and behavior

The emulator stores cartridge SRAM in the user's browser's **IndexedDB**, keyed by the SHA-256 digest of the ROM contents. The `Export SRAM`, `Import SRAM`, `Save state`, and `Load state` controls allow manual backup. Save states are core-specific, may not work across core versions, and should not replace SRAM backups. Browser storage can be deleted by site data clearing or privacy mode. The project has no remote save backend.

## Accuracy and limitations

- Uses Beetle/Mednafen's actual emulation routines; does not attempt to emulate hardware in JavaScript.
- Display uses nearest-neighbor pixel scaling and keeps RGB565 pixel values.
- It has no ROM database, cheats, link-cable emulation, or cloud saves.
- Audio plays through an AudioWorklet ring buffer (about 60 ms of latency, playback rate gently matched to the emulator); browsers without AudioWorklet fall back to scheduled buffers. Sound starts on a user gesture and the same button turns it off again.
- Manual rotation uses the core's Select-button behavior. Test portrait titles separately.
- First build should be smoke-tested with a legal homebrew ROM; a native build does not guarantee successful WASM runtime.

## Source, license and attribution

This project (the bridge in `src/`, the web frontend in `site/`, the build scripts and tests) is free software under the
**GNU GPL v2** ([`LICENSE`](LICENSE)). The emulator engine is
[libretro/beetle-wswan-libretro](https://github.com/libretro/beetle-wswan-libretro), a fork of Mednafen WonderSwan,
also **GPL-2.0**; `core.wasm` links the two into one program. `.7z` support uses
[7z-wasm](https://github.com/use-strict/7z-wasm), 7-Zip compiled to WebAssembly, under the **GNU LGPL v2.1 + unRAR
restriction**, shipped unmodified as a separate file.

Every build carries the complete corresponding source of what it ships, in `site/source/`
(`scripts/package_sources.sh`):

| File | Contents |
| --- | --- |
| `wonderswan-ai-mtl-tester-source.tar.gz` | this repository at the exact commit built (plus any uncommitted changes to tracked files, for local builds) |
| `beetle-wswan-source.tar.gz` | Beetle at the pinned commit, exactly as compiled |
| `7z-wasm-1.2.0-source.tar.gz` | 7z-wasm's build files at tag v1.2.0 and the 7-Zip source release they build (`7z2409-src.7z`); the build checks that the shipped `7zz.wasm` is the one from that tag |
| `SOURCES.txt` | commits, toolchain version, SHA-256 of every archive and binary, rebuild notes |

The page footer links all of them, together with `COPYING` (GPL v2) and the 7-Zip license files in `vendor/7z/`
(`License.txt`, `copying-LGPL.txt`, `unRarLicense.txt`). Anyone redistributing the built site must keep these files
with it. Third-party trademarks are used for identification only; no BIOS or ROMs are distributed.

## Troubleshooting

- `Core unavailable: core.js is missing`: run GitHub Actions or build with Emscripten; GitHub Pages won't compile the C code itself.
- `Module failed to compile`: check the GitHub Actions log and `core.wasm` publishing; don't rename generated artifacts.
- Blank game screen: verify file extension and ROM header, view browser console, check console model and rotation.
- No sound: press **Enable sound** (press it again — **Disable sound** — to mute).
- This project has not yet passed browser-based compatibility testing with actual games; issues can be reported after the first compiled build.
