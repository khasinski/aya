#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <sys/wait.h>
#include <unistd.h>
static int probe_fault;
static int stop_probe(idtype_t kind, id_t pid, siginfo_t *info, int options) {
  if (probe_fault) { int fault = probe_fault; probe_fault = 0; errno = fault; return -1; }
  return waitid(kind, pid, info, options);
}
#define waitid stop_probe
#define main owner_program_main
#include "../../electron/native/pty-owner/owner.c"
#undef main
#undef waitid
static void rejected_stop(pid_t pid, int fault, int ended) {
  int sockets[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
  clients[0] = (Client){ .fd = sockets[0], .authenticated = 1 }; active = -1;
  panes[0] = (Pane){ .pid = pid, .generation = 1, .fd = -1 }; strcpy(panes[0].id, "ended");
  Writer payload = {0}; put_string(&payload, "ended"); put32(&payload, 1); put32(&payload, SIGHUP);
  probe_fault = fault;
  handle_frame(0, OWNER_KILL, 7, payload.data, payload.size);
  unsigned char header[OWNER_HEADER]; assert(read(sockets[1], header, sizeof(header)) == sizeof(header));
  uint16_t type; memcpy(&type, header + 6, 2); assert(ntohs(type) == OWNER_ERROR);
  assert(panes[0].kill_deadline == 0);
  if (ended) { assert(panes[0].exited && WIFEXITED(panes[0].status) && WEXITSTATUS(panes[0].status) == 23); assert(!panes[0].acknowledged); }
  else assert(!panes[0].exited);
  close(sockets[0]); close(sockets[1]);
}
int main(void) {
  pid_t child = fork(); assert(child >= 0); if (!child) _exit(23);
  siginfo_t info = {0}; assert(waitid(P_PID, (id_t)child, &info, WEXITED | WNOWAIT) == 0 && info.si_pid == child);
  // The kernel has completed the child, but the owner record has not observed
  // SIGCHLD. Dispatch the real KILL handler before the normal reap pass.
  rejected_stop(child, EINTR, 1);
  assert(waitpid(child, NULL, WNOHANG) == -1 && errno == ECHILD);
  child = fork(); assert(child >= 0); if (!child) { for (;;) pause(); }
  rejected_stop(child, ECHILD, 0); // Unknown identity/status stays fail-closed.
  assert(kill(child, SIGKILL) == 0); assert(waitpid(child, NULL, 0) == child);
  return 0;
}
