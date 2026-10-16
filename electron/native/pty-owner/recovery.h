#ifndef AYA_OWNER_RECOVERY_H
#define AYA_OWNER_RECOVERY_H
#ifndef __APPLE__
#include <sys/syscall.h>
#endif
#ifndef RECOVERY_PROBE
#define RECOVERY_PROBE process_identity
#endif
#ifndef RECOVERY_GROUP
#define RECOVERY_GROUP getpgid
#endif
#ifndef RECOVERY_SIGNAL
#define RECOVERY_SIGNAL kill
#endif
#ifndef RECOVERY_SYSCALL
#define RECOVERY_SYSCALL syscall
#endif
// 1 signalled, 0 absent, -1 unknown, -2 mismatch. Only individual processes
// are signalled here. Linux reserves the target instance with a pidfd.
static int recovery_signal_process_with_signal(const ProcessIdentity *saved, pid_t group, int signal_number) {
  if (signal_number != SIGKILL && signal_number != SIGTERM) return -1;
  ProcessIdentity current;
#ifndef __APPLE__
  int fd = (int)RECOVERY_SYSCALL(SYS_pidfd_open, saved->pid, 0);
  if (fd < 0) return errno == ESRCH ? 0 : -1;
#endif
  int status = RECOVERY_PROBE(saved->pid, &current), result = status;
  if (status > 0 && (current.start != saved->start || current.fraction != saved->fraction || RECOVERY_GROUP(saved->pid) != group)) result = -2;
  if (result > 0) {
    // A second identity check catches exit/reuse during the group probe.
    status = RECOVERY_PROBE(saved->pid, &current);
    if (status <= 0) result = status;
    else if (current.start != saved->start || current.fraction != saved->fraction) result = -2;
    else {
#ifdef __APPLE__
      // macOS has no pidfd equivalent. There remains a kernel scheduling/PID
      // reuse window after this check; never signal a numeric process group.
      result = RECOVERY_SIGNAL(saved->pid, signal_number) ? (errno == ESRCH ? 0 : -1) : 1;
#else
      result = RECOVERY_SYSCALL(SYS_pidfd_send_signal, fd, signal_number, NULL, 0) ? (errno == ESRCH ? 0 : -1) : 1;
#endif
    }
  }
#ifndef __APPLE__
  close(fd);
#endif
  return result;
}
static int recovery_signal_process(const ProcessIdentity *saved, pid_t group) {
  return recovery_signal_process_with_signal(saved, group, SIGKILL);
}
#endif
