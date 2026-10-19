#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <unistd.h>
static pid_t parent_pid;
static int interrupt_wake, interrupted_child;
static ssize_t interrupted_write(int fd, const void *bytes, size_t size) {
  if (interrupt_wake || (getpid() != parent_pid && size == sizeof(int) && !interrupted_child)) {
    interrupt_wake = 0; interrupted_child = 1; errno = EINTR; return -1;
  }
  return write(fd, bytes, size);
}
#define write interrupted_write
#define main owner_program_main
#include "../../electron/native/pty-owner/owner.c"
#undef main
int main(int argc, char **argv) {
  parent_pid = getpid();
  assert(pipe(wake_pipe) == 0);
  interrupt_wake = 1; errno = EDOM; wake_owner(SIGCHLD); assert(errno == EDOM);
  struct pollfd pending = { .fd = wake_pipe[0], .events = POLLIN };
  assert(poll(&pending, 1, 100) == 1);
  char byte; assert(read(wake_pipe[0], &byte, 1) == 1 && byte == 'C');
  close(wake_pipe[0]); close(wake_pipe[1]); interrupted_child = 0;
  return owner_program_main(argc, argv);
}
