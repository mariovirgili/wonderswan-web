# WonderSwan AI/MTL Tester

A WonderSwan / WonderSwan Color emulator that runs in the browser, made for **playing and testing AI and machine
translations** of Japanese games. Load a ROM and the emulator looks it up in a catalog of translation patches; if
there are any, it lists them and applies the one you pick **on the fly, in memory** — no patching tools, no patched
files on disk.

**Try it:** <https://mariovirgili.github.io/wonderswan-web/>

The emulation is the real thing: the [Beetle WonderSwan](https://github.com/libretro/beetle-wswan-libretro) core
(Mednafen) compiled to WebAssembly, driven by a small purpose-built frontend — no RetroArch. No ROMs or BIOS are
included or uploaded anywhere: you load your own dumps, and they never leave your browser.

## Features

- **Translation patches on load.** The ROM's CRC32 is checked against
  [WonderSwan_bps_repo](https://github.com/mariovirgili/WonderSwan_bps_repo), a daily-updated mirror of the
  `.bps` / `.ips` patches published by mariovirgili, PokemonGoDB and Gand46. Matching patches are listed by author
  (mariovirgili first, then the others; each author separated by a thin bar) and by version, newest first, with
  language, format and a link to the release. The chosen patch is downloaded, verified and applied before the game
  starts. **Play original** (or Esc) skips it.
- **ROMs in archives.** `.ws`, `.wsc`, `.pc2`, or the same inside `.zip` / `.7z` files. If an archive holds several
  ROMs, you pick one.
- **Smooth on 60 Hz screens.** Optional 60 Hz mode (on by default) instead of the console's native 75.47 Hz.
- **Battery saves** kept automatically in the browser, per ROM *and* per patch; **export / import** of SRAM and
  **save states**.
- **Controls** for keyboard, gamepad and touch, including the WonderSwan's second (Y) direction pad and screen rotation.
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

Some games use the Y pad; the touch controls under the screen have both pads. In **Options** you can turn off the
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
with `src/bridge.c` into `site/core.wasm` / `core.js`, adds 7-Zip for WebAssembly (7z-wasm 1.2.0, pinned) under
`site/vendor/7z/`, and writes the corresponding source of everything into `site/source/`.

### Continuous integration and the live site

On every push to `main`, [GitHub Actions](.github/workflows/build.yml) builds the core, runs the tests and **deploys
the site to GitHub Pages** with the official `upload-pages-artifact` / `deploy-pages` actions (Settings → Pages →
Source: **GitHub Actions**). The same build is kept as a workflow artifact and force-pushed to the `wasm-build`
branch, so it can also be fetched with plain git; Pages does not use that branch, because pushes made with the
workflow's `GITHUB_TOKEN` never trigger a Pages build. The compiled files are never committed to `main`.

### Project layout

| Path | What |
| --- | --- |
| `src/bridge.c`, `src/libretro_min.h` | minimal libretro host in C: video/audio/input, core options, SRAM, states, exported as `ws_*` |
| `site/app.js` | frontend: main loop, rendering, audio, input, saves, options |
| `site/patches.js` | CRC32, BPS and IPS appliers, catalog lookup, patch chooser |
| `site/archive.js` | `.zip` reader (browser `DecompressionStream`) and `.7z` through 7-Zip WASM |
| `scripts/build.sh`, `scripts/package_sources.sh`, `scripts/verify_build.py` | build, source packaging, output checks |
| `tests/` | bridge ABI test with a mock core (C), patch and archive tests (Node) |

### Tests

```sh
gcc -fsanitize=address,undefined scripts/mock_core_test.c src/bridge.c -o mock && ./mock
node tests/patches_test.js
SEVENZIP_DIR=.build/7z-wasm/package node tests/archive_test.js   # after a build; without it the 7z part is skipped
```

## Limitations

- No link cable, no cheats, no cloud saves.
- Save states depend on the core version; keep SRAM exports as your real backups.
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
the **GNU General Public License v2** ([`LICENSE`](LICENSE)).

- **Beetle WonderSwan / Mednafen** ([libretro/beetle-wswan-libretro](https://github.com/libretro/beetle-wswan-libretro)),
  GPL-2.0, is linked with the bridge into `core.wasm`.
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
| `7z-wasm-1.2.0-source.tar.gz` | 7z-wasm's build files at tag v1.2.0 and the 7-Zip 24.09 source release they build; the build checks that the shipped `7zz.wasm` is the one from that tag |
| `SOURCES.txt` | commits, Emscripten version, SHA-256 of every archive and binary, rebuild notes |

The licenses travel with the site: `COPYING` (GPL v2) and, in `vendor/7z/`, `License.txt`, `copying-LGPL.txt` and
`unRarLicense.txt`. Anyone redistributing the built site must keep these files with it.

WonderSwan is a trademark of Bandai; game titles belong to their owners and are used for identification only. No ROMs
or BIOS are distributed.
