#define _GNU_SOURCE
#include <sys/socket.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>
// Instrument the exact old fault window: immediately after the kernel
// installs SCM_RIGHTS descriptors, before bridge.c can run its fcntl.
static ssize_t checked_recvmsg(int fd, struct msghdr *message, int flags) {
  ssize_t result = recvmsg(fd, message, flags);
  if (result <= 0) return result;
  int invalid = 0;
  for (struct cmsghdr *c = CMSG_FIRSTHDR(message); c; c = CMSG_NXTHDR(message, c)) {
    if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS) continue;
    int *fds = (int *)CMSG_DATA(c);
    size_t count = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int);
    for (size_t i = 0; i < count; i++) if (!(fcntl(fds[i], F_GETFD) & FD_CLOEXEC)) invalid = 1;
  }
  if (invalid) {
    for (struct cmsghdr *c = CMSG_FIRSTHDR(message); c; c = CMSG_NXTHDR(message, c)) {
      if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS) continue;
      int *fds = (int *)CMSG_DATA(c);
      for (size_t i = 0; i < (c->cmsg_len - CMSG_LEN(0)) / sizeof(int); i++) close(fds[i]);
    }
    errno = EPROTO; return -1;
  }
  return result;
}
#define recvmsg checked_recvmsg
#include "../../electron/native/pty-owner/bridge.c"
