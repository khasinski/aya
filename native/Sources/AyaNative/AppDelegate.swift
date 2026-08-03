import AppKit
import AyaKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var store: SessionStore!
    private var sidebar: SidebarController!
    private let terminalContainer = NSView()
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

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Aya Native (experiment)"
        window.center()
        window.setFrameAutosaveName("AyaNativeMain")

        let split = NSSplitView()
        split.isVertical = true
        split.dividerStyle = .thin

        let sidebarScroll = NSScrollView()
        sidebarScroll.documentView = sidebar.tableView
        sidebarScroll.hasVerticalScroller = true
        sidebarScroll.widthAnchor.constraint(greaterThanOrEqualToConstant: 200).isActive = true

        terminalContainer.wantsLayer = true
        terminalContainer.layer?.backgroundColor = NSColor.black.cgColor

        split.addArrangedSubview(sidebarScroll)
        split.addArrangedSubview(terminalContainer)
        split.setHoldingPriority(.defaultHigh, forSubviewAt: 0)

        statusField.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        statusField.textColor = .secondaryLabelColor
        statusField.lineBreakMode = .byTruncatingMiddle

        let root = NSStackView(views: [split, statusField])
        root.orientation = .vertical
        root.spacing = 4
        root.edgeInsets = NSEdgeInsets(top: 0, left: 0, bottom: 4, right: 8)
        root.distribution = .fill
        split.setContentHuggingPriority(.defaultLow, for: .vertical)

        window.contentView = root
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        store.onStatus = { [weak self] text in self?.statusField.stringValue = text }
        store.start()
        sidebar.reload()

        // Open the first tab so the tester lands in a live terminal, not an
        // empty pane.
        if let project = store.projects.first, let tab = project.tabs.first {
            sidebar.select(tabId: tab.id)
            show(tab: tab, project: project)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func show(tab: AyaTab, project: AyaProject) {
        let pane = store.pane(for: tab, in: project)
        guard pane.superview !== terminalContainer || terminalContainer.subviews.first !== pane else {
            window.makeFirstResponder(pane.terminalView)
            return
        }
        terminalContainer.subviews.forEach { $0.removeFromSuperview() }
        pane.frame = terminalContainer.bounds
        pane.autoresizingMask = [.width, .height]
        terminalContainer.addSubview(pane)
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
