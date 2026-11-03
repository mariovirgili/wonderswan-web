// SPDX-License-Identifier: GPL-2.0-only
/* The few nall library functions the ares WonderSwan core links against but
 * never uses in this build: the GDB remote-debugging server (TCP sockets), x86
 * CPU feature detection and thread naming. In the browser there is no socket
 * server, no CPUID and no named thread, so these are inert. Everything else of nall is header-only. */
#include <nall/nall.hpp>
#include <nall/tcptext/tcptext-server.hpp>
#include <nall/instruction-set.hpp>

namespace nall::TCP {
auto Socket::close(bool) -> void {}
auto Socket::disconnectClient() -> void {}
auto Socket::getURL(u32, bool) const -> string { return {}; }
auto Socket::update() -> void {}
}

namespace nall::TCPText {
auto Server::onData(const std::vector<u8>&) -> void {}
auto Server::sendText(const string&) -> void {}
}

namespace nall {
instruction_set::information::information() {}
}

#if defined(__EMSCRIPTEN__)
#include <pthread.h>
// nall names its threads; single-threaded Emscripten has no such call (and ares runs no threads here).
extern "C" int pthread_setname_np(pthread_t, const char*) { return 0; }
#endif
