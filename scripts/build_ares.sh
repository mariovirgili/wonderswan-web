#!/usr/bin/env bash
# Build the ares WonderSwan core for WebAssembly: site/core-ares.js + site/core-ares.wasm.
# ares (ISC license) runs every chip as a cothread (libco); in WebAssembly the cothreads are
# Emscripten fibers, which need Asyncify. Called by scripts/build.sh; can also run alone.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/.build/ares"
OBJ="$ROOT/.build/ares-obj"
OUT="$ROOT/site"
# Pin to a publicly documented upstream commit for reproducibility.
ARES_REF="${ARES_REF:-4307bf2eff6e4f9a277fdc6f9d4f4de177b3f932}"
NATIVE_CXX="${NATIVE_CXX:-$(command -v clang++ || command -v c++)}"
for cmd in git em++ emcc python3 "$NATIVE_CXX"; do
  command -v "$cmd" >/dev/null || { echo "Missing: $cmd" >&2; exit 1; }
done
mkdir -p "$ROOT/.build"
if [[ ! -d "$SRC/.git" ]]; then
  git clone --no-checkout --filter=blob:none https://github.com/ares-emulator/ares.git "$SRC"
fi
( cd "$SRC"; git checkout -q --detach "$ARES_REF"; git checkout -q -- . )
echo "ares upstream: $(git -C "$SRC" rev-parse HEAD)"
python3 "$ROOT/scripts/patch_ares.py" "$SRC"

# Generated sources, as ares' CMake build makes them: the resource file (icons for the
# WonderSwan's LCD segments, via ares' own 'sourcery' tool, built natively) and ares.cpp.
TOOLS="$ROOT/.build/ares-tools"
mkdir -p "$TOOLS"
if [[ ! -x "$TOOLS/sourcery" ]]; then
  ( cd "$SRC" && "$NATIVE_CXX" -std=c++20 -O1 -w -I. -Inall -Ithirdparty \
      tools/sourcery/sourcery.cpp nall/nall/nall.cpp nall/nall/main.cpp -o "$TOOLS/sourcery" -lpthread -ldl )
fi
( cd "$SRC/ares/ares/resource" && "$TOOLS/sourcery" resource.bml resource.cpp resource.hpp )
sed -e 's/@ARES_NAME@/ares/' -e 's/@ARES_VERSION@/web/' \
    -e 's/@ARES_LEGAL_COPYRIGHT_SHORT@/ares team, Near et al/' -e 's/@ARES_WEBSITE@/ares-emu.net/' \
    "$SRC/ares/ares/ares.cpp.in" > "$SRC/ares/ares/ares.cpp"

# Compile. The WonderSwan core and its two shared components (the V30MZ CPU and the
# 93LCxx EEPROM) are each one translation unit, as in ares' own unity build.
rm -rf "$OBJ" && mkdir -p "$OBJ"
# -Wno-c++11-narrowing: ares builds std::span from 64-bit sizes; on wasm32 size_t is 32 bits
# (the WonderSwan's memories are at most a few MB, so nothing is lost).
CXXFLAGS=(-std=c++20 -O3 -DPROFILE_PERFORMANCE -w -Wno-c++11-narrowing -I"$SRC" -I"$SRC/ares" -I"$SRC/nall" -I"$SRC/thirdparty" -I"$SRC/libco")
UNITS=(
  "$SRC/ares/ares/ares.cpp"
  "$SRC/ares/component/processor/v30mz/v30mz.cpp"
  "$SRC/ares/component/eeprom/m93lcx6/m93lcx6.cpp"
  "$SRC/ares/ws/ws.cpp"
  "$ROOT/src/ares_host.cpp"
  "$ROOT/src/ares_stubs.cpp"
)
pids=()
for unit in "${UNITS[@]}"; do
  em++ "${CXXFLAGS[@]}" -MD -MF "$OBJ/$(basename "$unit" .cpp).d" -c "$unit" -o "$OBJ/$(basename "$unit" .cpp).o" & pids+=($!)
done
emcc -O3 -I"$SRC/libco" -MD -MF "$OBJ/libco_emscripten.d" -c "$ROOT/src/libco_emscripten.c" -o "$OBJ/libco_emscripten.o" & pids+=($!)
for pid in "${pids[@]}"; do wait "$pid"; done

# The ares files that went into the build (from the compiler's dependency lists), plus the
# license, the README and the sourcery tool, for the source archive (scripts/package_sources.sh).
python3 - "$SRC" "$OBJ" > "$ROOT/.build/ares-files.txt" <<'PY'
import pathlib, re, sys
src, obj = pathlib.Path(sys.argv[1]).resolve(), pathlib.Path(sys.argv[2])
files = {'LICENSE', 'README.md'}
for d in obj.glob('*.d'):
    for f in re.split(r'\s+', d.read_text().replace('\\\n', ' ')):
        f = f.rstrip(':')
        if not f or f.endswith('.o'):
            continue
        p = pathlib.Path(f).resolve()
        if p.is_file() and src in p.parents:
            files.add(str(p.relative_to(src)))
for p in (src / 'tools/sourcery').rglob('*'):
    if p.is_file():
        files.add(str(p.relative_to(src)))
files.add('ares/ares/resource/resource.bml')
files.update(str(p.relative_to(src)) for p in (src / 'ares/ares/resource').rglob('*.png'))
print('\n'.join(sorted(files)))
PY

rm -f "$OUT/core-ares.js" "$OUT/core-ares.wasm"
EXPORTS='["_malloc","_free","_ws_init","_ws_load","_ws_unload","_ws_run","_ws_set_input","_ws_get_video","_ws_get_width","_ws_get_height","_ws_get_audio","_ws_get_audio_frames","_ws_get_sample_rate","_ws_get_fps","_ws_get_save_size","_ws_get_save","_ws_set_save","_ws_reset","_ws_prepare_state","_ws_get_state_size","_ws_save_state","_ws_load_state","_ws_shutdown","_ws_set_option"]'
# Asyncify instruments every function that may be on the stack when a cothread switches, which
# slows it down. These functions never are (no switch can happen inside them), so they are left
# uninstrumented: drawing, bus and ROM reads, sound channels, ares' video/audio nodes, nall, and
# the host's callbacks. Measured: about 20% faster per frame.
ASYNCIFY_REMOVE='["ares::WonderSwan::PPU::Screen::*","ares::WonderSwan::PPU::fetch*","ares::WonderSwan::PPU::color*","ares::WonderSwan::Bus::*","ares::WonderSwan::Cartridge::readROM*","ares::WonderSwan::APU::Channel*","ares::WonderSwan::APU::output*","ares::Platform::*","ares::Core::Video::*","ares::Core::Audio::*","nall::*","*Host::*"]'
em++ -O3 "$OBJ"/*.o \
  -sASYNCIFY=1 "-sASYNCIFY_REMOVE=$ASYNCIFY_REMOVE" \
  -sWASM=1 -sMODULARIZE=1 -sEXPORT_NAME=createAres \
  -sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 \
  -sSTACK_SIZE=1048576 -sFILESYSTEM=0 -sASSERTIONS=0 \
  "-sEXPORTED_FUNCTIONS=$EXPORTS" \
  '-sEXPORTED_RUNTIME_METHODS=["cwrap","HEAPU8"]' \
  -o "$OUT/core-ares.js"
cp "$SRC/LICENSE" "$OUT/ares-LICENSE.txt"
echo "ares build complete: $OUT/core-ares.js / $OUT/core-ares.wasm"
