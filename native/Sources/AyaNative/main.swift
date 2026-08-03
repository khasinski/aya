import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// SwiftPM executables have no bundle; without .regular there is no Dock icon,
// no key window and no working keyboard focus.
app.setActivationPolicy(.regular)
app.run()
