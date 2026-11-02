/* Subset of the public libretro ABI used by the WonderSwan web bridge.
   Source API: https://github.com/libretro/libretro-common/blob/master/include/libretro.h */
#ifndef LIBRETRO_MIN_H
#define LIBRETRO_MIN_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef bool (*retro_environment_t)(unsigned, void *);
typedef void (*retro_video_refresh_t)(const void *, unsigned, unsigned, size_t);
typedef void (*retro_audio_sample_t)(int16_t, int16_t);
typedef size_t (*retro_audio_sample_batch_t)(const int16_t *, size_t);
typedef void (*retro_input_poll_t)(void);
typedef int16_t (*retro_input_state_t)(unsigned, unsigned, unsigned, unsigned);

struct retro_system_info {
  const char *library_name, *library_version, *valid_extensions;
  bool need_fullpath, block_extract;
};
struct retro_game_info { const char *path; const void *data; size_t size; const char *meta; };
struct retro_game_geometry { unsigned base_width, base_height, max_width, max_height; float aspect_ratio; };
struct retro_system_timing { double fps, sample_rate; };
struct retro_system_av_info { struct retro_game_geometry geometry; struct retro_system_timing timing; };
struct retro_variable { const char *key, *value; };

enum { RETRO_DEVICE_JOYPAD=1, RETRO_MEMORY_SAVE_RAM=0 };
enum { RETRO_ENVIRONMENT_SET_ROTATION=1, RETRO_ENVIRONMENT_GET_CAN_DUPE=3,
  RETRO_ENVIRONMENT_SET_PIXEL_FORMAT=10, RETRO_ENVIRONMENT_GET_VARIABLE=15,
  RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE=17, RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY=9,
  RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY=31, RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO=32, RETRO_ENVIRONMENT_SET_GEOMETRY=37,
  RETRO_ENVIRONMENT_GET_LANGUAGE=39, RETRO_ENVIRONMENT_GET_INPUT_BITMASKS=51 };
enum { RETRO_PIXEL_FORMAT_0RGB1555=0, RETRO_PIXEL_FORMAT_XRGB8888=1, RETRO_PIXEL_FORMAT_RGB565=2 };

void retro_set_environment(retro_environment_t cb);
void retro_set_video_refresh(retro_video_refresh_t cb);
void retro_set_audio_sample(retro_audio_sample_t cb);
void retro_set_audio_sample_batch(retro_audio_sample_batch_t cb);
void retro_set_input_poll(retro_input_poll_t cb);
void retro_set_input_state(retro_input_state_t cb);
void retro_init(void);
void retro_deinit(void);
void retro_get_system_info(struct retro_system_info *);
void retro_get_system_av_info(struct retro_system_av_info *);
bool retro_load_game(const struct retro_game_info *);
void retro_unload_game(void);
void retro_run(void);
void retro_reset(void);
size_t retro_serialize_size(void);
bool retro_serialize(void*,size_t);
bool retro_unserialize(const void*,size_t);
void *retro_get_memory_data(unsigned);
size_t retro_get_memory_size(unsigned);
#endif
