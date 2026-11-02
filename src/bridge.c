/* Copyright (c) 2026. GPL-2.0-only, because this bridge links to
 * Beetle WonderSwan (Mednafen core). No emulator routines are reimplemented.
 * This file is distributed with the project source. */
#include "libretro_min.h"
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define MAX_SIDE 512
#define MAX_AUDIO_FRAMES 8192
static uint8_t rgba[MAX_SIDE * MAX_SIDE * 4];
static int16_t audio[MAX_AUDIO_FRAMES * 2];
static int audio_frames, w=224, h=144, fmt=RETRO_PIXEL_FORMAT_0RGB1555;
static uint32_t buttons;
static double fps=75.47, sample_rate=44100.0;
static bool started, loaded;
static uint8_t *loaded_rom;

/* Core options (libretro variables) set from JavaScript. Keys not set here
 * fall back to the core's own defaults. */
#define MAX_OPTS 32
#define OPT_LEN 64
static struct { char key[OPT_LEN], value[OPT_LEN]; } opts[MAX_OPTS];
static int n_opts;
static bool opts_dirty;

static void apply_av(const struct retro_system_av_info *av) {
  if(av->timing.fps>30 && av->timing.fps<200) fps=av->timing.fps;
  if(av->timing.sample_rate>8000 && av->timing.sample_rate<192001) sample_rate=av->timing.sample_rate;
}

static bool environment(unsigned cmd,void *data) {
  switch(cmd) {
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
      if (!data) return false;
      if (*(const int *)data < 0 || *(const int *)data > 2) return false;
      fmt=*(const int *)data;
      return true;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
      if(data) *(bool *)data=true;
      return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
      if(data) *(bool *)data=opts_dirty;
      opts_dirty=false;
      return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
      struct retro_variable *v=(struct retro_variable *)data;
      if(!v || !v->key) return false;
      for(int i=0;i<n_opts;i++)
        if(!strcmp(opts[i].key,v->key)) { v->value=opts[i].value; return true; }
      v->value=NULL;
      return false; /* unset: the core's own default applies */
    }
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
      if(data) apply_av((const struct retro_system_av_info *)data);
      return true;
    case RETRO_ENVIRONMENT_GET_LANGUAGE:
      if(data) *(unsigned*)data=0; /* English */
      return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
      return true;
    case RETRO_ENVIRONMENT_SET_ROTATION:
      /* The core's manual rotation mode uses software rotation. */
      return false;
    default:
      return false; /* unsupported optional extensions */
  }
}
static void video(const void *data,unsigned width,unsigned height,size_t pitch) {
  if(!data || !width || !height || width>MAX_SIDE || height>MAX_SIDE) return;
  const uint8_t *src=(const uint8_t*)data;
  int bytes=fmt==RETRO_PIXEL_FORMAT_XRGB8888?4:2;
  if (pitch < width*(size_t)bytes) return;
  w=(int)width; h=(int)height;
  for(unsigned y=0;y<height;y++) {
    for(unsigned x=0;x<width;x++) {
      unsigned r,g,b; const uint8_t *p=src+y*pitch+x*bytes;
      if(fmt==RETRO_PIXEL_FORMAT_XRGB8888) {
        uint32_t c; memcpy(&c,p,4);
        r=(c>>16)&255;g=(c>>8)&255;b=c&255;
      } else {
        uint16_t c;memcpy(&c,p,2);
        if(fmt==RETRO_PIXEL_FORMAT_RGB565) {
          r=(c>>11)&31;g=(c>>5)&63;b=c&31;
          r=(r<<3)|(r>>2);g=(g<<2)|(g>>4);b=(b<<3)|(b>>2);
        } else { /* 0RGB1555 */
          r=(c>>10)&31;g=(c>>5)&31;b=c&31;
          r=(r<<3)|(r>>2);g=(g<<3)|(g>>2);b=(b<<3)|(b>>2);
        }
      }
      size_t off=(y*width+x)*4;
      rgba[off]=(uint8_t)r;rgba[off+1]=(uint8_t)g;rgba[off+2]=(uint8_t)b;rgba[off+3]=255;
    }
  }
}
static void audio_one(int16_t l,int16_t r) {
  if(audio_frames>=MAX_AUDIO_FRAMES) return;
  audio[audio_frames*2]=l;
  audio[audio_frames*2+1]=r;
  audio_frames++;
}
static size_t audio_batch(const int16_t *data,size_t n) {
  if(!data) return n;
  size_t take=n;
  if(take>(size_t)(MAX_AUDIO_FRAMES-audio_frames))
    take=(size_t)(MAX_AUDIO_FRAMES-audio_frames);
  memcpy(audio+audio_frames*2,data,take*2*sizeof(int16_t));
  audio_frames+=(int)take;
  return n;
}
static void poll_input(void) {}
static int16_t input(unsigned port,unsigned device,unsigned index,unsigned id) {
  if(port || device!=RETRO_DEVICE_JOYPAD || index || id>=32) return 0;
  return (buttons>>id)&1;
}
int ws_init(void) {
  if(started) return 1;
  retro_set_environment(environment);
  retro_set_video_refresh(video);
  retro_set_audio_sample(audio_one);
  retro_set_audio_sample_batch(audio_batch);
  retro_set_input_poll(poll_input);
  retro_set_input_state(input);
  retro_init(); started=true;
  return 1;
}
void ws_unload(void) {
  if(loaded) {retro_unload_game();loaded=false;}
  free(loaded_rom); loaded_rom=NULL;
}
int ws_load(const void *data,size_t size) {
  if(!started || !data || size<1024 || size>64u*1024u*1024u) return 0;
  ws_unload();
  loaded_rom=(uint8_t*)malloc(size);
  if(!loaded_rom) return 0;
  memcpy(loaded_rom,data,size);
  struct retro_game_info gi={"memory.wsc",loaded_rom,size,NULL};
  if(!retro_load_game(&gi)) {free(loaded_rom);loaded_rom=NULL;return 0;}
  loaded=true;
  struct retro_system_av_info av;
  memset(&av,0,sizeof(av));retro_get_system_av_info(&av);
  apply_av(&av);
  audio_frames=0;
  return 1;
}
void ws_run(void) {if(loaded){audio_frames=0;retro_run();}}
void ws_set_input(uint32_t mask){buttons=mask;}
int ws_get_width(void){return w;}
int ws_get_height(void){return h;}
const uint8_t *ws_get_video(void){return rgba;}
const int16_t *ws_get_audio(void){return audio;}
int ws_get_audio_frames(void){return audio_frames;}
double ws_get_fps(void){return fps;}
double ws_get_sample_rate(void){return sample_rate;}
void ws_reset(void){if(loaded) retro_reset();}
size_t ws_get_save_size(void){return loaded?retro_get_memory_size(RETRO_MEMORY_SAVE_RAM):0;}
const void *ws_get_save(void){return loaded?retro_get_memory_data(RETRO_MEMORY_SAVE_RAM):NULL;}
int ws_set_save(const void *buffer,size_t size) {
  size_t real=ws_get_save_size();void *dest=loaded?retro_get_memory_data(RETRO_MEMORY_SAVE_RAM):NULL;
  if(!dest || !buffer || !real || size!=real) return 0;
  memcpy(dest,buffer,real);return 1;
}
size_t ws_get_state_size(void){return loaded?retro_serialize_size():0;}
int ws_save_state(void *ptr,size_t n){return loaded&&ptr&&retro_serialize(ptr,n);}
int ws_load_state(const void *ptr,size_t n){return loaded&&ptr&&retro_unserialize(ptr,n);}
/* Set (or, with an empty/NULL value, clear) a core option. Options read only
 * at content load (e.g. owner profile) take effect on the next ws_load. */
int ws_set_option(const char *key,const char *value) {
  if(!key || !*key || strlen(key)>=OPT_LEN || (value && strlen(value)>=OPT_LEN)) return 0;
  int i;
  for(i=0;i<n_opts;i++) if(!strcmp(opts[i].key,key)) break;
  if(!value || !*value) {
    if(i<n_opts) { opts[i]=opts[--n_opts]; opts_dirty=true; }
    return 1;
  }
  if(i==n_opts) { if(n_opts>=MAX_OPTS) return 0; strcpy(opts[n_opts++].key,key); }
  strcpy(opts[i].value,value);
  opts_dirty=true;
  return 1;
}
void ws_shutdown(void){ws_unload();if(started){retro_deinit();started=false;}}
