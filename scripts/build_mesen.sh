#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Build Mesen 2 (libretro/MesenCE, GPL-3.0) for WebAssembly: site/core-mesen.js + core-mesen.wasm.
# The libretro core is linked with src/bridge.c (built with -DBRIDGE_CONTENT_FILE: Mesen reads the
# ROM from a file, here in Emscripten's in-memory file system). scripts/patch_mesen.py adapts the
# libretro front end and Mesen's threads to the browser. Called by scripts/build.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/.build/mesen"
OUT="$ROOT/site"
# Pin to a publicly documented upstream commit for reproducibility.
MESEN_REF="${MESEN_REF:-4c4e069f16a8ad6ed79e046046c56d51558c7daf}"
for cmd in git emcc em++ emar emmake make python3; do
  command -v "$cmd" >/dev/null || { echo "Missing: $cmd" >&2; exit 1; }
done
mkdir -p "$ROOT/.build"
if [[ ! -d "$SRC/.git" ]]; then
  git clone --no-checkout --filter=blob:none https://github.com/libretro/MesenCE.git "$SRC"
fi
( cd "$SRC"; git checkout -q --detach "$MESEN_REF"; git checkout -q -- . )
echo "Mesen upstream: $(git -C "$SRC" rev-parse HEAD)"
python3 "$ROOT/scripts/patch_mesen.py" "$SRC"

# Compile with Mesen's own libretro makefile (objects only: its link step makes a native
# shared library). No LTO; -k is not used, so any compile error stops the build.
emmake make -C "$SRC" -f Makefile.libretro libretro -j"${JOBS:-4}" \
  CC=emcc CXX=em++ AR=emar HAVE_LTO=0 STATICLINK=false LINKCHECKUNRESOLVED= \
  MACHINE=wasm32-unknown-emscripten SHAREDLIB=mesen2_libretro_unused.so
rm -f "$SRC/mesen2_libretro_unused.so"

OBJ="$ROOT/.build/mesen-obj"
rm -rf "$OBJ" && mkdir -p "$OBJ"
emcc -O3 -DBRIDGE_CONTENT_FILE -c "$ROOT/src/bridge.c" -o "$OBJ/bridge.o"
mapfile -t MESEN_OBJS < <(cd "$SRC" && { echo Libretro/libretro.o; echo Libretro/VfsFile.o; find SevenZip Lua Utilities Core -name '*.o' | sort; })

rm -f "$OUT/core-mesen.js" "$OUT/core-mesen.wasm"
EXPORTS='["_malloc","_free","_ws_init","_ws_load","_ws_unload","_ws_run","_ws_set_input","_ws_get_video","_ws_get_width","_ws_get_height","_ws_get_audio","_ws_get_audio_frames","_ws_get_sample_rate","_ws_get_fps","_ws_get_save_size","_ws_get_save","_ws_set_save","_ws_reset","_ws_prepare_state","_ws_get_state_size","_ws_save_state","_ws_load_state","_ws_shutdown","_ws_set_option"]'
# Mesen's static data (all its consoles) needs more than 64 MB at start-up.
( cd "$SRC" && em++ -O3 "$OBJ/bridge.o" "${MESEN_OBJS[@]}" -lm \
  -sWASM=1 -sMODULARIZE=1 -sEXPORT_NAME=createMesen \
  -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 \
  -sSTACK_SIZE=2097152 -sASSERTIONS=0 \
  "-sEXPORTED_FUNCTIONS=$EXPORTS" \
  '-sEXPORTED_RUNTIME_METHODS=["cwrap","HEAPU8"]' \
  -o "$OUT/core-mesen.js" )
cp "$SRC/LICENSE" "$OUT/mesen-LICENSE.txt"
echo "Mesen build complete: $OUT/core-mesen.js / $OUT/core-mesen.wasm"
