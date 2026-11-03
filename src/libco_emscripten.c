/* SPDX-License-Identifier: ISC
 * libco backend for WebAssembly, built on Emscripten fibers (Asyncify).
 *
 * WebAssembly has no way to switch stacks directly, so each cothread gets its
 * own C stack plus an Asyncify buffer, and emscripten_fiber_swap() unwinds the
 * running cothread and rewinds the next one. The program must be linked with
 * -sASYNCIFY. Implements the libco API used by ares (libco/libco.h).
 */
#include <emscripten/fiber.h>
#include <stdlib.h>
#include <string.h>
#include "libco.h"

#define ASYNCIFY_STACK_SIZE (64 * 1024)

typedef struct {
  emscripten_fiber_t fiber;
  void (*entry)(void);
  void *c_stack;
  unsigned int c_stack_size;
  void *asyncify_stack;
} co_fiber;

static co_fiber co_primary;
static unsigned char co_primary_asyncify[ASYNCIFY_STACK_SIZE] __attribute__((aligned(16)));
static co_fiber *co_running = NULL;

static void co_trampoline(void *argument) {
  co_fiber *self = (co_fiber *)argument;
  self->entry();
  abort(); /* a cothread must never return */
}

cothread_t co_active(void) {
  if(!co_running) {
    emscripten_fiber_init_from_current_context(&co_primary.fiber, co_primary_asyncify, sizeof co_primary_asyncify);
    co_running = &co_primary;
  }
  return co_running;
}

/* Restart an existing cothread (made by co_create) at a new entry point. */
cothread_t co_derive(void *memory, unsigned int size, void (*entry)(void)) {
  co_fiber *self = (co_fiber *)memory;
  (void)size;
  if(!self || !self->c_stack) return NULL;
  co_active();
  self->entry = entry;
  emscripten_fiber_init(&self->fiber, co_trampoline, self, self->c_stack, self->c_stack_size,
                        self->asyncify_stack, ASYNCIFY_STACK_SIZE);
  return self;
}

cothread_t co_create(unsigned int size, void (*entry)(void)) {
  co_fiber *self = (co_fiber *)calloc(1, sizeof *self);
  if(!self) return NULL;
  size = (size + 15u) & ~15u;
  self->c_stack = aligned_alloc(16, size);
  self->c_stack_size = size;
  self->asyncify_stack = aligned_alloc(16, ASYNCIFY_STACK_SIZE);
  if(!self->c_stack || !self->asyncify_stack) {
    free(self->c_stack);
    free(self->asyncify_stack);
    free(self);
    return NULL;
  }
  return co_derive(self, size, entry);
}

void co_delete(cothread_t handle) {
  co_fiber *self = (co_fiber *)handle;
  if(!self || self == &co_primary || self == co_running) return;
  free(self->c_stack);
  free(self->asyncify_stack);
  free(self);
}

void co_switch(cothread_t handle) {
  co_fiber *from = (co_fiber *)co_active();
  co_fiber *to = (co_fiber *)handle;
  if(to == from) return;
  co_running = to;
  emscripten_fiber_swap(&from->fiber, &to->fiber);
}

int co_serializable(void) {
  return 0;
}
