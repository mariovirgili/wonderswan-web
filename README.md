# WonderSwan AI/MTL Tester

A WonderSwan / WonderSwan Color emulator that runs in the browser, made for **playing and testing AI and machine
translations** of Japanese games. Load a ROM and the emulator looks it up in a catalog of translation patches; if
there are any, it lists them and applies the one you pick **on the fly, in memory** — no patching tools, no patched
files on disk.

**Try it:** <https://mariovirgili.github.io/wonderswan-web/>

The emulation is the real thing, with three cores to choose from at the top of the page:
[Mesen 2](https://github.com/libretro/MesenCE) (the default), [Beetle WonderSwan](https://github.com/libretro/beetle-wswan-libretro)
(Mednafen) and [ares](https://github.com/ares-emulator/ares), all compiled to
WebAssembly and driven by a small purpose-built frontend — no RetroArch. No ROMs or BIOS are included or uploaded anywhere: you load your own dumps, and they never
leave your browser.

## Features

- **Translation patches on load.** The ROM's CRC32 is checked against
  [WonderSwan_bps_repo](https://github.com/mariovirgili/WonderSwan_bps_repo), a daily-updated mirror of the
  `.bps` / `.ips` patches published by mariovirgili, PokemonGoDB and Gand46. Matching patches are listed by author
  (mariovirgili first, then the others; each author separated by a thin bar) and by version, newest first, with
  language, format and a link to the release. The chosen patch is downloaded, verified and applied before the game
  starts. **Play original** (or Esc) skips it. Each patch's **release notes** can be opened in the window.
- **Newer translation notice.** If the ROM you load is already a patched one and the same author has since published a
  newer version of that translation, a notice under the screen says so and links the release: load the original ROM to
  apply the new one.
- **Three emulator cores.** Mesen (the default, and the fastest), Beetle/Mednafen or ares, picked at the top of the
  page. Switching keeps the running game and its battery save, so a translation can be checked on each; a choice made
  in the picker is remembered (`?core=mesen`, `?core=beetle` or `?core=ares` in the address also selects one).
- **Your own patch files.** **Apply patch file** takes a `.bps` / `.ips` from your computer and applies it to the ROM
  as it was loaded, so a work-in-progress translation can be tried at once (BPS checks it is made for that ROM).
- **Fast forward and quick saves.** Hold Space (or ⏩) to run up to 4× faster through dialogue; F5 / F7 quick-save and
  load, in three slots (1–3) kept in the browser per ROM and per emulator.
- **Screen options.** With Mesen and ares, LCD colours and frame blending (an imitation of the real LCD, on by default
  in ares, off in Mesen) can be switched; integer scaling keeps every pixel the same size.
- **ROMs in archives.** `.ws`, `.wsc`, `.pc2`, or the same inside `.zip` / `.7z` files. If an archive holds several
  ROMs, you pick one.
- **Smooth on 60 Hz screens.** Optional 60 Hz mode (on by default, Mednafen only) instead of the console's native
  75.47 Hz.
- **Battery saves** kept automatically in the browser, per ROM *and* per patch; **export / import** of SRAM and
  **save states**.
- **Controls** for keyboard, gamepad and touch, including the WonderSwan's second (Y) direction pad and screen rotation.
  **Change keys** remaps every button to another key or gamepad button; the choice is kept in the browser.
- **Emulation in a Web Worker**, so the page stays responsive while the core works and the core is not slowed down by
  the page.
- **Low-latency audio** (AudioWorklet), with an on/off toggle and volume.

## Using it

1. Open the page and press **Load ROM**. Choose a `.ws` / `.wsc` / `.pc2` file, or a `.zip` / `.7z` that contains one.
2. If translation patches exist for that exact ROM, a window lists them. Pick one and press **Apply patch and play**,
   or **Play original**. Already-patched ROMs are recognised and named in the status line.
3. Press **Enable sound** to hear the game (browsers only allow audio after a click); press it again to mute.

| WonderSwan | Keyboard | Gamepad |
| --- | --- | --- |
| X pad | Arrow keys | D-pad / left stick |
| Y pad | W / A / S / D | shoulder buttons and triggers |
| A / B | X / Z | A / B (bottom / right face buttons) |
| Start | Enter | Start |
| Rotate screen | Shift | Select |
| Fast forward (hold) | Space | stick press (L3 / R3) |
| Quick save / quick load | F5 / F7 | |
| Quick-save slot | 1 / 2 / 3 | |

These are the defaults. **Change keys** (next to the list of controls) lets you press a new key or gamepad button for
each WonderSwan button; **Defaults** puts them back. F5, F7, 1–3, Esc and Tab stay reserved.

Some games use the Y pad; the touch controls under the screen have both pads. With ares and Mesen, vertical games turn
the screen by themselves; Rotate switches between that and the other orientation. In **Options** you can turn off the
patch lookup or the 60 Hz mode; both choices are remembered.

### Privacy

Nothing you load is uploaded. The only thing the page sends out is the ROM's 8-digit CRC32, in the URL of the
patch-catalog lookup (`raw.githubusercontent.com`), and the download of the patch you choose. Saves live in your
browser's storage (IndexedDB); clearing site data deletes them, so export the ones you care about.

## How the patch lookup works

`WonderSwan_bps_repo` publishes one small file per known ROM checksum: `lookup/crc32/<CRC32>.json` (404 means nothing
is known). It lists the patches that take that ROM as input and the ones that produce it. For the chosen patch the
emulator:

1. downloads it (cached afterwards with the Cache API) and checks it against the SHA-256 in the catalog;
2. applies it in memory — BPS (all actions; source, target and patch checksums verified) or IPS (records, RLE,
   truncation; the result is checked when the catalog knows its CRC32);
3. starts the result. Saves are keyed by the SHA-256 of the ROM that is actually running.

## Building

Requirements: the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) (CI uses 4.0.19),
`git`, `make`, `python3`, `node`/`npm`, `curl`.

```sh
source /path/to/emsdk/emsdk_env.sh
bash scripts/build.sh
python3 -m http.server 8000 --directory site
```

Then open <http://localhost:8000> (WebAssembly does not load from `file://`).

`scripts/build.sh` fetches Beetle at a pinned commit, builds it with its own `platform=emscripten` target, links it
with `src/bridge.c` into `site/core.wasm` / `core.js`, builds ares (`scripts/build_ares.sh`, below) into
`site/core-ares.wasm` / `core-ares.js`, builds Mesen 2 (`scripts/build_mesen.sh`, below) into `site/core-mesen.wasm` /
`core-mesen.js`, adds 7-Zip for WebAssembly (7z-wasm 1.2.0, pinned) under `site/vendor/7z/`,
and writes the corresponding source of everything into `site/source/`. Building ares also needs a native C++20
compiler (`clang++` or `g++`) for ares' `sourcery` resource tool.

### The ares core

ares has no WebAssembly port, so `scripts/build_ares.sh` makes one from a pinned upstream commit without changing the
emulation code:

- **Cothreads.** ares runs the CPU, video and sound chips as cooperative threads (libco), and WebAssembly cannot switch
  stacks. `src/libco_emscripten.c` is a libco backend on Emscripten fibers, linked with Asyncify. Every switch unwinds
  and rewinds a stack, so ares costs more CPU than Mednafen; `tests/core_test.js` prints the time per frame. The
  pictures match a native ares build pixel for pixel.
- **Platform.** `scripts/patch_ares.py` lets ares' `nall` library recognise WebAssembly, leaves out `sljit` (the JIT of
  other ares cores) and draws frames without ares' separate video thread; `src/ares_stubs.cpp` replaces the GDB
  server's sockets, the x86 CPU-feature probe and thread naming.
- **Speed.** Asyncify instrumentation is left off the code that can never be on the stack at a switch, and the serial
  port (there is no link cable) wakes every 5120 cycles instead of every 80 while a game keeps it disabled. One frame
  takes about 6–8 ms in Chrome or Node on a desktop CPU, against the 13.25 ms the console allows.
- **Host.** `src/ares_host.cpp` implements ares' `Platform` interface behind the same `ws_*` API as `src/bridge.c`. It
  builds the cartridge description from the ROM footer, as ares' own loader does, and — since no boot ROM is shipped —
  sets what the boot ROM leaves behind (LCD on, cartridge bus width and speed, sound output, orientation). It shows
  the 224×144 picture without the LCD icon strip, mixes sound at 48 kHz, and saves states after running every chip to
  a safe point (`ws_prepare_state`).

### The Mesen 2 core

`scripts/build_mesen.sh` builds the libretro version of Mesen 2 ([libretro/MesenCE](https://github.com/libretro/MesenCE))
at a pinned commit with its own `Makefile.libretro`, and links it with `src/bridge.c` — the same libretro host as
Mednafen, built with `-DBRIDGE_CONTENT_FILE` because Mesen reads the ROM from a file (here in Emscripten's in-memory
file system) and wants system and save folders. `scripts/patch_mesen.py` changes only its libretro front end and its
threads, not the emulation:

- the WonderSwan battery save (SRAM or EEPROM) is exposed to the page, and Y-up / Y-down are mapped (the port mapped
  only Y-left / Y-right);
- no background threads in WebAssembly (keyboard shortcuts, video decoding and rendering): each frame is decoded on
  the spot, as Mesen does in its own synchronous mode;
- one video filter is kept per game instead of building a new one — with NTSC tables — for every frame, which took
  ~80% of the time;
- vertical games turn by themselves (Mesen's own rule), and Select — the page's Rotate key — switches orientation.

Mesen is the fastest of the three in the browser: about 2.5 ms per frame in Node, five times real time. It contains
every console Mesen emulates, so `core-mesen.wasm` is about 5 MB and needs 128 MB of memory at start-up.

### Continuous integration and the live site

[GitHub Actions](.github/workflows/build.yml) builds and tests **every change**: pushes to any branch and pull
requests. A run passes only if all of these pass:

1. the bridge ABI test (mock core, built with AddressSanitizer / UBSan);
2. the WebAssembly build, with the corresponding-source archives;
3. the patch and archive unit tests and the output checks (`verify_build.py`);
4. the ares and Mesen core tests in Node (`tests/core_test.js`): video, all buttons, SRAM, save states, speed;
5. an **end-to-end test in headless Chromium** (`tests/e2e_test.js`) on the built site: core start-up, a homebrew
   test ROM generated by the test, all 11 buttons, SRAM, save states, the patch dialog and on-the-fly BPS patching
   (against a fake catalog), loading from `.zip` and `.7z`, switching to ares, to Mesen and back with the game
   running, and no console errors, failed requests or CSP violations.

Only a push to `main` whose run passed is **published**: a separate `deploy` job, which needs the `build` job, deploys
the site to GitHub Pages with the official `upload-pages-artifact` / `deploy-pages` actions (Settings → Pages →
Source: **GitHub Actions**). Pull requests and other branches are never published. The same build is kept as a
workflow artifact and force-pushed to the `wasm-build` branch, so it can also be fetched with plain git; Pages does not
use that branch, because pushes made with the workflow's `GITHUB_TOKEN` never trigger a Pages build. The compiled
files are never committed to `main`. Actions are pinned to commit SHAs and jobs get only the permissions they need.

### Project layout

| Path | What |
| --- | --- |
| `src/bridge.c`, `src/libretro_min.h` | minimal libretro host in C for Mednafen and Mesen: video/audio/input, core options, SRAM, states, exported as `ws_*` |
| `src/ares_host.cpp`, `src/ares_stubs.cpp`, `src/libco_emscripten.c` | the same `ws_*` API on ares; libco on Emscripten fibers |
| `site/app.js` | frontend: main loop, rendering, audio, input and remapping, saves, options |
| `site/worker.js` | Web Worker that runs the chosen core and returns each batch of frames (picture and sound) |
| `site/patches.js` | CRC32, BPS and IPS appliers, catalog lookup, patch chooser |
| `site/archive.js` | `.zip` reader (browser `DecompressionStream`) and `.7z` through 7-Zip WASM |
| `scripts/build.sh`, `scripts/build_ares.sh`, `scripts/patch_ares.py`, `scripts/build_mesen.sh`, `scripts/patch_mesen.py` | builds of the three cores |
| `scripts/package_sources.sh`, `scripts/verify_build.py` | source packaging, output checks |
| `tests/` | bridge ABI test with a mock core (C), patch, archive and core tests (Node), end-to-end browser test (Playwright) |

### Tests

```sh
gcc -fsanitize=address,undefined scripts/mock_core_test.c src/bridge.c -o mock && ./mock
node tests/patches_test.js
SEVENZIP_DIR=.build/7z-wasm/package node tests/archive_test.js   # after a build; without it the 7z part is skipped
npm install --no-save playwright@1.63.0 && npx playwright install chromium
node tests/core_test.js site ares && node tests/core_test.js site mesen   # after a build
node tests/e2e_test.js site                                      # after a build
```

## Limitations

- No link cable, no cheats, no cloud saves.
- Save states depend on the core and its version; keep SRAM exports as your real backups.
- ares needs more CPU than Mednafen or Mesen in the browser (see *The ares core*); on slow machines use one of those.
- Patch names, versions and languages in the catalog are read from the authors' release names and files, so a few
  may be imprecise; the checksums are exact.

## Troubleshooting

- **"Core unavailable: core.js is missing"** — the site was opened from the source tree; use a build (`scripts/build.sh`
  or the `wasm-build` branch).
- **No patch window** — no catalog entry for that exact ROM (another revision or a bad dump gives another CRC32), the
  option is off, or the catalog could not be reached (the status line says which).
- **"PATCH FAILED … running the original ROM"** — the patch does not fit this ROM or the download was damaged; the
  message says which check failed.
- **No sound** — press **Enable sound**.
- **Stutter on a 60 Hz screen** — make sure **60 Hz mode** is on.

## License, source and credits

This project — the bridge in `src/`, the web frontend in `site/`, the build scripts and tests — is free software under
the **GNU General Public License, version 2 or (at your option) any later version** ([`LICENSE`](LICENSE)). Each
compiled core is distributed under the license of the emulator it contains: `core.wasm` (Mednafen) under GPL v2,
`core-mesen.wasm` (Mesen 2) under GPL v3, `core-ares.wasm` (ares, ISC) under GPL v2 or later.

- **Beetle WonderSwan / Mednafen** ([libretro/beetle-wswan-libretro](https://github.com/libretro/beetle-wswan-libretro)),
  GPL-2.0, is linked with the bridge into `core.wasm`.
- **ares** ([ares-emulator/ares](https://github.com/ares-emulator/ares)), ISC license, is linked with the ares host into
  `core-ares.wasm`; its license is shipped as `ares-LICENSE.txt`.
- **Mesen 2** ([libretro/MesenCE](https://github.com/libretro/MesenCE), by Sour and contributors), GPL-3.0, is linked
  with the bridge into `core-mesen.wasm`, which is therefore distributed under GPL v3; its license is shipped as
  `mesen-LICENSE.txt`.
- **7-Zip** compiled to WebAssembly ([7z-wasm](https://github.com/use-strict/7z-wasm) by Alexandru Ciuca; 7-Zip by Igor
  Pavlov), GNU LGPL v2.1 + unRAR restriction, is shipped unmodified as a separate file for `.7z` support.
- **Translation patches** are the work of their authors (mariovirgili, PokemonGoDB, Gand46) and are not part of this
  project; they are downloaded from WonderSwan_bps_repo at run time. Please follow each author's terms: the AI
  translation patches are shared for personal use and should not be uploaded to romhacking sites.

Every build ships the complete corresponding source of what it distributes in `site/source/`, linked from the page
footer:

| File | Contents |
| --- | --- |
| `wonderswan-ai-mtl-tester-source.tar.gz` | this repository at the exact commit built (local builds also include uncommitted changes to tracked files) |
| `beetle-wswan-source.tar.gz` | Beetle at the pinned commit, exactly as compiled |
| `ares-source.tar.gz` | the ares files compiled into `core-ares.wasm`, at the pinned commit, exactly as compiled |
| `mesen-source.tar.gz` | Mesen 2 (MesenCE) at the pinned commit: the folders compiled into `core-mesen.wasm`, exactly as compiled |
| `7z-wasm-1.2.0-source.tar.gz` | 7z-wasm's build files at tag v1.2.0 and the 7-Zip 24.09 source release they build; the build checks that the shipped `7zz.wasm` is the one from that tag |
| `SOURCES.txt` | commits, Emscripten version, SHA-256 of every archive and binary, rebuild notes |

The licenses travel with the site: `COPYING` (GPL v2), `ares-LICENSE.txt` (ISC), `mesen-LICENSE.txt` (GPL v3) and, in `vendor/7z/`, `License.txt`, `copying-LGPL.txt` and
`unRarLicense.txt`. Anyone redistributing the built site must keep these files with it.

WonderSwan is a trademark of Bandai; game titles belong to their owners and are used for identification only. No ROMs
or BIOS are distributed.
