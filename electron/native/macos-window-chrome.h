#pragma once
#import <Cocoa/Cocoa.h>

// Full-size content does not remove the native title bar's hit-test surface.
// Aya draws its own controls, so fullscreen must have no native title bar for
// AppKit to reveal over the tab strip when the system menu is shown.
inline NSWindowStyleMask AyaWindowChromeStyleMask(NSWindowStyleMask current) {
  NSWindowStyleMask result = current | NSWindowStyleMaskFullSizeContentView;
  if (current & NSWindowStyleMaskFullScreen) {
    result &= ~NSWindowStyleMaskTitled;
  } else {
    result |= NSWindowStyleMaskTitled;
  }
  return result;
}
