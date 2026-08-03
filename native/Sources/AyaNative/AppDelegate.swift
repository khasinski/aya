import AppKit
import AyaKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var store: SessionStore!
    private var sidebar: SidebarController!
    private let terminalHost = NSView()
    private let statusField = NSTextField(labelWithString: "connecting to host…")

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let env = AyaEnvironment()
        if env.isLiveUserHome {
            let alert = NSAlert()
            alert.messageText = "Refusing to use the live ~/.aya"
            alert.informativeText = "The native experiment must not share the real backend. Set AYA_NATIVE_HOME to a separate directory (default: ~/.aya-native)."
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        store = SessionStore(env: env)
        sidebar = SidebarController(store: store) { [weak self] tab, project in
            self?.show(tab: tab, project: project)
        }

        // NSSplitViewController owns the split layout end to end - the v0
        // hand-rolled NSStackView + NSSplitView mix collapsed to a broken
        // zero-sized window.
        let split = NSSplitViewController()

        let sidebarVC = NSViewController()
        let sidebarScroll = NSScrollView()
        sidebarScroll.documentView = sidebar.tableView
        sidebarScroll.hasVerticalScroller = true
        sidebarScroll.drawsBackground = true
        sidebarVC.view = sidebarScroll

        let terminalVC = NSViewController()
        let rightSide = NSView()
        terminalHost.translatesAutoresizingMaskIntoConstraints = false
        terminalHost.wantsLayer = true
        terminalHost.layer?.backgroundColor = NSColor(calibratedWhite: 0.07, alpha: 1).cgColor
        statusField.translatesAutoresizingMaskIntoConstraints = false
        statusField.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        statusField.textColor = .secondaryLabelColor
        statusField.lineBreakMode = .byTruncatingMiddle
        rightSide.addSubview(terminalHost)
        rightSide.addSubview(statusField)
        NSLayoutConstraint.activate([
            terminalHost.topAnchor.constraint(equalTo: rightSide.topAnchor),
            terminalHost.leadingAnchor.constraint(equalTo: rightSide.leadingAnchor),
            terminalHost.trailingAnchor.constraint(equalTo: rightSide.trailingAnchor),
            statusField.topAnchor.constraint(equalTo: terminalHost.bottomAnchor, constant: 3),
            statusField.leadingAnchor.constraint(equalTo: rightSide.leadingAnchor, constant: 8),
            statusField.trailingAnchor.constraint(lessThanOrEqualTo: rightSide.trailingAnchor, constant: -8),
            statusField.bottomAnchor.constraint(equalTo: rightSide.bottomAnchor, constant: -3),
        ])
        terminalVC.view = rightSide

        let sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebarVC)
        sidebarItem.minimumThickness = 180
        sidebarItem.maximumThickness = 360
        sidebarItem.canCollapse = false
        split.addSplitViewItem(sidebarItem)
        let terminalItem = NSSplitViewItem(viewController: terminalVC)
        terminalItem.minimumThickness = 400
        split.addSplitViewItem(terminalItem)

        window = NSWindow(contentViewController: split)
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.title = "Aya Native (experiment)"
        window.setContentSize(NSSize(width: 1180, height: 760))
        window.center()
        window.setFrameAutosaveName("AyaNativeMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        store.onStatus = { [weak self] text in self?.statusField.stringValue = text }
        store.start()
        sidebar.reload()

        if let project = store.projects.first, let tab = project.tabs.first {
            sidebar.select(tabId: tab.id)
            show(tab: tab, project: project)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func show(tab: AyaTab, project: AyaProject) {
        let pane = store.pane(for: tab, in: project)
        if terminalHost.subviews.first === pane {
            window.makeFirstResponder(pane.terminalView)
            return
        }
        terminalHost.subviews.forEach { $0.removeFromSuperview() }
        pane.translatesAutoresizingMaskIntoConstraints = false
        terminalHost.addSubview(pane)
        NSLayoutConstraint.activate([
            pane.topAnchor.constraint(equalTo: terminalHost.topAnchor),
            pane.bottomAnchor.constraint(equalTo: terminalHost.bottomAnchor),
            pane.leadingAnchor.constraint(equalTo: terminalHost.leadingAnchor),
            pane.trailingAnchor.constraint(equalTo: terminalHost.trailingAnchor),
        ])
        window.title = "\(project.name) — \(tab.name)"
        window.makeFirstResponder(pane.terminalView)
    }

    /// Minimal main menu: quit, and a standard Edit menu so copy/paste reach
    /// SwiftTerm through the responder chain.
    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Aya Native", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        NSApp.mainMenu = main
    }
}
