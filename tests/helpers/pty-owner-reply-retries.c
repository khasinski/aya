#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
static int write_fault, poll_fault, send_fault;
static ssize_t retry_write(int fd, const void *bytes, size_t size) {
  if (write_fault) { write_fault = 0; errno = EAGAIN; return -1; }
  return write(fd, bytes, size);
}
static int retry_poll(struct pollfd *fds, nfds_t size, int timeout) {
  if (poll_fault) { poll_fault = 0; errno = EINTR; return -1; }
  return poll(fds, size, timeout);
}
static ssize_t retry_sendmsg(int fd, const struct msghdr *message, int flags) {
  if (send_fault == 2) { send_fault--; errno = EINTR; return -1; }
  if (send_fault == 1) { send_fault--; errno = EAGAIN; return -1; }
  return sendmsg(fd, message, flags);
}
#define write retry_write
#define poll retry_poll
#define sendmsg retry_sendmsg
#define main owner_program_main
#include "../../electron/native/pty-owner/owner.c"
#undef main
int main(void) {
  int sockets[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
  write_fault = poll_fault = 1;
  assert(write_all(sockets[0], "reply", 5, now_ms() + 1000) == 0);
  char bytes[5]; assert(read(sockets[1], bytes, 5) == 5);
  clients[0] = (Client){ .fd = sockets[0], .authenticated = 1 }; active = 0;
  Writer payload = {0}; put_string(&payload, "after interruption");
  send_fault = 2; poll_fault = 1;
  assert(send_frame(0, OWNER_OK, 1, &payload, sockets[0]) == 0);
  assert(clients[0].fd == sockets[0] && clients[0].authenticated && active == 0);
  close(sockets[0]); close(sockets[1]); return 0;
}
