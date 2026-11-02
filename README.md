# WonderSwan Web — standalone Mednafen / Beetle WASM

A **no-RetroArch** browser frontend using the actual Beetle WonderSwan (Mednafen) Libretro core, linked as a single Emscripten WebAssembly module. Supports `.ws`, `.wsc`, `.pc2` ROMs, RGB565/0RGB1555/XRGB8888 video, stereo audio, keyboard/touch/gamepad input, SRAM backup/restore, save states, and IndexedDB SRAM autosaving.

**Status:** Source project and CI workflow are implemented. The WASM binaries are **not** checked in. Building with Emscripten and running an actual ROM remain to be verified. This repository is a buildable candidate, **not** a claim of tested game compatibility.

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

## Save format and behavior

The emulator stores cartridge SRAM in the user's browser's **IndexedDB**, keyed by the SHA-256 digest of the ROM contents. The `Export SRAM`, `Import SRAM`, `Save state`, and `Load state` controls allow manual backup. Save states are core-specific, may not work across core versions, and should not replace SRAM backups. Browser storage can be deleted by site data clearing or privacy mode. The project has no remote save backend.

## Accuracy and limitations

- Uses Beetle/Mednafen's actual emulation routines; does not attempt to emulate hardware in JavaScript.
- Display uses nearest-neighbor pixel scaling and keeps RGB565 pixel values.
- It has no ROM database, cheats, link-cable emulation, or cloud saves.
- Audio playback is Web Audio and needs a user gesture to start.
- Manual rotation uses the core's Select-button behavior. Test portrait titles separately.
- First build should be smoke-tested with a legal homebrew ROM; a native build does not guarantee successful WASM runtime.
- WebAssembly `.wasm` and `.js` aren't included in this source-only ZIP because Emscripten was not installed in the author's execution environment; CI generates them.

## Source, license and attribution

The emulator engine is [libretro/beetle-wswan-libretro](https://github.com/libretro/beetle-wswan-libretro), a fork of Mednafen WonderSwan, under **GPL-2.0** (see upstream `COPYING`). The project bridge/front end are distributed under GPL-2.0 as a combined program. The build **distributes a copy of upstream corresponding source code and its COPYING file** in the published site. Keep those files and the build scripts available when distributing compiled binaries. Third-party trademarks are used for identification only; no BIOS or ROMs are distributed.

## Troubleshooting

- `Core unavailable: core.js is missing`: run GitHub Actions or build with Emscripten; GitHub Pages won't compile the C code itself.
- `Module failed to compile`: check the GitHub Actions log and `core.wasm` publishing; don't rename generated artifacts.
- Blank game screen: verify file extension and ROM header, view browser console, check console model and rotation.
- No sound: press **Enable sound**.
- This project has not yet passed browser-based compatibility testing with actual games; issues can be reported after the first compiled build.
