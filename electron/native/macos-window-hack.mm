#include <node_api.h>

#import <Cocoa/Cocoa.h>

namespace {

napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

void ApplyWindowChromeHack(NSWindow *window) {
  if (!window) return;

  NSWindowStyleMask styleMask = [window styleMask];
  styleMask |= NSWindowStyleMaskFullSizeContentView;
  [window setStyleMask:styleMask];
  [window setTitleVisibility:NSWindowTitleHidden];
  [window setTitlebarAppearsTransparent:YES];
  [window setMovableByWindowBackground:NO];

  // Electron/macOS may recreate toolbar chrome around fullscreen transitions.
  // Clearing it here is the part this spike is testing.
  [window setToolbar:nil];

  NSWindowCollectionBehavior behavior = [window collectionBehavior];
  behavior |= NSWindowCollectionBehaviorFullScreenPrimary;
  [window setCollectionBehavior:behavior];
}

napi_value Apply(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) return Undefined(env);

  bool isBuffer = false;
  napi_is_buffer(env, argv[0], &isBuffer);
  if (!isBuffer) return Undefined(env);

  void *bufferData = nullptr;
  size_t bufferLength = 0;
  napi_get_buffer_info(env, argv[0], &bufferData, &bufferLength);
  if (!bufferData || bufferLength < sizeof(void *)) return Undefined(env);

  void *nativeViewPointer = nullptr;
  memcpy(&nativeViewPointer, bufferData, sizeof(nativeViewPointer));
  if (!nativeViewPointer) return Undefined(env);

  NSView *view = (__bridge NSView *)nativeViewPointer;
  NSWindow *window = [view window];
  dispatch_async(dispatch_get_main_queue(), ^{
    ApplyWindowChromeHack(window);
  });

  return Undefined(env);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value apply;
  napi_create_function(env, "apply", NAPI_AUTO_LENGTH, Apply, nullptr, &apply);
  napi_set_named_property(env, exports, "apply", apply);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
