import AppKit
import AyaKit

/// Flat sidebar: a non-selectable header row per project, an indented row per
/// tab. NSTableView over NSOutlineView - the model is two levels deep and
/// static in v0.
final class SidebarController: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    private enum Row {
        case project(AyaProject)
        case tab(AyaTab, AyaProject)
    }

    let tableView = NSTableView()
    private var rows: [Row] = []
    private let store: SessionStore
    private let onSelect: (AyaTab, AyaProject) -> Void

    init(store: SessionStore, onSelect: @escaping (AyaTab, AyaProject) -> Void) {
        self.store = store
        self.onSelect = onSelect
        super.init()

        let column = NSTableColumn(identifier: .init("main"))
        column.resizingMask = .autoresizingMask
        tableView.addTableColumn(column)
        tableView.headerView = nil
        tableView.rowHeight = 26
        tableView.style = .sourceList
        tableView.dataSource = self
        tableView.delegate = self
        tableView.target = self
        tableView.action = #selector(rowClicked)
    }

    func reload() {
        rows = store.projects.flatMap { project -> [Row] in
            [.project(project)] + project.tabs.map { .tab($0, project) }
        }
        tableView.reloadData()
    }

    func select(tabId: String) {
        guard let index = rows.firstIndex(where: {
            if case .tab(let tab, _) = $0 { return tab.id == tabId }
            return false
        }) else { return }
        tableView.selectRowIndexes([index], byExtendingSelection: false)
    }

    @objc private func rowClicked() {
        let row = tableView.clickedRow >= 0 ? tableView.clickedRow : tableView.selectedRow
        guard row >= 0, case .tab(let tab, let project) = rows[row] else { return }
        onSelect(tab, project)
    }

    // MARK: - NSTableViewDataSource / Delegate

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if case .tab = rows[row] { return true }
        return false
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let field: NSTextField
        switch rows[row] {
        case .project(let project):
            field = NSTextField(labelWithString: project.name.uppercased())
            field.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
            field.textColor = .secondaryLabelColor
        case .tab(let tab, _):
            field = NSTextField(labelWithString: "  \(tab.name)")
            field.font = NSFont.systemFont(ofSize: 13)
        }
        let cell = NSTableCellView()
        cell.addSubview(field)
        field.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
            field.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -4),
            field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        rowClicked()
    }
}
