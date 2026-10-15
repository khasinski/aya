#ifndef AYA_OWNER_PROCESS_IDENTITY_H
#define AYA_OWNER_PROCESS_IDENTITY_H
#include <stdint.h>
#ifdef __APPLE__
#include <libproc.h>
#endif

typedef struct { pid_t pid; uint64_t start, fraction; } ProcessIdentity;
// 1 = measured process instance, 0 = absent, -1 = unknown. Unknown never
// releases a lease. A PID alone is insufficient after the reader disconnects.
static int process_identity(pid_t pid, ProcessIdentity *out) {
#ifdef __APPLE__
  struct proc_bsdinfo info;
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (!size && errno == ESRCH) return 0;
  if (size != sizeof(info) || !info.pbi_start_tvsec) return -1;
  *out = (ProcessIdentity){ pid, info.pbi_start_tvsec, info.pbi_start_tvusec };
#else
  char path[64], data[4096];
  snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? 0 : -1;
  ssize_t size;
  do { size = read(fd, data, sizeof(data) - 1); } while (size < 0 && errno == EINTR);
  close(fd);
  if (size <= 0 || size == sizeof(data) - 1) return -1;
  data[size] = 0;
  // comm (field 2) can contain spaces and ')' characters. Start after its
  // final ')' and skip fields 3..21 before reading starttime (field 22).
  char *field = strrchr(data, ')');
  if (!field || field[1] != ' ') return -1;
  field += 2;
  for (int number = 3; number < 22; number++) {
    field = strchr(field, ' ');
    if (!field) return -1;
    field++;
  }
  char *end; errno = 0;
  unsigned long long start = strtoull(field, &end, 10);
  if (errno || end == field || *end != ' ' || !start) return -1;
  *out = (ProcessIdentity){ pid, start, 0 };
#endif
  return 1;
}
static int process_lease_blocks(const ProcessIdentity *lease,
                               int (*probe)(pid_t, ProcessIdentity *)) {
  if (!lease->pid) return 0;
  ProcessIdentity current;
  int status = probe(lease->pid, &current);
  if (status < 0) return 1;
  if (!status) return 0;
  return current.pid == lease->pid && current.start == lease->start &&
    current.fraction == lease->fraction;
}
#endif
