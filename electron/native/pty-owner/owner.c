#define _GNU_SOURCE
#include "protocol.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <termios.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/un.h>
#include <util.h>
#else
#include <pty.h>
#endif
#include "process-identity.h"
#ifndef OWNER_BUILD_ID
#define OWNER_BUILD_ID "unbuilt"
#endif

typedef struct { unsigned char *data; size_t size, offset; int bad; } Reader;
typedef struct { unsigned char data[OWNER_MAX_FRAME]; size_t size; int bad; } Writer;
typedef struct {
  int fd, authenticated;
  pid_t pid;
  ProcessIdentity identity;
  unsigned char *data;
  size_t used, capacity;
  int64_t deadline;
} Client;
typedef struct {
  char id[OWNER_MAX_ID + 1];
  uint32_t generation, event;
  pid_t pid;
  int fd, cols, rows, exited, acknowledged, status;
  ProcessIdentity identity;
  int64_t kill_deadline;
} Pane;
static Client clients[OWNER_MAX_CLIENTS];
static Pane panes[OWNER_MAX_PANES];
static unsigned char token[OWNER_AUTH_BYTES];
static int wake_pipe[2], running = 1, active = -1;
static ProcessIdentity lease;
static uint32_t serial;
static char instance_id[33];

static int64_t now_ms(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static int cloexec(int fd) { return fcntl(fd, F_SETFD, FD_CLOEXEC); }
static void fail(const char *text) { perror(text); exit(1); }
static void wake_owner(int number) {
  int saved = errno; char c = number == SIGCHLD ? 'C' : 'T';
  ssize_t written;
  do { written = write(wake_pipe[1], &c, 1); } while (written < 0 && errno == EINTR);
  // EAGAIN means a previous wake is already queued in this nonblocking pipe.
  errno = saved;
}
static uint32_t get32(Reader *r) {
  uint32_t value = 0;
  if (r->offset + 4 > r->size) { r->bad = 1; return 0; }
  memcpy(&value, r->data + r->offset, 4); r->offset += 4; return ntohl(value);
}
static char *get_string(Reader *r, size_t maximum) {
  uint32_t size = get32(r);
  if (r->bad || size > maximum || r->offset + size > r->size || memchr(r->data + r->offset, 0, size)) {
    r->bad = 1; return NULL;
  }
  char *value = malloc((size_t)size + 1);
  if (!value) { r->bad = 1; return NULL; }
  memcpy(value, r->data + r->offset, size); value[size] = 0; r->offset += size; return value;
}
static int complete(Reader *r) { return !r->bad && r->offset == r->size; }
static void put32(Writer *w, uint32_t value) {
  if (w->size + 4 > sizeof(w->data)) { w->bad = 1; return; }
  value = htonl(value); memcpy(w->data + w->size, &value, 4); w->size += 4;
}
static void put_string(Writer *w, const char *value) {
  size_t length = strlen(value); put32(w, (uint32_t)length);
  if (w->size + length > sizeof(w->data)) { w->bad = 1; return; }
  memcpy(w->data + w->size, value, length); w->size += length;
}
static int wait_writable(int fd, int64_t deadline) {
  for (;;) {
    int remaining = (int)(deadline - now_ms());
    if (remaining <= 0) { errno = ETIMEDOUT; return -1; }
    struct pollfd wait = { .fd = fd, .events = POLLOUT };
    int ready = poll(&wait, 1, remaining);
    if (ready > 0) return 0;
    if (ready < 0 && errno == EINTR) continue;
    if (!ready) errno = ETIMEDOUT;
    return -1;
  }
}
static int write_all(int fd, const void *data, size_t size, int64_t deadline) {
  const unsigned char *p = data;
  while (size) {
    if (now_ms() >= deadline) { errno = ETIMEDOUT; return -1; }
    ssize_t count = write(fd, p, size);
    if (count > 0) { p += count; size -= (size_t)count; continue; }
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      if (wait_writable(fd, deadline)) return -1;
      continue;
    }
    return -1;
  }
  return 0;
}
static void drop_client(int index) {
  if (clients[index].fd >= 0) close(clients[index].fd);
  free(clients[index].data);
  clients[index] = (Client){ .fd = -1 };
  if (active == index) active = -1; // process-instance lease remains until the reader is gone
}
static int send_frame(int index, uint16_t type, uint32_t id, Writer *payload, int master) {
  if (payload->bad || clients[index].fd < 0) return -1;
  unsigned char header[OWNER_HEADER]; uint32_t word; uint16_t half;
  word = htonl(OWNER_MAGIC); memcpy(header, &word, 4);
  half = htons(OWNER_VERSION); memcpy(header + 4, &half, 2);
  half = htons(type); memcpy(header + 6, &half, 2);
  word = htonl(id); memcpy(header + 8, &word, 4);
  word = htonl((uint32_t)payload->size); memcpy(header + 12, &word, 4);
  int fd = clients[index].fd;
  const int64_t deadline = now_ms() + 1000;
  if (master >= 0) {
    union { struct cmsghdr align; char data[CMSG_SPACE(sizeof(int))]; } ancillary;
    memset(&ancillary, 0, sizeof(ancillary));
    struct iovec io = { .iov_base = header, .iov_len = 1 };
    struct msghdr message = { .msg_iov = &io, .msg_iovlen = 1,
      .msg_control = ancillary.data, .msg_controllen = sizeof(ancillary.data) };
    struct cmsghdr *c = CMSG_FIRSTHDR(&message);
    c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c), &master, sizeof(master));
    for (;;) {
      if (now_ms() >= deadline) { errno = ETIMEDOUT; goto failed; }
      ssize_t sent = sendmsg(fd, &message, 0);
      if (sent == 1) break;
      if (sent < 0 && errno == EINTR) continue;
      if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        if (wait_writable(fd, deadline)) goto failed;
        continue;
      }
      goto failed;
    }
  } else if (write_all(fd, header, 1, deadline)) goto failed;
  if (write_all(fd, header + 1, OWNER_HEADER - 1, deadline) || write_all(fd, payload->data, payload->size, deadline)) goto failed;
  return 0;
failed:
  drop_client(index); return -1;
}
static void error_reply(int client, uint32_t id, const char *message) {
  Writer w = {0}; put_string(&w, message); (void)send_frame(client, OWNER_ERROR, id, &w, -1);
}
static void pane_record(Writer *w, Pane *p) {
  put_string(w, p->id); put32(w, p->generation); put32(w, (uint32_t)p->pid);
  put32(w, (uint32_t)p->cols); put32(w, (uint32_t)p->rows); put32(w, (uint32_t)p->exited);
  put32(w, p->exited && WIFEXITED(p->status) ? (uint32_t)WEXITSTATUS(p->status) : UINT32_MAX);
  put32(w, p->exited && WIFSIGNALED(p->status) ? (uint32_t)WTERMSIG(p->status) : 0);
  put32(w, p->event); put32(w, (uint32_t)p->acknowledged);
  char identity[64] = "";
  if (p->identity.start) snprintf(identity, sizeof(identity), "%llu:%llu", (unsigned long long)p->identity.start, (unsigned long long)p->identity.fraction);
  put_string(w, identity);
}
static void exit_event(int client, Pane *p) {
  Writer w = {0}; pane_record(&w, p); (void)send_frame(client, OWNER_EXIT, 0, &w, -1);
}
static void reap_children(void) {
  for (int i = 0; i < OWNER_MAX_PANES; i++) {
    Pane *p = &panes[i];
    if (!p->id[0] || p->exited) continue;
    // Keep the leader's PID reserved until group escalation completes. Reaping
    // it first could let the OS reuse its PID/PGID before our delayed signal.
    if (p->kill_deadline && now_ms() < p->kill_deadline) continue;
    // Observe without reaping so the leader still reserves its PID/PGID
    // while we stop every remaining descendant. Reaped records never signal
    // a numeric group that may since have been reused.
    siginfo_t info = {0};
    if (waitid(P_PID, (id_t)p->pid, &info, WEXITED | WNOHANG | WNOWAIT) || !info.si_pid) continue;
    (void)kill(-p->pid, SIGKILL);
    int status; pid_t result = waitpid(p->pid, &status, WNOHANG);
    if (result == p->pid) {
      p->exited = 1; p->status = status; p->event = p->generation;
      if (active >= 0) exit_event(active, p);
    }
  }
}
static int peer_pid(int fd, pid_t *pid) {
#ifdef __APPLE__
  uid_t uid; gid_t gid; socklen_t size = sizeof(*pid);
  if (getpeereid(fd, &uid, &gid) || uid != getuid() || getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pid, &size)) return -1;
#else
  struct ucred credential; socklen_t size = sizeof(credential);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credential, &size) || credential.uid != getuid()) return -1;
  *pid = credential.pid;
#endif
  return *pid > 0 ? 0 : -1;
}
static void free_vector(char **values) {
  if (values) { for (size_t i = 0; values[i]; i++) free(values[i]); free(values); }
}
static char **get_vector(Reader *r, uint32_t maximum) {
  uint32_t count = get32(r); if (r->bad || count > maximum) { r->bad = 1; return NULL; }
  char **values = calloc((size_t)count + 1, sizeof(char *));
  if (!values) { r->bad = 1; return NULL; }
  for (uint32_t i = 0; i < count; i++) {
    values[i] = get_string(r, 65536);
    if (!values[i]) { free_vector(values); return NULL; }
  }
  return values;
}
static void terminate_group(pid_t pid, int number) {
  if (kill(-pid, number) && errno == ESRCH) (void)kill(pid, number);
}
static void spawn_pane(int client, uint32_t request, Reader *r) {
  char *id = get_string(r, OWNER_MAX_ID);
  uint32_t cols = get32(r), rows = get32(r);
  char *cwd = get_string(r, PATH_MAX), *command = get_string(r, PATH_MAX);
  char **args = get_vector(r, 256), **env = get_vector(r, 1024);
  Pane *slot = NULL;
  if (!complete(r) || !id || !id[0] || !cwd || cwd[0] != '/' || !command || command[0] != '/' ||
      !args || !args[0] || !env || cols < 2 || rows < 1 || cols > 1000 || rows > 1000) {
    error_reply(client, request, "Invalid spawn data"); goto done;
  }
  for (int i = 0; env[i]; i++) if (!strchr(env[i], '=') || env[i][0] == '=') {
    error_reply(client, request, "Invalid environment entry"); goto done;
  }
  for (int i = 0; i < OWNER_MAX_PANES; i++) {
    if (!strcmp(panes[i].id, id) && !(panes[i].exited && panes[i].acknowledged)) {
      error_reply(client, request, "Pane already exists or exit is unacknowledged"); goto done;
    }
    if (!panes[i].id[0] || (panes[i].exited && panes[i].acknowledged)) slot = &panes[i];
  }
  if (!slot) { error_reply(client, request, "Pane limit reached"); goto done; }
  if (serial == UINT32_MAX) { error_reply(client, request, "Pane generation limit reached"); goto done; }
  int errors[2]; if (pipe(errors)) { error_reply(client, request, "Cannot create exec pipe"); goto done; }
  cloexec(errors[0]); cloexec(errors[1]);
  int master; struct winsize size = { .ws_col = (unsigned short)cols, .ws_row = (unsigned short)rows };
  pid_t pid = forkpty(&master, NULL, NULL, &size);
  if (pid == 0) {
    close(errors[0]);
    signal(SIGCHLD, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    if (!chdir(cwd)) execve(command, args, env);
    int saved = errno; ssize_t written;
    // A pipe write this small is atomic; retry an interruption before reporting
    // exec failure. A closed pipe needs no recovery because the parent left.
    do { written = write(errors[1], &saved, sizeof(saved)); } while (written < 0 && errno == EINTR);
    _exit(127);
  }
  close(errors[1]);
  if (pid < 0) { close(errors[0]); error_reply(client, request, "forkpty failed"); goto done; }
  cloexec(master);
  struct pollfd pending = { .fd = errors[0], .events = POLLIN };
  int ready; int64_t exec_deadline = now_ms() + 3000;
  do { ready = poll(&pending, 1, (int)(exec_deadline > now_ms() ? exec_deadline - now_ms() : 0)); } while (ready < 0 && errno == EINTR && now_ms() < exec_deadline);
  int exec_error = 0; ssize_t count = ready > 0 ? read(errors[0], &exec_error, sizeof(exec_error)) : -1;
  close(errors[0]);
  if (count != 0) {
    terminate_group(pid, SIGKILL); while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) {}
    close(master); error_reply(client, request, ready <= 0 ? "Spawn exec timed out" : strerror(exec_error)); goto done;
  }
  if (slot->id[0]) close(slot->fd);
  memset(slot, 0, sizeof(*slot)); strcpy(slot->id, id);
  slot->pid = pid; slot->fd = master; slot->cols = (int)cols; slot->rows = (int)rows; slot->generation = ++serial;
  // The child remains our unreaped PID while its process instance is recorded.
  (void)process_identity(pid, &slot->identity);
  Writer w = {0}; pane_record(&w, slot); (void)send_frame(client, OWNER_OK, request, &w, master);
done:
  free(id); free(cwd); free(command); free_vector(args); free_vector(env);
}
static void handle_frame(int client, uint16_t type, uint32_t request, unsigned char *data, size_t size) {
  Reader r = { .data = data, .size = size };
  if (!running) { error_reply(client, request, "Owner is shutting down"); return; }
  if (!clients[client].authenticated) {
    unsigned difference = 0;
    if (type == OWNER_HELLO && size == sizeof(token)) for (size_t i = 0; i < sizeof(token); i++) difference |= data[i] ^ token[i];
    else difference = 1;
    if (difference) { error_reply(client, request, "Authentication failed"); drop_client(client); return; }
    if (active >= 0 || process_lease_blocks(&lease, process_identity)) {
      error_reply(client, request, "Previous client still owns the lease"); drop_client(client); return;
    }
    // The instance captured at accept must still match when authentication
    // completes. A disappeared/recycled peer cannot acquire a new lease.
    ProcessIdentity *identity = &clients[client].identity;
    ProcessIdentity current;
    if (process_identity(identity->pid, &current) != 1 ||
        current.start != identity->start || current.fraction != identity->fraction) {
      error_reply(client, request, "Cannot verify client process identity"); drop_client(client); return;
    }
    active = client; lease = *identity; clients[client].authenticated = 1;
    Writer w = {0}; put_string(&w, OWNER_BUILD_ID); put32(&w, (uint32_t)getpid());
    put_string(&w, instance_id);
    (void)send_frame(client, OWNER_OK, request, &w, -1);
    for (int i = 0; i < OWNER_MAX_PANES && clients[client].fd >= 0; i++) if (panes[i].exited && !panes[i].acknowledged) exit_event(client, &panes[i]);
    return;
  }
  if (type == OWNER_SPAWN) { spawn_pane(client, request, &r); return; }
  if (type != OWNER_LIST && type != OWNER_SHUTDOWN && type != OWNER_STATS && type != OWNER_ATTACH &&
      type != OWNER_RESIZE && type != OWNER_KILL && type != OWNER_ACK_EXIT) {
    error_reply(client, request, "Unknown operation"); return;
  }
  Writer w = {0};
  if (type == OWNER_LIST || type == OWNER_SHUTDOWN) {
    if (!complete(&r)) { error_reply(client, request, "Unexpected payload"); return; }
    if (type == OWNER_LIST) {
      uint32_t count = 0; for (int i = 0; i < OWNER_MAX_PANES; i++) if (panes[i].id[0]) count++;
      put32(&w, count); for (int i = 0; i < OWNER_MAX_PANES; i++) if (panes[i].id[0]) pane_record(&w, &panes[i]);
    } else running = 0;
    (void)send_frame(client, OWNER_OK, request, &w, -1); return;
  }
  if (type == OWNER_STATS && complete(&r)) {
    struct rusage usage; getrusage(RUSAGE_SELF, &usage);
    uint64_t user = (uint64_t)usage.ru_utime.tv_sec * 1000000 + usage.ru_utime.tv_usec;
    uint64_t system = (uint64_t)usage.ru_stime.tv_sec * 1000000 + usage.ru_stime.tv_usec;
    put32(&w, (uint32_t)(user >> 32)); put32(&w, (uint32_t)user);
    put32(&w, (uint32_t)(system >> 32)); put32(&w, (uint32_t)system);
    (void)send_frame(client, OWNER_OK, request, &w, -1); return;
  }
  char *id = get_string(&r, OWNER_MAX_ID); uint32_t generation = get32(&r);
  Pane *pane = NULL;
  for (int i = 0; id && i < OWNER_MAX_PANES; i++) if (panes[i].id[0] && !strcmp(panes[i].id, id) && panes[i].generation == generation) pane = &panes[i];
  free(id);
  if (r.bad || !pane) { error_reply(client, request, "Unknown pane generation"); return; }
  uint32_t a = 0, b = 0;
  if (type == OWNER_RESIZE) { a = get32(&r); b = get32(&r); }
  if (type == OWNER_KILL || type == OWNER_ACK_EXIT) a = get32(&r);
  if (!complete(&r)) { error_reply(client, request, "Invalid payload"); return; }
  if (type == OWNER_ATTACH && pane->fd >= 0) { pane_record(&w, pane); (void)send_frame(client, OWNER_OK, request, &w, pane->fd); return; }
  if (type == OWNER_RESIZE && !pane->exited && a >= 2 && b >= 1 && a <= 1000 && b <= 1000) {
    struct winsize geometry = { .ws_col = (unsigned short)a, .ws_row = (unsigned short)b };
    if (ioctl(pane->fd, TIOCSWINSZ, &geometry)) { error_reply(client, request, "Resize failed"); return; }
    pane->cols = (int)a; pane->rows = (int)b;
  } else if (type == OWNER_KILL && !pane->exited && (a == SIGHUP || a == SIGTERM || a == SIGKILL || a == SIGINT)) {
    // Observe this still-reserved child immediately before accepting a stop.
    // Client dispatch can precede SIGCHLD reaping. An already-ended child
    // keeps its natural outcome and must not authorize a replacement spawn.
    siginfo_t info = {0}; int observed;
    do { observed = waitid(P_PID, (id_t)pane->pid, &info, WEXITED | WNOHANG | WNOWAIT); } while (observed < 0 && errno == EINTR);
    if (observed < 0) { error_reply(client, request, "Cannot verify child before stop"); return; }
    if (info.si_pid) { reap_children(); error_reply(client, request, "Child already ended before stop"); return; }
    terminate_group(pane->pid, (int)a);
    if (a == SIGHUP || a == SIGTERM) pane->kill_deadline = now_ms() + 750;
  } else if (type == OWNER_ACK_EXIT && pane->exited && a == pane->event) {
    pane->acknowledged = 1;
    if (pane->fd >= 0) { close(pane->fd); pane->fd = -1; }
  }
  else { error_reply(client, request, "Unknown operation or invalid state"); return; }
  (void)send_frame(client, OWNER_OK, request, &w, -1);
}
static void read_client(int index) {
  Client *c = &clients[index];
  if (c->used == c->capacity) {
    size_t capacity = c->capacity ? c->capacity * 2 : OWNER_HEADER;
    if (capacity > OWNER_MAX_FRAME + OWNER_HEADER) capacity = OWNER_MAX_FRAME + OWNER_HEADER;
    if (capacity == c->capacity) { drop_client(index); return; }
    unsigned char *data = realloc(c->data, capacity);
    if (!data) { drop_client(index); return; }
    c->data = data; c->capacity = capacity;
  }
  // Requests never carry descriptors. recvmsg lets us reject and close extras.
  union { struct cmsghdr align; char data[CMSG_SPACE(16 * sizeof(int))]; } ancillary;
  struct iovec io = { .iov_base = c->data + c->used, .iov_len = c->capacity - c->used };
  struct msghdr message = { .msg_iov = &io, .msg_iovlen = 1,
    .msg_control = ancillary.data, .msg_controllen = sizeof(ancillary.data) };
  ssize_t count = recvmsg(c->fd, &message, 0);
  int unexpected = (message.msg_flags & MSG_CTRUNC) != 0;
  if (count > 0) for (struct cmsghdr *h = CMSG_FIRSTHDR(&message); h; h = CMSG_NXTHDR(&message, h)) {
    unexpected = 1;
    if (h->cmsg_level == SOL_SOCKET && h->cmsg_type == SCM_RIGHTS && h->cmsg_len >= CMSG_LEN(0)) {
      size_t length = (h->cmsg_len - CMSG_LEN(0)) / sizeof(int);
      int *fds = (int *)CMSG_DATA(h); for (size_t i = 0; i < length; i++) close(fds[i]);
    }
  }
  if (unexpected || count == 0 || (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) { drop_client(index); return; }
  if (count < 0) return;
  if (!c->used && c->authenticated) c->deadline = now_ms() + 5000;
  c->used += (size_t)count;
  while (c->used >= OWNER_HEADER) {
    uint32_t magic, request, length; uint16_t version, type;
    memcpy(&magic, c->data, 4); memcpy(&version, c->data + 4, 2); memcpy(&type, c->data + 6, 2);
    memcpy(&request, c->data + 8, 4); memcpy(&length, c->data + 12, 4);
    magic = ntohl(magic); version = ntohs(version); type = ntohs(type); request = ntohl(request); length = ntohl(length);
    if (magic != OWNER_MAGIC || version != OWNER_VERSION || length > OWNER_MAX_FRAME || !request) { error_reply(index, request, "Invalid protocol header"); drop_client(index); return; }
    if (c->used < OWNER_HEADER + length) break;
    handle_frame(index, type, request, c->data + OWNER_HEADER, length);
    if (c->fd < 0) return;
    size_t consumed = OWNER_HEADER + length; c->used -= consumed; memmove(c->data, c->data + consumed, c->used);
    c->deadline = c->used ? now_ms() + 5000 : 0;
  }
}
static void validate_private_path(const char *socket_path, const char *token_descriptor) {
  char directory[PATH_MAX];
  if (strlen(socket_path) >= sizeof(directory)) fail("socket path length");
  strcpy(directory, socket_path); char *last = strrchr(directory, '/');
  if (!last || last == directory) { errno = EINVAL; fail("socket parent"); } *last = 0;
  struct stat s;
  if (lstat(directory, &s) || !S_ISDIR(s.st_mode) || s.st_uid != getuid() || (s.st_mode & 0077)) { errno = EACCES; fail("socket directory must be private"); }
  char *end; errno = 0;
  long parsed = strtol(token_descriptor, &end, 10);
  if (errno || !*token_descriptor || *end || parsed < 3 || parsed > INT_MAX) { errno = EINVAL; fail("token descriptor"); }
  int fd = (int)parsed;
  if (fstat(fd, &s) || (!S_ISFIFO(s.st_mode) && !S_ISSOCK(s.st_mode))) { errno = EACCES; fail("token must arrive through an inherited pipe"); }
  size_t used = 0; int64_t deadline = now_ms() + 5000;
  while (used < sizeof(token)) {
    struct pollfd entry = { .fd = fd, .events = POLLIN };
    int remaining = (int)(deadline - now_ms());
    if (remaining <= 0) { errno = ETIMEDOUT; fail("token pipe timed out"); }
    int ready = poll(&entry, 1, remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) { if (!ready) errno = ETIMEDOUT; fail("token pipe readiness"); }
    ssize_t count = read(fd, token + used, sizeof(token) - used);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { errno = EINVAL; fail("token pipe must contain 32 bytes"); }
    used += (size_t)count;
  }
  close(fd);
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) { printf("{\"protocol\":%d,\"buildId\":\"%s\"}\n", OWNER_VERSION, OWNER_BUILD_ID); return 0; }
  if (argc != 5 || strcmp(argv[1], "--socket") || strcmp(argv[3], "--token-fd")) { fprintf(stderr, "usage: aya-pty-owner --socket PATH --token-fd FD\n"); return 2; }
  umask(0077); validate_private_path(argv[2], argv[4]);
  unsigned char random[16]; int random_fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (random_fd < 0 || read(random_fd, random, sizeof(random)) != sizeof(random)) fail("owner instance entropy");
  close(random_fd);
  for (size_t i = 0; i < sizeof(random); i++) snprintf(instance_id + i * 2, 3, "%02x", random[i]);
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  if (strlen(argv[2]) >= sizeof(address.sun_path)) { errno = ENAMETOOLONG; fail("socket path"); } strcpy(address.sun_path, argv[2]);
  char lock_path[PATH_MAX]; if (snprintf(lock_path, sizeof(lock_path), "%s.lock", argv[2]) >= (int)sizeof(lock_path)) fail("lock path length");
  int lock = open(lock_path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600); struct stat lock_stat;
  if (lock < 0 || fstat(lock, &lock_stat) || !S_ISREG(lock_stat.st_mode) || lock_stat.st_uid != getuid() || (lock_stat.st_mode & 0077) || flock(lock, LOCK_EX | LOCK_NB)) fail("owner already running or invalid lock");
  struct stat old;
  if (!lstat(argv[2], &old)) {
    if (!S_ISSOCK(old.st_mode) || old.st_uid != getuid() || unlink(argv[2])) { errno = EACCES; fail("stale socket"); }
  } else if (errno != ENOENT) fail("socket status");
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server < 0 || cloexec(server) || bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, OWNER_MAX_CLIENTS)) fail("owner listen");
  if (pipe(wake_pipe)) fail("signal pipe");
  for (int i = 0; i < 2; i++) if (cloexec(wake_pipe[i]) || fcntl(wake_pipe[i], F_SETFL, O_NONBLOCK)) fail("signal flags");
  struct sigaction action = { .sa_handler = wake_owner }; sigemptyset(&action.sa_mask);
  if (sigaction(SIGCHLD, &action, NULL) || sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) fail("signal handlers");
  signal(SIGPIPE, SIG_IGN);
  for (int i = 0; i < OWNER_MAX_CLIENTS; i++) clients[i].fd = -1;
  printf("{\"ready\":true,\"pid\":%d,\"protocol\":%d,\"buildId\":\"%s\"}\n", getpid(), OWNER_VERSION, OWNER_BUILD_ID); fflush(stdout);
  while (running) {
    struct pollfd descriptors[OWNER_MAX_CLIENTS + 2] = { { .fd = server, .events = POLLIN }, { .fd = wake_pipe[0], .events = POLLIN } };
    int timeout = -1; int64_t time = now_ms();
    for (int i = 0; i < OWNER_MAX_PANES; i++) if (panes[i].kill_deadline) {
      if (panes[i].kill_deadline <= time) {
        (void)kill(-panes[i].pid, SIGKILL);
        if (!panes[i].exited) (void)kill(panes[i].pid, SIGKILL);
        panes[i].kill_deadline = 0;
      } else {
        int remaining = (int)(panes[i].kill_deadline - time);
        if (timeout < 0 || remaining < timeout) timeout = remaining;
      }
    }
    reap_children();
    for (int i = 0; i < OWNER_MAX_CLIENTS; i++) {
      Client *c = &clients[i]; descriptors[i + 2] = (struct pollfd){ .fd = c->fd, .events = POLLIN };
      if (c->fd >= 0 && c->deadline) {
        int remaining = c->deadline > time ? (int)(c->deadline - time) : 0;
        if (timeout < 0 || remaining < timeout) timeout = remaining;
      }
    }
    int result = poll(descriptors, OWNER_MAX_CLIENTS + 2, timeout);
    if (result < 0) { if (errno == EINTR) { reap_children(); continue; } fail("owner poll"); }
    if (descriptors[1].revents) { char events[64]; ssize_t count = read(wake_pipe[0], events, sizeof(events)); for (ssize_t i = 0; i < count; i++) if (events[i] == 'T') running = 0; }
    for (int i = 0; i < OWNER_MAX_CLIENTS; i++) if (clients[i].fd >= 0) {
      if (descriptors[i + 2].revents) read_client(i);
      if (clients[i].fd >= 0 && clients[i].deadline && clients[i].deadline <= now_ms()) drop_client(i);
    }
    if (descriptors[0].revents & POLLIN) {
      int fd = accept(server, NULL, NULL); int slot = -1; pid_t pid; ProcessIdentity identity;
      for (int i = 0; i < OWNER_MAX_CLIENTS; i++) if (clients[i].fd < 0) { slot = i; break; }
      if (fd >= 0) {
        if (slot < 0 || cloexec(fd) || peer_pid(fd, &pid) || process_identity(pid, &identity) != 1 || fcntl(fd, F_SETFL, O_NONBLOCK)) close(fd);
        else clients[slot] = (Client){ .fd = fd, .pid = pid, .identity = identity, .deadline = now_ms() + 5000 };
      }
    }
    if (running) reap_children();
  }
  int live = 0;
  for (int i = 0; i < OWNER_MAX_PANES; i++) if (panes[i].id[0] && !panes[i].exited) {
    terminate_group(panes[i].pid, SIGHUP); live++;
  }
  // Do not reap leaders during this grace period: their reserved IDs protect
  // the subsequent group kill from signalling a recycled PID/PGID.
  int64_t deadline = now_ms() + (live ? 750 : 0);
  while (now_ms() < deadline) {
    struct timespec pause = { .tv_nsec = 10000000 }; nanosleep(&pause, NULL);
  }
  for (int i = 0; i < OWNER_MAX_PANES; i++) if (panes[i].id[0]) {
    // Only unreaped leaders still reserve their PID/PGID. An old, acknowledged
    // pane record must never signal a group whose numeric ID could be reused.
    if (!panes[i].exited) (void)kill(-panes[i].pid, SIGKILL);
    // A macOS PTY child can wait in terminal drain during exit. Release our
    // master before blocking waitpid; the shutdown client releases duplicates.
    if (panes[i].fd >= 0) { (void)tcflush(panes[i].fd, TCIOFLUSH); close(panes[i].fd); panes[i].fd = -1; }
    if (!panes[i].exited) { (void)kill(panes[i].pid, SIGKILL); while (waitpid(panes[i].pid, NULL, 0) < 0 && errno == EINTR) {} }
  }
  for (int i = 0; i < OWNER_MAX_CLIENTS; i++) drop_client(i);
  close(server); close(wake_pipe[0]); close(wake_pipe[1]); unlink(argv[2]); close(lock);
  return 0;
}
