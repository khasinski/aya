#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "../../electron/native/pty-owner/process-identity.h"
static int scenario, probes, signals, opened, closed_fd, expected_signal;
static int probe(pid_t pid, ProcessIdentity *out) {
  probes++;
  if (probes == 2 && scenario == 1) return 0;
  *out = (ProcessIdentity){ pid, probes == 2 && scenario == 2 ? 101 : 100, 0 }; return 1;
}
static pid_t group_of(pid_t pid) { return pid; }
#ifdef __APPLE__
static int signal_one(pid_t pid, int signal) { assert(pid == 700 && signal == expected_signal); signals++; return 0; }
#define RECOVERY_SIGNAL signal_one
#else
#include <sys/syscall.h>
#include <stdarg.h>
static long system_call(long number, ...) {
  va_list args; va_start(args, number);
  if (number == SYS_pidfd_open) { assert(va_arg(args, int) == 700); opened++; va_end(args); return 123; }
  assert(number == SYS_pidfd_send_signal); assert(va_arg(args, int) == 123); assert(va_arg(args, int) == expected_signal);
  signals++; va_end(args); return 0;
}
static int close_handle(int fd) { assert(fd == 123); closed_fd++; return 0; }
#define RECOVERY_SYSCALL system_call
#define close close_handle
#endif
#define RECOVERY_PROBE probe
#define RECOVERY_GROUP group_of
#include "../../electron/native/pty-owner/recovery.h"
int main(void) {
  ProcessIdentity saved = { 700, 100, 0 };
  for (int kind = 0; kind < 2; kind++) for (scenario = 0; scenario < 3; scenario++) {
    expected_signal = kind ? SIGTERM : SIGKILL;
    probes = signals = opened = closed_fd = 0;
    int result = kind ? recovery_signal_process_with_signal(&saved, 700, SIGTERM) : recovery_signal_process(&saved, 700);
    assert(result == (scenario == 0 ? 1 : scenario == 1 ? 0 : -2));
    assert(signals == (scenario == 0 ? 1 : 0));
#ifndef __APPLE__
    assert(opened == 1 && closed_fd == 1);
#endif
  }
  probes = signals = opened = closed_fd = 0;
  assert(recovery_signal_process_with_signal(&saved, 700, SIGINT) == -1);
  assert(probes == 0 && signals == 0 && opened == 0 && closed_fd == 0);
  return 0;
}
