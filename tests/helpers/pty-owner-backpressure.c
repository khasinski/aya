#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <termios.h>
#include <unistd.h>
#define TOTAL (2 * 1024 * 1024)
int main(void) {
  struct termios terminal; assert(tcgetattr(1, &terminal) == 0);
  terminal.c_oflag &= ~OPOST; terminal.c_lflag &= ~ECHO; assert(tcsetattr(1, TCSANOW, &terminal) == 0);
  assert(fcntl(1, F_SETFL, fcntl(1, F_GETFL) | O_NONBLOCK) == 0);
  size_t total = 0; int marked = 0;
  while (total < TOTAL) {
    unsigned char bytes[4096]; size_t size = TOTAL - total;
    if (size > sizeof(bytes)) size = sizeof(bytes);
    for (size_t i = 0; i < size; i++) bytes[i] = (unsigned char)((total + i) % 251);
    ssize_t written = write(1, bytes, size);
    if (written > 0) { total += (size_t)written; continue; }
    if (written < 0 && errno == EINTR) continue;
    assert(written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
    if (!marked) {
      int fd = open("backpressured", O_CREAT | O_WRONLY, 0600); assert(fd >= 0);
      dprintf(fd, "%zu", total); close(fd); marked = 1;
    }
    struct pollfd pending = { .fd = 1, .events = POLLOUT };
    int ready; do { ready = poll(&pending, 1, 5000); } while (ready < 0 && errno == EINTR);
    assert(ready > 0);
  }
  int fd = open("output-complete", O_CREAT | O_WRONLY, 0600); assert(fd >= 0);
  dprintf(fd, "%zu", total); close(fd);
  // Keep the slave alive until the receiver confirms the full byte stream.
  // This measures backpressure, independently of last-slave-close semantics.
  assert(fcntl(0, F_SETFL, fcntl(0, F_GETFL) & ~O_NONBLOCK) == 0);
  char receipt[16]; assert(read(0, receipt, sizeof(receipt)) > 0);
  return 23;
}
