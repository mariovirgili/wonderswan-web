#!/usr/bin/env python3
"""Static package checks; optional WASM header checks after build."""
import pathlib, sys, re
root=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else pathlib.Path(__file__).resolve().parents[1]);site=root/'site'
for name in ('index.html','app.js','style.css','patches.js','archive.js'):
    assert (site/name).is_file(), f'Missing: {name}'
html=(site/'index.html').read_text(); js=(site/'app.js').read_text(); bridge=(root/'src/bridge.c').read_text()
for suffix in ('.ws','.wsc','.pc2'): assert suffix in html, suffix
for func in ('ws_init','ws_load','ws_run','ws_get_video','ws_get_audio','ws_set_input','ws_get_save','ws_save_state'):
    assert re.search(r'\b'+func+r'\b',bridge),func
    assert func in js or func.replace('ws_','') in js,func
for name in ('core.js','core.wasm'):
    path=site/name
    if path.exists(): assert path.stat().st_size>3000, f'Empty output: {path}'
if (site/'core.wasm').exists():
    assert (site/'core.wasm').read_bytes()[:4]==b'\x00asm', 'Invalid WASM magic'
    assert (site/'COPYING').exists(), 'Missing GPL license'
    assert (site/'source/beetle-wswan-source.tar.gz').exists(), 'Missing corresponding source'
    for f in ('7zz.umd.js','7zz.wasm','License.txt'):
        assert (site/'vendor/7z'/f).exists(), f'Missing 7-Zip file: {f}'
    assert (site/'vendor/7z/7zz.wasm').read_bytes()[:4]==b'\x00asm', 'Invalid 7-Zip WASM'
print('Static verification passed. WASM build detected:',(site/'core.wasm').exists())
