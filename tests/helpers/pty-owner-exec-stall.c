#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
static int stalled_exec(const char *file, char *const argv[], char *const env[]) {
  (void)file; (void)argv; (void)env;
  int fd = open("stalled-child", O_CREAT | O_WRONLY, 0600);
  if (fd >= 0) { dprintf(fd, "%d", getpid()); close(fd); }
  for (;;) pause();
  return -1;
}
#define execve stalled_exec
#define main owner_program_main
#include "../../electron/native/pty-owner/owner.c"
#undef main
int main(int argc, char **argv) { return owner_program_main(argc, argv); }
