#!/usr/bin/env python3
"""Static package checks; optional WASM header checks after build."""
import pathlib, sys, re
root=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else pathlib.Path(__file__).resolve().parents[1]);site=root/'site'
for name in ('index.html','app.js','worker.js','style.css','patches.js','archive.js'):
    assert (site/name).is_file(), f'Missing: {name}'
html=(site/'index.html').read_text(); js=(site/'app.js').read_text()+(site/'worker.js').read_text(); bridge=(root/'src/bridge.c').read_text(); ares=(root/'src/ares_host.cpp').read_text()
for suffix in ('.ws','.wsc','.pc2'): assert suffix in html, suffix
for func in ('ws_init','ws_load','ws_run','ws_get_video','ws_get_audio','ws_set_input','ws_get_save','ws_save_state'):
    assert re.search(r'\b'+func+r'\b',bridge),func
    assert re.search(r'\b'+func+r'\b',ares),func
    assert func in js or func.replace('ws_','') in js,func
for name in ('core.js','core.wasm'):
    path=site/name
    if path.exists(): assert path.stat().st_size>3000, f'Empty output: {path}'
if (site/'core.wasm').exists():
    assert (site/'core.wasm').read_bytes()[:4]==b'\x00asm', 'Invalid WASM magic'
    assert (site/'COPYING').exists(), 'Missing GPL license'
    for f in ('beetle-wswan-source.tar.gz','wonderswan-ai-mtl-tester-source.tar.gz','SOURCES.txt'):
        assert (site/'source'/f).exists(), f'Missing corresponding source: {f}'
    assert list((site/'source').glob('7z-wasm-*-source.tar.gz')), 'Missing 7z-wasm corresponding source'
    assert (site/'vendor/7z/copying-LGPL.txt').exists(), 'Missing LGPL text'
    assert 'mariovirgili/wonderswan-web' in (site/'source/SOURCES.txt').read_text(), 'Bad SOURCES.txt'
    for f in ('7zz.umd.js','7zz.wasm','License.txt'):
        assert (site/'vendor/7z'/f).exists(), f'Missing 7-Zip file: {f}'
    assert (site/'vendor/7z/7zz.wasm').read_bytes()[:4]==b'\x00asm', 'Invalid 7-Zip WASM'
    # The ares core is built together with the Mednafen one (scripts/build_ares.sh).
    assert (site/'core-ares.wasm').read_bytes()[:4]==b'\x00asm', 'Missing or invalid core-ares.wasm'
    assert (site/'core-ares.js').stat().st_size>3000, 'Missing core-ares.js'
    assert 'ISC' in (site/'ares-LICENSE.txt').read_text() or 'Permission to use' in (site/'ares-LICENSE.txt').read_text(), 'Missing ares license'
    assert (site/'source/ares-source.tar.gz').exists(), 'Missing ares source archive'
    assert 'ares-emulator/ares' in (site/'source/SOURCES.txt').read_text(), 'ares missing from SOURCES.txt'
    # The Mesen 2 core (scripts/build_mesen.sh), GPL-3.0, with its license and source.
    assert (site/'core-mesen.wasm').read_bytes()[:4]==b'\x00asm', 'Missing or invalid core-mesen.wasm'
    assert (site/'core-mesen.js').stat().st_size>3000, 'Missing core-mesen.js'
    assert 'Version 3' in (site/'mesen-LICENSE.txt').read_text(), 'Missing Mesen license (GPL v3)'
    assert (site/'source/mesen-source.tar.gz').exists(), 'Missing Mesen source archive'
    assert 'libretro/MesenCE' in (site/'source/SOURCES.txt').read_text(), 'Mesen missing from SOURCES.txt'
print('Static verification passed. WASM build detected:',(site/'core.wasm').exists())
