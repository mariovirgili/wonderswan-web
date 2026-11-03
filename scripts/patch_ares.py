#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""Small source changes so ares builds and runs well in WebAssembly (Emscripten).

ares' nall library detects the platform and CPU architecture at compile time
and stops on anything it does not know. WebAssembly is treated as a POSIX
("Linux") platform with a generic little-endian architecture: nothing in the
WonderSwan core depends on a specific CPU. sljit is left out, frames are drawn
without a video thread, and the idle serial port wakes less often (see below).
The patch is idempotent.
"""
import pathlib, sys

root = pathlib.Path(sys.argv[1])
p = root / 'nall/nall/intrinsics.hpp'
s = p.read_text()
old_platform = '#elif defined(linux) || defined(__linux__)\n  #define PLATFORM_LINUX'
new_platform = '#elif defined(linux) || defined(__linux__) || defined(__EMSCRIPTEN__) || defined(__wasi__)\n  #define PLATFORM_LINUX'
old_arch = '#else\n  #error "unable to detect architecture"'
new_arch = '''#elif defined(__wasm32__) || defined(__wasm64__)
  #define ARCHITECTURE_WASM
  struct Architecture {
    static constexpr bool x86   = 0;
    static constexpr bool amd64 = 0;
    static constexpr bool arm64 = 0;
    static constexpr bool arm32 = 0;
    static constexpr bool ppc64 = 0;
    static constexpr bool ppc32 = 0;
    static constexpr bool rv64  = 0;
    static constexpr bool rv32  = 0;
  };
#else
  #error "unable to detect architecture"'''
old_endian = '|| defined(__i386__) || defined(__amd64__)'
new_endian = '|| defined(__wasm__) || defined(__i386__) || defined(__amd64__)'
for old, new in ((old_platform, new_platform), (old_arch, new_arch), (old_endian, new_endian)):
    if new in s:
        continue
    if s.count(old) != 1:
        sys.exit(f'patch_ares: pattern not found once in {p}: {old!r}')
    s = s.replace(old, new)
p.write_text(s)

# sljit (the JIT used by other ares cores) has no WebAssembly backend and the
# WonderSwan core does not use it: leave it out of the build.
p = root / 'ares/ares/ares.hpp'
s = p.read_text()
old, new = '#include <sljit.h>\n', '#if !defined(__wasm__)\n#include <sljit.h>\n#endif\n'
if new not in s:
    if s.count(old) != 1:
        sys.exit(f'patch_ares: pattern not found once in {p}: {old!r}')
    s = s.replace(old, new)
# ares draws each finished frame on a separate video thread. WebAssembly here has no threads,
# so the emulator would wait forever for it: draw in the emulation thread instead, as ares'
# own non-threaded mode does.
old = '    static constexpr bool Threaded = true;\n'
new = '#if defined(__wasm__)\n    static constexpr bool Threaded = false;\n#else\n    static constexpr bool Threaded = true;\n#endif\n'
if new not in s:
    if s.count(old) != 1:
        sys.exit(f'patch_ares: pattern not found once in {p}: {old!r}')
    s = s.replace(old, new)
p.write_text(s)

# The serial port thread wakes every 80 cycles even when the port is off, which costs ~500
# cothread switches per frame - expensive in WebAssembly (see scripts/build_ares.sh). There is
# no link cable in the browser, so while the port is disabled it wakes every 5120 cycles
# (1.7 ms) instead; once a game enables it, timing is unchanged.
p = root / 'ares/ws/serial/serial.cpp'
s = p.read_text()
old, new = 'auto Serial::main() -> void {\n  step(80);\n', 'auto Serial::main() -> void {\n  step(state.enable ? 80 : 80 * 64);\n'
if new not in s:
    if s.count(old) != 1:
        sys.exit(f'patch_ares: pattern not found once in {p}: {old!r}')
    s = s.replace(old, new)
p.write_text(s)
print('patch_ares: intrinsics.hpp, ares.hpp and ws/serial/serial.cpp patched')
