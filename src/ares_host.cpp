// SPDX-License-Identifier: GPL-2.0-or-later
/* Host for the ares WonderSwan core (ares is ISC-licensed).
 *
 * It exposes the same ws_* C API as bridge.c (the Beetle/Mednafen host), so the
 * page can drive either core with the same code. No emulation is done here:
 * this file only builds the cartridge "pak" from the ROM header (the same
 * rules as ares' own mia loader), forwards input, and collects video/audio.
 */
#include <ares/ares.hpp>
#include <ws/ws.hpp>
#include <cstring>
#include <cstdint>
#include <vector>

using namespace nall;
namespace Node = ares::Node;

namespace {

constexpr u32 MAX_SIDE = 512;
constexpr u32 MAX_AUDIO_FRAMES = 8192;
constexpr double SAMPLE_RATE = 48000.0;

u8 rgba[MAX_SIDE * MAX_SIDE * 4];
int16_t audioBuf[MAX_AUDIO_FRAMES * 2];
int audioFrames = 0;
int vw = 224, vh = 144;
u32 buttons = 0, previousButtons = 0;
double fps = 75.47;

// Button bit (libretro joypad ids used by the page) for each ares input name.
struct Map { const char* name; int bit; };
constexpr Map buttonMap[] = {
  {"X1", 4}, {"X2", 7}, {"X3", 5}, {"X4", 6},        // X pad: up, right, down, left
  {"Y1", 13}, {"Y2", 11}, {"Y3", 12}, {"Y4", 10},    // Y pad: up, right, down, left
  {"A", 8}, {"B", 0}, {"Start", 3},
};
constexpr int ROTATE_BIT = 2;

struct Host : ares::Platform {
  Node::System root;
  std::shared_ptr<vfs::directory> systemPak, gamePak;
  std::vector<Node::Audio::Stream> streams;
  string saveName;  // "save.ram" / "save.eeprom" / "" (none)
  std::vector<u8> state;
  int rotation = 0;  // last screen rotation reported by the core

  auto attach(Node::Object node) -> void override {
    if(auto stream = node->cast<Node::Audio::Stream>()) {
      stream->setResamplerFrequency(SAMPLE_RATE);
      streams.push_back(stream);
    }
  }
  auto detach(Node::Object node) -> void override {
    if(auto stream = node->cast<Node::Audio::Stream>()) std::erase(streams, stream);
  }
  auto pak(Node::Object node) -> std::shared_ptr<vfs::directory> override {
    if(node->name().endsWith("Cartridge")) return gamePak;
    return systemPak;
  }
  auto refreshRateHint(double rate) -> void override {
    if(rate > 30 && rate < 200) fps = rate;
  }
  auto video(Node::Video::Screen screen, const u32* data, u32 pitch, u32 width, u32 height) -> void override {
    rotation = screen->rotation();
    if(!data || !width || !height || width > MAX_SIDE || height > MAX_SIDE) return;
    pitch /= sizeof(u32);
    // ares draws the LCD's status icons in an extra strip beside the picture
    // (right on the Color, below on the mono model). Show only the 224x144
    // picture, like the Mednafen core. The frame arrives already rotated
    // (90 degrees left), which moves the strip to the top.
    u32 x0 = 0, y0 = 0;
    if(rotation == 90 && width >= 144 && height >= 224) { y0 = height - 224; width = 144; height = 224; }
    else if(rotation == 0 && width >= 224 && height >= 144) { width = 224; height = 144; }
    data += y0 * pitch + x0;
    vw = width; vh = height;
    for(u32 y = 0; y < height; y++) {
      const u32* src = data + y * pitch;
      u8* dst = rgba + y * width * 4;
      for(u32 x = 0; x < width; x++) {
        u32 c = src[x];
        dst[0] = c >> 16; dst[1] = c >> 8; dst[2] = c; dst[3] = 255;
        dst += 4;
      }
    }
  }
  auto audio(Node::Audio::Stream) -> void override {
    while(true) {
      for(auto& stream : streams) if(!stream->pending()) return;
      double mix[2] = {0.0, 0.0};
      for(auto& stream : streams) {
        double buffer[2] = {0.0, 0.0};
        u32 channels = stream->read(buffer);
        mix[0] += buffer[0];
        mix[1] += channels == 1 ? buffer[0] : buffer[1];
      }
      if(audioFrames >= (int)MAX_AUDIO_FRAMES) continue;
      for(int c = 0; c < 2; c++) {
        double v = mix[c] < -1.0 ? -1.0 : mix[c] > 1.0 ? 1.0 : mix[c];
        audioBuf[audioFrames * 2 + c] = (int16_t)(v * 32767.0);
      }
      audioFrames++;
    }
  }
  auto input(Node::Input::Input node) -> void override {
    auto button = node->cast<Node::Input::Button>();
    if(!button) return;
    for(auto& m : buttonMap) {
      if(node->name() == m.name) { button->setValue((buttons >> m.bit) & 1); return; }
    }
    button->setValue(0);
  }
};

Host host;
bool started = false, loaded = false;
u8 romFlags = 0;  // footer byte 12: orientation, ROM bus width, ROM speed

// Build the cartridge pak from the ROM footer, as ares' mia/medium/wonderswan.cpp does.
auto makeGamePak(const u8* rom, size_t size, bool& color) -> std::shared_ptr<vfs::directory> {
  if(size < 0x10000) return {};
  const u8* meta = rom + size - 16;
  color = meta[7] != 0;
  string ramType; u32 ramSize = 0;
  switch(meta[11]) {
  case 0x01: case 0x02: ramType = "RAM"; ramSize = 32 * 1024; break;
  case 0x03: ramType = "RAM"; ramSize = 128 * 1024; break;
  case 0x04: ramType = "RAM"; ramSize = 256 * 1024; break;
  case 0x05: ramType = "RAM"; ramSize = 512 * 1024; break;
  case 0x10: ramType = "EEPROM"; ramSize = 128; break;
  case 0x20: ramType = "EEPROM"; ramSize = 2048; break;
  case 0x50: ramType = "EEPROM"; ramSize = 1024; break;
  }
  romFlags = meta[12];
  bool vertical = meta[12] & 1, wide = meta[12] & 4, rtc = meta[13] == 1;
  bool wonderWitch = size == 0x80000 && !memcmp(rom + 0x70000, "ELISA", 5)
    && rom[0x7fff6] == 0x00 && rom[0x7fff8] == 0x00 && rom[0x7fffb] == 0x04 && rom[0x7fffd] == 0x01;

  auto pak = std::make_shared<vfs::directory>();
  pak->setAttribute("title", "WonderSwan cartridge");
  pak->setAttribute("orientation", vertical ? "vertical" : "horizontal");
  pak->setAttribute("board", rom[size - 3] >= 0x01 ? "2003" : "2001");
  pak->setAttribute("width", wide ? "16" : "8");
  pak->append(wonderWitch ? "program.flash" : "program.rom", std::span<const u8>{rom, size});
  host.saveName = "";
  if(ramSize) {
    host.saveName = ramType == "RAM" ? "save.ram" : "save.eeprom";
    pak->append(host.saveName, ramSize);
    if(auto fp = pak->write(host.saveName)) memset(fp->data(), 0xff, fp->size());
  }
  if(rtc) pak->append("time.rtc", 18);
  return pak;
}

// Without a boot ROM (it is copyrighted, so none is shipped) ares starts the
// cartridge straight from reset. Set the few things the boot ROM leaves on
// before it jumps to the game: LCD on, cartridge mapped with the bus width and
// speed from the ROM footer, sound output enabled, the orientation icon (which
// ares uses to rotate the screen of vertical games), and the stack where the
// boot ROM leaves it.
auto postBoot() -> void {
  using namespace ares::WonderSwan;
  bus.writeIO(0x0014, 0x01);  // LCD_CTRL: display on
  bus.writeIO(0x00a0, 0x01 | (romFlags & 0x0c));  // HW_FLAGS: boot ROM out, ROM width/wait
  bus.writeIO(0x0091, 0x0f);  // SND_OUTPUT: speaker and headphone output on
  bus.writeIO(0x0015, romFlags & 1 ? 0x02 : 0x04);  // LCD_ICON: orientation from the footer
  cpu.SS = 0x0000;
  cpu.SP = 0x2000;
}

}  // namespace

/* Screen options: ares imitates the WonderSwan LCD with two settings of its PPU screen, on by
 * default in ares - colour emulation (the LCD's colour response) and interframe blending (each
 * frame mixed with the previous one, as the slow LCD did). Kept here and applied after each load. */
namespace { bool colorEmulation = true, interframeBlending = true; }
static void applyScreenOptions() {
  if(!loaded) return;
  if(auto s = host.root->find<Node::Setting::Boolean>("PPU/Screen/Color Emulation")) s->setValue(colorEmulation);
  if(auto s = host.root->find<Node::Setting::Boolean>("PPU/Screen/Interframe Blending")) s->setValue(interframeBlending);
}

extern "C" {

int ws_init(void) {
  if(!started) { ares::platform = &host; started = true; }
  return 1;
}

void ws_unload(void) {
  if(loaded) { host.root->unload(); host.root.reset(); loaded = false; }
  host.streams.clear();
  host.gamePak.reset();
}

int ws_load(const void* data, size_t size) {
  if(!started || !data || size < 1024 || size > 64u * 1024u * 1024u) return 0;
  ws_unload();
  bool color = false;
  host.gamePak = makeGamePak((const u8*)data, size, color);
  if(!host.gamePak) return 0;
  host.systemPak = std::make_shared<vfs::directory>();  // no boot ROM: the cartridge starts directly
  ares::WonderSwan::option("Pixel Accuracy", "false");
  if(!ares::WonderSwan::load(host.root, color ? "[Bandai] WonderSwan Color" : "[Bandai] WonderSwan")) return 0;
  if(auto port = host.root->find<Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  } else { ws_unload(); return 0; }
  host.root->power();
  postBoot();
  loaded = true;
  applyScreenOptions();
  audioFrames = 0;
  return 1;
}

void ws_run(void) {
  if(!loaded) return;
  audioFrames = 0;
  // Rotate: each press switches between the core's automatic orientation and the other one.
  if((buttons >> ROTATE_BIT & 1) && !(previousButtons >> ROTATE_BIT & 1)) {
    if(auto o = host.root->find<Node::Setting::String>("PPU/Screen/Orientation")) {
      if(o->value() == "Automatic") o->setValue(host.rotation ? "Horizontal" : "Vertical");
      else o->setValue("Automatic");
    }
  }
  previousButtons = buttons;
  host.root->run();
}

void ws_set_input(uint32_t mask) { buttons = mask; }
int ws_get_width(void) { return vw; }
int ws_get_height(void) { return vh; }
const uint8_t* ws_get_video(void) { return rgba; }
const int16_t* ws_get_audio(void) { return audioBuf; }
int ws_get_audio_frames(void) { return audioFrames; }
double ws_get_fps(void) { return fps; }
double ws_get_sample_rate(void) { return SAMPLE_RATE; }
void ws_reset(void) { if(loaded) { host.root->power(true); postBoot(); } }

size_t ws_get_save_size(void) {
  if(!loaded || !host.saveName) return 0;
  auto fp = host.gamePak->read(host.saveName);
  return fp ? fp->size() : 0;
}
const void* ws_get_save(void) {
  if(!loaded || !host.saveName) return nullptr;
  host.root->save();  // copies the cartridge's RAM/EEPROM into the pak
  auto fp = host.gamePak->read(host.saveName);
  return fp ? fp->data() : nullptr;
}
int ws_set_save(const void* buffer, size_t size) {
  if(!loaded || !buffer || !host.saveName) return 0;
  auto fp = host.gamePak->write(host.saveName);
  if(!fp || fp->size() != size) return 0;
  memcpy(fp->data(), buffer, size);
  // Reconnect the cartridge so it reads the new save, then restart.
  if(auto port = host.root->find<Node::Port>("Cartridge Slot")) {
    port->disconnect();
    memcpy(host.gamePak->write(host.saveName)->data(), buffer, size);  // disconnect() saved over it
    port->allocate();
    port->connect();
  }
  host.root->power();
  postBoot();
  return 1;
}

/* Saving a state first runs every emulated chip to a safe point, which switches
 * cothreads. In WebAssembly that only works inside a function that returns
 * nothing (Asyncify), so the page calls ws_prepare_state() first and then
 * reads the prepared state with ws_get_state_size() / ws_save_state(). */
void ws_prepare_state(void) {
  host.state.clear();
  if(!loaded) return;
  auto s = host.root->serialize(true);
  host.state.assign(s.data(), s.data() + s.size());
}
size_t ws_get_state_size(void) { return loaded ? host.state.size() : 0; }
int ws_save_state(void* ptr, size_t n) {
  if(!loaded || !ptr || host.state.empty() || n < host.state.size()) return 0;
  memcpy(ptr, host.state.data(), host.state.size());
  return 1;
}
int ws_load_state(const void* ptr, size_t n) {
  if(!loaded || !ptr || !n) return 0;
  serializer s((const u8*)ptr, (u32)n);
  return host.root->unserialize(s) ? 1 : 0;
}

/* Options: ares_color_emulation / ares_interframe_blending ("enabled" / "disabled") and
 * ares_pixel_accuracy. Others (e.g. Beetle's wswan_60hz_mode) are accepted and ignored. */
int ws_set_option(const char* key, const char* value) {
  if(!key || !*key) return 0;
  bool on = value && !strcmp(value, "enabled");
  if(!strcmp(key, "ares_color_emulation")) { colorEmulation = on; applyScreenOptions(); return 1; }
  if(!strcmp(key, "ares_interframe_blending")) { interframeBlending = on; applyScreenOptions(); return 1; }
  if(!strcmp(key, "ares_pixel_accuracy")) {
    ares::WonderSwan::option("Pixel Accuracy", value && !strcmp(value, "enabled") ? "true" : "false");
    return 1;
  }
  return 1;  // unknown options (e.g. Beetle's wswan_60hz_mode) are ignored
}

void ws_shutdown(void) { ws_unload(); }

}  // extern "C"
