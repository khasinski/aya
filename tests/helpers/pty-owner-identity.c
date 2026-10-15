#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#define main owner_program_main
#include "../../electron/native/pty-owner/owner.c"
#undef main
static int unknown(pid_t pid, ProcessIdentity *out) { (void)pid; (void)out; return -1; }
static int absent(pid_t pid, ProcessIdentity *out) { (void)pid; (void)out; return 0; }
int main(void) {
  ProcessIdentity live;
  assert(process_identity(getpid(), &live) == 1);
  assert(process_lease_blocks(&live, process_identity) == 1);
  // Deterministic PID reuse: the old recorded instance has the exact PID of
  // a live unrelated process, but its start identity differs. kill(pid,0)
  // would incorrectly block it; the production lease guard must release it.
  ProcessIdentity recycled = live; recycled.start--;
  assert(process_lease_blocks(&recycled, process_identity) == 0);
  recycled = live; recycled.fraction++;
  assert(process_lease_blocks(&recycled, process_identity) == 0);
  assert(process_lease_blocks(&live, unknown) == 1);
  assert(process_lease_blocks(&live, absent) == 0);
  ProcessIdentity missing;
  assert(process_identity(INT_MAX, &missing) == 0);
  assert(process_lease_blocks(&(ProcessIdentity){0}, unknown) == 0);
  // Exercise HELLO itself, not only the identity comparator: a stale lease
  // whose PID now names this process must allow a valid replacement reader.
  int sockets[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
  lease = live; lease.start--; active = -1;
  clients[0] = (Client){ .fd = sockets[0], .pid = live.pid, .identity = live };
  handle_frame(0, OWNER_HELLO, 1, token, sizeof(token));
  assert(active == 0 && clients[0].authenticated == 1);
  close(sockets[0]); close(sockets[1]);
  return 0;
}
