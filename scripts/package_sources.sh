#!/usr/bin/env bash
# Put the complete corresponding source of everything the site ships in object form
# into site/source/, with a manifest (SOURCES.txt). Called by scripts/build.sh after the build.
#
#   wonderswan-ai-mtl-tester-source.tar.gz  this project at the commit being built
#                                           (bridge.c, frontend, build scripts, CI workflow, tests)
#   beetle-wswan-source.tar.gz              Beetle WonderSwan exactly as compiled (GPL-2.0)
#   7z-wasm-<ver>-source.tar.gz             7z-wasm build files at the published tag + the 7-Zip
#                                           source release it is built from (LGPL-2.1 + unRAR restriction)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/site"
SRC="$OUT/source"
CORE="${CORE:-$ROOT/.build/beetle-wswan}"
SEVENZIP_VERSION="${SEVENZIP_VERSION:?}"
SZ="$ROOT/.build/7z-wasm"
for cmd in git tar curl node sha256sum; do
  command -v "$cmd" >/dev/null || { echo "Missing: $cmd" >&2; exit 1; }
done
rm -rf "$SRC" && mkdir -p "$SRC"

# 1. This project. `git stash create` captures uncommitted changes to tracked files, so a local build
#    from a modified tree still ships the source it was built from.
SELF_REF="$(git -C "$ROOT" stash create 2>/dev/null || true)"
SELF_REF="${SELF_REF:-$(git -C "$ROOT" rev-parse HEAD)}"
SELF_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
DIRTY=""
[[ "$SELF_REF" != "$SELF_COMMIT" ]] && DIRTY=" + uncommitted changes to tracked files"
git -C "$ROOT" archive --format=tar.gz --prefix=wonderswan-ai-mtl-tester/ -o "$SRC/wonderswan-ai-mtl-tester-source.tar.gz" "$SELF_REF"

# 2. Beetle, as compiled (including the Makefile.common adjustment made by build.sh).
BEETLE_COMMIT="$(git -C "$CORE" rev-parse HEAD)"
tar --exclude=.git --exclude='*.o' --exclude='*.bc' --exclude='*.a' --exclude='*.bak' \
  --transform 's,^\.,beetle-wswan-libretro,' -czf "$SRC/beetle-wswan-source.tar.gz" -C "$CORE" .

# 3. 7z-wasm: build files at the release tag, checked against the binary we ship, plus 7-Zip's source.
SZSRC="$ROOT/.build/7z-wasm-src"
rm -rf "$SZSRC"
git -c advice.detachedHead=false clone -q --depth 1 --branch "v$SEVENZIP_VERSION" https://github.com/use-strict/7z-wasm.git "$SZSRC/repo"
SZ_COMMIT="$(git -C "$SZSRC/repo" rev-parse HEAD)"
cmp -s "$SZSRC/repo/7zz.wasm" "$SZ/package/7zz.wasm" \
  || { echo "7z-wasm v$SEVENZIP_VERSION: npm 7zz.wasm differs from the tagged repository" >&2; exit 1; }
SZ_SRC_FILE="$(grep -oE '7z[0-9]+-src\.7z' "$SZSRC/repo/Dockerfile" | head -1)"
[[ -n "$SZ_SRC_FILE" ]] || { echo "Cannot find the 7-Zip source release in 7z-wasm's Dockerfile" >&2; exit 1; }
mkdir -p "$SZSRC/pkg/7z-wasm-$SEVENZIP_VERSION"
git -C "$SZSRC/repo" archive "v$SEVENZIP_VERSION" | tar -x -C "$SZSRC/pkg/7z-wasm-$SEVENZIP_VERSION"
# The prebuilt outputs are object code, not source.
rm -f "$SZSRC/pkg/7z-wasm-$SEVENZIP_VERSION/7zz.wasm" "$SZSRC/pkg/7z-wasm-$SEVENZIP_VERSION/7zz."*.js
curl -fsSL --retry 3 "https://www.7-zip.org/a/$SZ_SRC_FILE" -o "$SZSRC/pkg/7z-wasm-$SEVENZIP_VERSION/$SZ_SRC_FILE"
SZ_SRC_SHA="$(sha256sum "$SZSRC/pkg/7z-wasm-$SEVENZIP_VERSION/$SZ_SRC_FILE" | cut -d' ' -f1)"
tar -czf "$SRC/7z-wasm-$SEVENZIP_VERSION-source.tar.gz" -C "$SZSRC/pkg" "7z-wasm-$SEVENZIP_VERSION"
# The full LGPL text, taken from 7-Zip's own source release, next to the binary.
node -e '
  const SevenZip = require(process.argv[1]);
  const fs = require("fs");
  (async () => {
    const z = await SevenZip({ print() {}, printErr() {} });
    z.FS.writeFile("/s.7z", fs.readFileSync(process.argv[2]));
    try { z.callMain(["e", "/s.7z", "-o/o", "DOC/copying.txt", "-y", "-bso0", "-bsp0"]); } catch (e) {}
    fs.writeFileSync(process.argv[3], z.FS.readFile("/o/copying.txt"));
    process.exitCode = 0;
  })().catch(e => { console.error(e); process.exit(1); });
' "$SZ/package/7zz.umd.js" "$SZSRC/pkg/7z-wasm-$SEVENZIP_VERSION/$SZ_SRC_FILE" "$OUT/vendor/7z/copying-LGPL.txt"
grep -q "LESSER GENERAL PUBLIC LICENSE" "$OUT/vendor/7z/copying-LGPL.txt" \
  || { echo "LGPL text not found in $SZ_SRC_FILE" >&2; exit 1; }

# Manifest.
sha() { sha256sum "$1" | cut -d' ' -f1; }
EMCC_VERSION="$(emcc --version 2>/dev/null | head -1 || echo unknown)"
cat > "$SRC/SOURCES.txt" <<TXT
WonderSwan AI/MTL Tester - corresponding source
===============================================

This site ships object code (WebAssembly) built from the sources below. Each archive in this
folder is the complete corresponding source for the parts named, as required by the GNU GPL v2
(core.wasm / core.js) and the GNU LGPL v2.1 (vendor/7z). Built $(date -u +%Y-%m-%dT%H:%MZ).

1. wonderswan-ai-mtl-tester-source.tar.gz
   This project: src/bridge.c, the web frontend (site/*.html, *.js, *.css), scripts/build.sh,
   scripts/package_sources.sh, the GitHub Actions workflow and the tests.
   Repository: https://github.com/mariovirgili/wonderswan-web
   Commit: $SELF_COMMIT$DIRTY
   License: GPL-2.0-only (LICENSE)
   sha256: $(sha "$SRC/wonderswan-ai-mtl-tester-source.tar.gz")

2. beetle-wswan-source.tar.gz
   Beetle WonderSwan (Mednafen) libretro core, as compiled (scripts/build.sh enables the
   compatibility files in Makefile.common).
   Repository: https://github.com/libretro/beetle-wswan-libretro
   Commit: $BEETLE_COMMIT
   License: GPL-2.0 (COPYING)
   sha256: $(sha "$SRC/beetle-wswan-source.tar.gz")

   core.wasm + core.js = (2) linked with src/bridge.c from (1), using: $EMCC_VERSION
   sha256 core.wasm: $(sha "$OUT/core.wasm")

3. 7z-wasm-$SEVENZIP_VERSION-source.tar.gz
   7z-wasm $SEVENZIP_VERSION build files (Dockerfile, build scripts, 7zz-emcc.patch - which adds
   makefile.emcc, pre.js and post.js to the 7-Zip tree)
   at tag v$SEVENZIP_VERSION, commit $SZ_COMMIT, plus the 7-Zip source release it is built from:
   $SZ_SRC_FILE (sha256 $SZ_SRC_SHA, https://www.7-zip.org/a/$SZ_SRC_FILE).
   vendor/7z/7zz.wasm and 7zz.umd.js are the unmodified npm release 7z-wasm@$SEVENZIP_VERSION;
   the build checks that its 7zz.wasm is identical to the one in the tagged repository.
   License: GNU LGPL v2.1 + unRAR restriction (vendor/7z/License.txt, copying-LGPL.txt,
   unRarLicense.txt). The unRAR code may not be used to re-create the RAR compression algorithm.
   sha256: $(sha "$SRC/7z-wasm-$SEVENZIP_VERSION-source.tar.gz")
   sha256 vendor/7z/7zz.wasm: $(sha "$OUT/vendor/7z/7zz.wasm")

To rebuild: unpack (1), install the Emscripten SDK version above, run scripts/build.sh
(it fetches (2) at the same commit and 7z-wasm $SEVENZIP_VERSION). To rebuild 7-Zip itself,
follow README.md / build in (3).
TXT
echo "Corresponding source written to $SRC"
