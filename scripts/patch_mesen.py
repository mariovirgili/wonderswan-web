#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Small changes to Mesen 2's libretro front end (libretro/MesenCE) for the web build.

1. Battery saves: the libretro port exposes no save memory for the WonderSwan, so the page
   could not keep or export SRAM. retro_get_memory_data/size(RETRO_MEMORY_SAVE_RAM) now return
   the cartridge's SRAM or EEPROM, through Mesen's own Emulator::GetMemory().
2. Y pad: the port maps the WonderSwan's Y-left / Y-right to L / R but leaves Y-up / Y-down
   unmapped. They are mapped to R2 / L2, the buttons the page already uses for them (as with
   the Mednafen core).
3. Threads: Mesen hands work to background threads (keyboard shortcuts, video decoding and
   rendering) and waits for them. The WebAssembly build has no threads, so there those threads
   are not started and each frame is decoded on the spot, as Mesen already does in its "sync"
   mode. Native builds are unaffected (#ifdef __EMSCRIPTEN__).
4. Speed: retro_run built a new video filter for every frame, and the WonderSwan filter builds
   NTSC tables in its constructor (~80% of the time). The filter is now kept for the loaded game.
5. Screen: the WonderSwan options "LCD adjust colors" and "blend frames" were declared but never
   read; they now reach Mesen's settings, so the page can turn them on.
6. Rotation: the WonderSwan auto-rotate setting was never applied and the frame was never
   turned. Vertical games now turn by themselves (Mesen's own WsConsole rule), and Select - the
   page's Rotate key - switches to the other orientation, as with the other cores.
7. Other systems: Mesen's own defaults for the NES palette, the Game Boy model and the Master
   System, Game Gear and Super Nintendo borders, which the libretro port leaves unset. A Super Game
   Boy game (no SNES here) runs on the Game Boy, not on the GBC.

The emulation itself is not changed. The patch is idempotent.
"""
import pathlib, sys

root = pathlib.Path(sys.argv[1])
p = root / 'Libretro/libretro.cpp'
s = p.read_text()


def patch(old, new):
    global s
    if new in s:
        return
    if s.count(old) != 1:
        sys.exit(f'patch_mesen: pattern not found once in {p}: {old[:80]!r}')
    s = s.replace(old, new)


patch('''	RETRO_API void *retro_get_memory_data(unsigned id)
	{
''', '''	// WonderSwan battery save (web build): the cartridge's SRAM, else its EEPROM.
	static ConsoleMemoryInfo GetWsSaveMemory()
	{
		if(!_emu || !_console || _console->GetConsoleType() != ConsoleType::Ws) {
			return { nullptr, 0 };
		}
		ConsoleMemoryInfo ram = _emu->GetMemory(MemoryType::WsCartRam);
		if(ram.Memory && ram.Size) {
			return ram;
		}
		return _emu->GetMemory(MemoryType::WsCartEeprom);
	}

	RETRO_API void *retro_get_memory_data(unsigned id)
	{
		if(id == RETRO_MEMORY_SAVE_RAM && _console && _console->GetConsoleType() == ConsoleType::Ws) {
			return GetWsSaveMemory().Memory;
		}
''')
patch('''	RETRO_API size_t retro_get_memory_size(unsigned id)
	{
''', '''	RETRO_API size_t retro_get_memory_size(unsigned id)
	{
		if(id == RETRO_MEMORY_SAVE_RAM && _console && _console->GetConsoleType() == ConsoleType::Ws) {
			return GetWsSaveMemory().Size;
		}
''')
patch('''static int _screenRotation = 0;
''', '''static int _screenRotation = 0;
// Web build: one video filter per loaded game (it is costly to build), and the Rotate key state.
static std::unique_ptr<BaseVideoFilter> _frameFilter;
static bool _rotateFlip = false, _rotateKeyWasDown = false;
''')
patch('''				std::unique_ptr<BaseVideoFilter> filter(_emu->GetVideoFilter());
''', '''				if(!_frameFilter) {
					_frameFilter.reset(_emu->GetVideoFilter());
				}
				BaseVideoFilter* filter = _frameFilter.get();
''')
patch('''					static std::vector<uint32_t> rotBuffer;
''', '''					static std::vector<uint32_t> rotBuffer;
					// Web build: the console's own rotation (WonderSwan vertical games), and
					// Select toggles the other orientation.
					int _screenRotation = ::_screenRotation;
					{
						uint32_t rotation = (uint32_t)_screenRotation;
						_emu->GetScreenRotationOverride(rotation);
						bool rotateKey = _savedGetInputState && _savedGetInputState(0, RETRO_DEVICE_JOYPAD, 0, RETRO_DEVICE_ID_JOYPAD_SELECT);
						if(rotateKey && !_rotateKeyWasDown) {
							_rotateFlip = !_rotateFlip;
						}
						_rotateKeyWasDown = rotateKey;
						if(_rotateFlip) {
							rotation = rotation ? 0 : 270;
						}
						_screenRotation = (int)rotation;
					}
''')
patch('''	RETRO_API bool retro_load_game(const struct retro_game_info *game)
	{
''', '''	RETRO_API bool retro_load_game(const struct retro_game_info *game)
	{
		_frameFilter.reset();
		_rotateFlip = false;
''')
patch('''	RETRO_API void retro_unload_game()
	{
''', '''	RETRO_API void retro_unload_game()
	{
		_frameFilter.reset();
''')
patch('''				wsCfg.ControllerHorizontal.Type = (_inputDevices[0] == DEVICE_GAMEPAD) ? ControllerType::WsController : ControllerType::None;
''', '''				wsCfg.ControllerHorizontal.Type = (_inputDevices[0] == DEVICE_GAMEPAD) ? ControllerType::WsController : ControllerType::None;
				wsCfg.AutoRotate = true;  // web build: vertical games turn by themselves
''')
patch('''	void update_settings()
	{
		struct retro_variable var = { };
''', '''	void update_settings()
	{
		struct retro_variable var = { };
		// Web build: WonderSwan LCD colours and frame blending (Mesen's own settings, which its
		// video filter reads every frame; the port declared the options but never read them).
		if(_emu) {
			WsConfig wsCfg = _emu->GetSettings()->GetWsConfig();
			if(readVariable(MesenWsLcdAdjustColors, var)) {
				wsCfg.LcdAdjustColors = string(var.value) == "enabled";
			}
			if(readVariable(MesenWsBlendFrames, var)) {
				wsCfg.BlendFrames = string(var.value) == "enabled";
			}
			_emu->GetSettings()->SetWsConfig(wsCfg);
			// Other systems: Mesen's own defaults, which its desktop interface sets and the libretro
			// port leaves unset (an empty NES palette is all black; the Master System, Game Gear and
			// Super Nintendo pictures keep their borders).
			if(_userRgbPalette.empty()) {
				_userRgbPalette.assign(std::begin(defaultPalette), std::end(defaultPalette));
			}
			SmsConfig smsCfg = _emu->GetSettings()->GetSmsConfig();
			smsCfg.NtscOverscan = smsCfg.PalOverscan = { 0, 0, 24, 24 };
			smsCfg.GameGearOverscan = { 48, 48, 48, 48 };
			_emu->GetSettings()->SetSmsConfig(smsCfg);
			// Game Boy: Mesen's own "Auto - best" model, as its desktop interface sets it: Game Boy Color
			// games on the GBC, original Game Boy games on the Game Boy (the port's default ran them on
			// the GBC, which without its boot ROM gives them stray colours instead of the grey palette).
			GameboyConfig gbCfg = _emu->GetSettings()->GetGameboyConfig();
			gbCfg.Model = GameboyModel::AutoFavorBest;
			_emu->GetSettings()->SetGameboyConfig(gbCfg);
			SnesConfig snesCfg = _emu->GetSettings()->GetSnesConfig();
			snesCfg.Overscan = { 0, 0, 7, 8 };
			_emu->GetSettings()->SetSnesConfig(snesCfg);
		}
''')
patch('''				setupDefaultMapping(wsCfg.ControllerHorizontal.Keys, 0);
''', '''				setupDefaultMapping(wsCfg.ControllerHorizontal.Keys, 0);
				// Y pad up / down (web build): R2 / L2, as Y-left / Y-right are L / R.
				setButton(wsCfg.ControllerHorizontal.Keys.Mapping1.U, 0, RETRO_DEVICE_ID_JOYPAD_R2);
				setButton(wsCfg.ControllerHorizontal.Keys.Mapping1.D, 0, RETRO_DEVICE_ID_JOYPAD_L2);
''')
# The frame goes through the filter with the borders cropped as set above (Mesen applies no crop to
# the WonderSwan, Game Boy and GBA).
patch('''				FrameInfo outInfo = filter->SendFrame((uint16_t*)frame.FrameBuffer, _emu->GetFrameCount(), _emu->GetFrameCount() & 0x01, nullptr, false);
''', '''				FrameInfo outInfo = filter->SendFrame((uint16_t*)frame.FrameBuffer, _emu->GetFrameCount(), _emu->GetFrameCount() & 0x01, nullptr, true);
''')
p.write_text(s)


def patch_file(rel, pairs):
    global p, s
    p = root / rel
    s = p.read_text()
    for old, new in pairs:
        patch(old, new)
    p.write_text(s)


patch_file('Core/Shared/ShortcutKeyHandler.cpp', [
    ('''	_stopThread = false;
	_thread = std::thread([=]() {''', '''	_stopThread = false;
#ifndef __EMSCRIPTEN__
	_thread = std::thread([=]() {'''),
    ('''			std::this_thread::sleep_for(std::chrono::duration<int, std::milli>(50));
		}
	});
}''', '''			std::this_thread::sleep_for(std::chrono::duration<int, std::milli>(50));
		}
	});
#endif
}'''),
    ('''	_stopThread = true;
	_thread.join();''', '''	_stopThread = true;
	if(_thread.joinable()) {
		_thread.join();
	}'''),
])
patch_file('Core/Shared/Video/VideoDecoder.cpp', [
    ('''	_frame = frame;
	if(sync) {''', '''	_frame = frame;
#ifdef __EMSCRIPTEN__
	sync = true;  // no decode thread in WebAssembly
#endif
	if(sync) {'''),
    ('''		_decodeThread.reset(new thread(&VideoDecoder::DecodeThread, this));''',
     '''#ifndef __EMSCRIPTEN__
		_decodeThread.reset(new thread(&VideoDecoder::DecodeThread, this));
#endif'''),
])
patch_file('Core/Shared/Video/VideoRenderer.cpp', [
    ('''			_renderThread.reset(new std::thread(&VideoRenderer::RenderThread, this));''',
     '''#ifndef __EMSCRIPTEN__
			_renderThread.reset(new std::thread(&VideoRenderer::RenderThread, this));
#endif'''),
])
print('patch_mesen: libretro.cpp, ShortcutKeyHandler.cpp, VideoDecoder.cpp, VideoRenderer.cpp patched')
patch_file('Core/Gameboy/Gameboy.cpp', [
    ('''	if(!_allowSgb && model == GameboyModel::SuperGameboy) {
		//SGB isn't available, use gameboy color mode instead
		model = GameboyModel::GameboyColor;
	}''', '''	if(!_allowSgb && model == GameboyModel::SuperGameboy) {
#ifdef __EMSCRIPTEN__
		//Web build: SGB isn't available, so an original Game Boy game runs on the Game Boy
		model = GameboyModel::Gameboy;
#else
		//SGB isn't available, use gameboy color mode instead
		model = GameboyModel::GameboyColor;
#endif
	}'''),
])
