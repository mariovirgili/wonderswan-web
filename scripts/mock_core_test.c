/* Fake libretro module, for testing the frontend ABI bridge without emulator ROMs. */
#include "../src/libretro_min.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
static retro_environment_t env;
static retro_video_refresh_t vid;
static retro_audio_sample_batch_t aud;
static retro_input_state_t inp;
static uint8_t ram[16];
static int loaded=0, run_calls=0;
void retro_set_environment(retro_environment_t cb){env=cb;}
void retro_set_video_refresh(retro_video_refresh_t cb){vid=cb;}
void retro_set_audio_sample(retro_audio_sample_t cb){(void)cb;}
void retro_set_audio_sample_batch(retro_audio_sample_batch_t cb){aud=cb;}
void retro_set_input_poll(retro_input_poll_t cb){(void)cb;}
void retro_set_input_state(retro_input_state_t cb){inp=cb;}
void retro_init(void){}
void retro_deinit(void){}
void retro_get_system_info(struct retro_system_info *i){memset(i,0,sizeof(*i));}
void retro_get_system_av_info(struct retro_system_av_info *a){memset(a,0,sizeof(*a));a->timing.fps=75.0;a->timing.sample_rate=48000.0;}
bool retro_load_game(const struct retro_game_info *g){assert(g->size==2048);assert(g->data);loaded=1;return true;}
void retro_unload_game(void){loaded=0;}
void retro_run(void){assert(loaded);run_calls++;
  /* 0RGB1555: 0x7c00 pure red, 0x03e0 green */
  static uint16_t pixels[2]={0x7c00,0x03e0};
  static int16_t audio[4]={32767,-32768,101,-202};
  vid(pixels,2,1,4); aud(audio,2);
}
void retro_reset(void){}
size_t retro_serialize_size(void){return 3;}
bool retro_serialize(void *p,size_t n){if(n!=3)return false;memcpy(p,"FOO",3);return true;}
bool retro_unserialize(const void*p,size_t n){return n==3 && !memcmp(p,"FOO",3);}
void *retro_get_memory_data(unsigned t){return t==0?ram:NULL;}
size_t retro_get_memory_size(unsigned t){return t==0?sizeof(ram):0;}
int ws_init(void);
int ws_load(const void*,size_t);
void ws_run(void);
void ws_unload(void);
void ws_set_input(uint32_t);
int ws_get_width(void), ws_get_height(void),ws_get_audio_frames(void);
const uint8_t* ws_get_video(void);
const int16_t *ws_get_audio(void);
double ws_get_fps(void),ws_get_sample_rate(void);
size_t ws_get_save_size(void),ws_get_state_size(void);
const void* ws_get_save(void);
int ws_set_save(const void*,size_t),ws_save_state(void*,size_t),ws_load_state(const void*,size_t);
void ws_shutdown(void);
int main(void){
  assert(ws_init());
  int format=0;
  assert(env(10,&format));
  uint8_t rom[2048]={0};assert(ws_load(rom,sizeof(rom)));
  assert(ws_get_fps()==75.0 && ws_get_sample_rate()==48000.0);
  ws_set_input((1u<<8)|(1u<<13));
  assert(inp(0,1,0,8)==1 && inp(0,1,0,13)==1 && inp(0,1,0,2)==0);
  ws_run();
  const uint8_t *p=ws_get_video();
  assert(ws_get_width()==2 && ws_get_height()==1);
  assert(p[0]==255 && p[1]==0 && p[2]==0 && p[3]==255);
  assert(p[4]==0 && p[5]==255 && p[6]==0 && p[7]==255);
  assert(ws_get_audio_frames()==2 && ws_get_audio()[0]==32767 && ws_get_audio()[1]==-32768);
  uint8_t v[16]; memset(v,42,16);
  assert(ws_get_save_size()==16 && ws_set_save(v,16) && ((const uint8_t *)ws_get_save())[4]==42);
  assert(ws_get_state_size()==3);
  char state[3];assert(ws_save_state(state,3) && ws_load_state(state,3));
  format=2;assert(env(10,&format));
  ws_run(); /* Mock buffer is 1555: test runtime returns a valid frame. */
  ws_unload(); ws_shutdown();
  assert(!loaded && run_calls==2);
  puts("Mock core ABI and video/audio/input/save tests passed");
}
