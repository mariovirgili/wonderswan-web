#!/usr/bin/env bash
# Build a static standalone Beetle/Mednafen WonderSwan WASM core.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/.build/beetle-wswan"
OUT="$ROOT/site"
# Pin to a publicly documented upstream commit for reproducibility.
BEETLE_REF="${BEETLE_REF:-4b01295838ea89e3f1355bbe4cb5cf98aa6108cd}"
for cmd in git emcc emmake emar make python3 tar; do
  command -v "$cmd" >/dev/null || { echo "Missing: $cmd" >&2; exit 1; }
done
mkdir -p "$ROOT/.build" "$OUT/source"
if [[ ! -d "$CORE/.git" ]]; then
  git clone --no-checkout --filter=blob:none https://github.com/libretro/beetle-wswan-libretro.git "$CORE"
fi
( cd "$CORE"; git checkout -q --detach "$BEETLE_REF" )
echo "Upstream: $(git -C "$CORE" rev-parse HEAD)"
# The core's own emscripten target emits a static archive, historically named .bc.
# Include compatibility implementations that are not supplied by a Libretro frontend.
if grep -Fq 'ifneq ($(STATIC_LINKING), 1)' "$CORE/Makefile.common"; then
  sed -i.bak 's/ifneq ($(STATIC_LINKING), 1)/ifeq (1, 1)/g' "$CORE/Makefile.common"
fi
emmake make -C "$CORE" -j"${JOBS:-2}" platform=emscripten CC=emcc CXX=em++ AR=emar
LIB="$CORE/mednafen_wswan_libretro_emscripten.bc"
[[ -s "$LIB" ]] || { echo "Core archive not generated: $LIB" >&2; exit 1; }
# Prevent stale outputs if linking fails.
rm -f "$OUT/core.js" "$OUT/core.wasm"
EXPORTS='["_malloc","_free","_ws_init","_ws_load","_ws_unload","_ws_run","_ws_set_input","_ws_get_video","_ws_get_width","_ws_get_height","_ws_get_audio","_ws_get_audio_frames","_ws_get_sample_rate","_ws_get_fps","_ws_get_save_size","_ws_get_save","_ws_set_save","_ws_reset","_ws_get_state_size","_ws_save_state","_ws_load_state","_ws_shutdown"]'
emcc -O3 "$ROOT/src/bridge.c" \
  -Wl,--whole-archive "$LIB" -Wl,--no-whole-archive -lm \
  -sWASM=1 -sMODULARIZE=1 -sEXPORT_NAME=createWonderSwan \
  -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 \
  -sSTACK_SIZE=2097152 -sFILESYSTEM=0 -sASSERTIONS=0 \
  "-sEXPORTED_FUNCTIONS=$EXPORTS" \
  '-sEXPORTED_RUNTIME_METHODS=["cwrap","HEAPU8"]' \
  -o "$OUT/core.js"
cp "$CORE/COPYING" "$OUT/COPYING"
# GPL distribution: include complete corresponding upstream source with the site.
tar --exclude=.git --exclude='*.o' --exclude='*.bc' --exclude='*.bak' \
  -czf "$OUT/source/beetle-wswan-source.tar.gz" -C "$CORE" .
python3 "$ROOT/scripts/verify_build.py" "$ROOT"
echo "Build complete: $OUT/core.js / $OUT/core.wasm"
