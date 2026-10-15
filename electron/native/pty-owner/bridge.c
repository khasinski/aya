#define _GNU_SOURCE
#define NAPI_VERSION 8
#include <node_api.h>
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
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#include "process-identity.h"

static napi_value error(napi_env env, const char *operation) {
  char text[160]; snprintf(text, sizeof(text), "%s: %s", operation, strerror(errno));
  napi_throw_error(env, NULL, text); return NULL;
}
static napi_value number(napi_env env, int value) { napi_value out; napi_create_int32(env, value, &out); return out; }
static int argument_fd(napi_env env, napi_value value, int *fd) {
  if (napi_get_value_int32(env, value, fd) != napi_ok || *fd < 3) {
    napi_throw_type_error(env, NULL, "Expected an owned descriptor >= 3"); return -1;
  }
  return 0;
}
static int recovery_pid(napi_env env, napi_value value, int *pid) {
  double input;
  if (napi_get_value_double(env, value, &input) != napi_ok || !(input >= 2 && input <= INT_MAX) || (double)(int)input != input) {
    napi_throw_type_error(env, NULL, "Invalid recovery PID"); return -1;
  }
  *pid = (int)input; return 0;
}
static int64_t time_ms(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static int wait_fd(int fd, short events, int64_t deadline) {
  for (;;) {
    int remaining = (int)(deadline - time_ms());
    if (remaining <= 0) { errno = ETIMEDOUT; return -1; }
    struct pollfd entry = { .fd = fd, .events = events };
    int result = poll(&entry, 1, remaining);
    if (result > 0) return 0;
    if (result < 0 && errno == EINTR) continue;
    if (result == 0) errno = ETIMEDOUT;
    return -1;
  }
}
static int read_all(int fd, void *data, size_t size, int64_t deadline) {
  unsigned char *p = data;
  while (size) {
    if (wait_fd(fd, POLLIN, deadline)) return -1;
    ssize_t count = read(fd, p, size);
    if (count > 0) { p += count; size -= (size_t)count; continue; }
    if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (!count) errno = EPIPE;
    return -1;
  }
  return 0;
}
static napi_value connect_socket(napi_env env, napi_callback_info info) {
  size_t count = 1, size; napi_value args[1]; char path[sizeof(((struct sockaddr_un *)0)->sun_path)];
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 1 || napi_get_value_string_utf8(env, args[0], NULL, 0, &size) != napi_ok || !size || size >= sizeof(path)) {
    napi_throw_type_error(env, NULL, "Invalid Unix socket path"); return NULL;
  }
  napi_get_value_string_utf8(env, args[0], path, sizeof(path), &size);
  if (strlen(path) != size) { napi_throw_type_error(env, NULL, "NUL in socket path"); return NULL; }
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return error(env, "socket");
  if (fcntl(fd, F_SETFD, FD_CLOEXEC) || fcntl(fd, F_SETFL, O_NONBLOCK)) goto failed;
#ifdef __APPLE__
  int enabled = 1; if (setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled))) goto failed;
#endif
  struct sockaddr_un address = { .sun_family = AF_UNIX }; strcpy(address.sun_path, path);
  if (connect(fd, (struct sockaddr *)&address, sizeof(address))) {
    if (errno != EINPROGRESS || wait_fd(fd, POLLOUT, time_ms() + 2000)) goto failed;
    int problem = 0; socklen_t length = sizeof(problem);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &problem, &length)) goto failed;
    if (problem) { errno = problem; goto failed; }
  }
  return number(env, fd);
failed: {
  int saved = errno; close(fd); errno = saved; return error(env, "connect");
}}
static napi_value send_frame(napi_env env, napi_callback_info info) {
  size_t count = 2, size; napi_value args[2]; int fd; void *data; bool buffer;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 2) { napi_throw_type_error(env, NULL, "Expected fd and Buffer"); return NULL; }
  if (argument_fd(env, args[0], &fd)) return NULL;
  napi_is_buffer(env, args[1], &buffer);
  if (!buffer || napi_get_buffer_info(env, args[1], &data, &size) != napi_ok || size > OWNER_MAX_FRAME + OWNER_HEADER) {
    napi_throw_type_error(env, NULL, "Invalid frame buffer"); return NULL;
  }
  unsigned char *p = data; int64_t deadline = time_ms() + 2000;
  while (size) {
    if (wait_fd(fd, POLLOUT, deadline)) return error(env, "send timeout");
#ifdef MSG_NOSIGNAL
    ssize_t written = send(fd, p, size, MSG_NOSIGNAL);
#else
    ssize_t written = send(fd, p, size, 0);
#endif
    if (written > 0) { p += written; size -= (size_t)written; }
    else if (written < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) return error(env, "send");
  }
  napi_value out; napi_get_undefined(env, &out); return out;
}
typedef struct {
  napi_async_work work; napi_deferred deferred;
  int fd, master, problem, timeout;
  unsigned char *data; size_t size;
} Receive;
static void receive_work(napi_env env, void *input) {
  (void)env; Receive *r = input; int64_t deadline = time_ms() + r->timeout;
  r->data = malloc(OWNER_HEADER); if (!r->data) { r->problem = ENOMEM; return; }
  if (wait_fd(r->fd, POLLIN, deadline)) { r->problem = errno; return; }
  union { struct cmsghdr align; char data[CMSG_SPACE(16 * sizeof(int))]; } ancillary;
  struct iovec io = { .iov_base = r->data, .iov_len = 1 };
  struct msghdr message = { .msg_iov = &io, .msg_iovlen = 1,
    .msg_control = ancillary.data, .msg_controllen = sizeof(ancillary.data) };
  ssize_t count;
#ifdef __linux__
  // This runs on a worker while JS can spawn children. Never install an
  // inheritable master, even briefly; no non-atomic fallback on old kernels.
  const int receive_flags = MSG_CMSG_CLOEXEC;
#elif defined(__APPLE__)
  // macOS has no MSG_CMSG_CLOEXEC. Its supported Node/Electron posix_spawn
  // path uses POSIX_SPAWN_CLOEXEC_DEFAULT; set the explicit flag below too.
  const int receive_flags = 0;
#else
#error Unsupported PTY owner bridge platform
#endif
  do { count = recvmsg(r->fd, &message, receive_flags); } while (count < 0 && errno == EINTR);
  if (count != 1) { if (!count) errno = EPIPE; goto failed; }
  // Waiting for the first byte is an idle deadline. Once a frame starts,
  // give its bounded body a fresh budget; an event arriving at the idle
  // boundary must not be mistaken for a truncated, corrupt frame.
  deadline = time_ms() + 5000;
  int invalid = (message.msg_flags & MSG_CTRUNC) != 0;
  for (struct cmsghdr *c = CMSG_FIRSTHDR(&message); c; c = CMSG_NXTHDR(&message, c)) {
    if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS || c->cmsg_len < CMSG_LEN(0)) { invalid = 1; continue; }
    size_t length = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int); int *fds = (int *)CMSG_DATA(c);
    for (size_t i = 0; i < length; i++) {
      if (r->master < 0) r->master = fds[i];
      else { close(fds[i]); invalid = 1; }
    }
  }
  if (invalid) { errno = EPROTO; goto failed; }
  if (r->master >= 0 && fcntl(r->master, F_SETFD, FD_CLOEXEC)) goto failed;
  if (read_all(r->fd, r->data + 1, OWNER_HEADER - 1, deadline)) goto failed;
  uint32_t magic, size; uint16_t version;
  memcpy(&magic, r->data, 4); memcpy(&version, r->data + 4, 2); memcpy(&size, r->data + 12, 4);
  size = ntohl(size);
  if (ntohl(magic) != OWNER_MAGIC || ntohs(version) != OWNER_VERSION || size > OWNER_MAX_FRAME) { errno = EPROTO; goto failed; }
  unsigned char *data = realloc(r->data, OWNER_HEADER + size);
  if (!data) { errno = ENOMEM; goto failed; } r->data = data; r->size = OWNER_HEADER + size;
  if (read_all(r->fd, r->data + OWNER_HEADER, size, deadline)) goto failed;
  return;
failed:
  r->problem = errno == ETIMEDOUT ? EPROTO : errno;
  if (r->master >= 0) { close(r->master); r->master = -1; }
}
static void receive_done(napi_env env, napi_status status, void *input) {
  Receive *r = input; close(r->fd);
  if (r->problem || status != napi_ok) {
    if (r->master >= 0) close(r->master);
    napi_value message, exception;
    napi_create_string_utf8(env, strerror(r->problem ? r->problem : ECANCELED), NAPI_AUTO_LENGTH, &message);
    napi_value code;
    napi_create_string_utf8(env, r->problem == ETIMEDOUT ? "ETIMEDOUT" : "EOWNER", NAPI_AUTO_LENGTH, &code);
    napi_create_error(env, code, message, &exception); napi_reject_deferred(env, r->deferred, exception);
  } else {
    napi_value out, data; napi_create_object(env, &out);
    napi_create_buffer_copy(env, r->size, r->data, NULL, &data);
    napi_set_named_property(env, out, "data", data);
    napi_set_named_property(env, out, "fd", number(env, r->master));
    napi_resolve_deferred(env, r->deferred, out);
  }
  free(r->data); napi_delete_async_work(env, r->work); free(r);
}
static napi_value receive_frame(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; int fd, timeout;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 2 || napi_get_value_int32(env, args[1], &timeout) != napi_ok || timeout < 1 || timeout > 10000) {
    napi_throw_type_error(env, NULL, "Expected fd and timeout (1..10000 ms)"); return NULL;
  }
  if (argument_fd(env, args[0], &fd)) return NULL;
  Receive *r = calloc(1, sizeof(*r)); if (!r) { errno = ENOMEM; return error(env, "receive allocation"); }
  r->fd = fcntl(fd, F_DUPFD_CLOEXEC, 3); r->master = -1; r->timeout = timeout;
  if (r->fd < 0) { free(r); return error(env, "receive descriptor"); }
  napi_value promise, name; napi_create_promise(env, &r->deferred, &promise);
  napi_create_string_utf8(env, "Aya owner receive", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, NULL, name, receive_work, receive_done, r, &r->work) != napi_ok || napi_queue_async_work(env, r->work) != napi_ok) {
    close(r->fd); if (r->work) napi_delete_async_work(env, r->work); free(r);
    napi_throw_error(env, NULL, "Cannot queue owner receive"); return NULL;
  }
  return promise;
}
static napi_value close_descriptor(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; int fd; bool control = false;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (!count) { napi_throw_type_error(env, NULL, "Expected fd"); return NULL; }
  if (argument_fd(env, args[0], &fd)) return NULL;
  if (count > 1) napi_get_value_bool(env, args[1], &control);
  if (control) (void)shutdown(fd, SHUT_RDWR); // wake any in-flight receive before closing
  (void)close(fd); napi_value out; napi_get_undefined(env, &out); return out;
}
static napi_value read_ready(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; int fd;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (!count) { napi_throw_type_error(env, NULL, "Expected fd"); return NULL; }
  if (argument_fd(env, args[0], &fd)) return NULL;
  struct pollfd entry = { .fd = fd, .events = POLLIN };
  if (poll(&entry, 1, 0) < 0) return error(env, "poll");
  return number(env, entry.revents);
}
static napi_value recovery_group_exists(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; int pid;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 1) { napi_throw_type_error(env, NULL, "Expected recovery PID"); return NULL; }
  if (recovery_pid(env, args[0], &pid)) return NULL;
  int result = kill(-pid, 0);
  if (result && errno != ESRCH && errno != EPERM) return error(env, "probe recovery group");
  napi_value out; napi_get_boolean(env, !result || errno == EPERM, &out); return out;
}
static napi_value recover_group(napi_env env, napi_callback_info info) {
  size_t count = 2, size; napi_value args[2]; int pid; char saved[64];
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 2) { napi_throw_type_error(env, NULL, "Expected recovery PID and identity"); return NULL; }
  if (recovery_pid(env, args[0], &pid)) return NULL;
  if (napi_get_value_string_utf8(env, args[1], NULL, 0, &size) != napi_ok || !size || size >= sizeof(saved)) {
    napi_throw_type_error(env, NULL, "Invalid recovery identity"); return NULL;
  }
  napi_get_value_string_utf8(env, args[1], saved, sizeof(saved), &size);
  ProcessIdentity current; int status = process_identity(pid, &current);
  const char *result = "absent";
  if (status < 0) { napi_throw_error(env, NULL, "Cannot verify the recorded process identity; nothing was signalled"); return NULL; }
  if (status) {
    char measured[64]; snprintf(measured, sizeof(measured), "%llu:%llu", (unsigned long long)current.start, (unsigned long long)current.fraction);
    if (strlen(saved) != size || strcmp(saved, measured)) result = "mismatch";
    else if (getpgid(pid) != pid) result = "unknown-group";
    else {
      // A confirmed recovery signals only the group of its still-matching
      // recorded session leader. There is no asynchronous gap after this check.
      if (kill(-pid, SIGKILL) && errno != ESRCH) return error(env, "stop recovery group");
      result = "signalled";
    }
  }
  napi_value out; napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &out); return out;
}
static napi_value init(napi_env env, napi_value exports) {
  const struct { const char *name; napi_callback function; } methods[] = {
    {"connect", connect_socket}, {"send", send_frame}, {"receive", receive_frame}, {"close", close_descriptor}, {"readReady", read_ready},
    {"recoveryGroupExists", recovery_group_exists}, {"recoverGroup", recover_group}
  };
  for (size_t i = 0; i < sizeof(methods) / sizeof(methods[0]); i++) {
    napi_value function; napi_create_function(env, methods[i].name, NAPI_AUTO_LENGTH, methods[i].function, NULL, &function);
    napi_set_named_property(env, exports, methods[i].name, function);
  }
  return exports;
}
NAPI_MODULE(aya_pty_owner_bridge, init)
