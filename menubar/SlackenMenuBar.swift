//
//  Slacken's menu bar item.
//
//  This program draws a menu and reports clicks. It decides nothing: the
//  wording, the counts and which actions exist all arrive as JSON from the
//  daemon on 127.0.0.1, which is where that logic can be tested. Keeping the
//  Swift dumb is the point — the only part of Slacken that needs a Mac with a
//  screen to exercise should be the part with nothing in it worth exercising.
//
//  Built on demand by src/menubar.js:
//      swiftc -O -o SlackenMenuBar SlackenMenuBar.swift
//      ./SlackenMenuBar --port 8787
//
//  It exits when stdin closes, so it can never outlive the daemon that
//  spawned it, even if that daemon is killed outright.
//

import AppKit
import Foundation

// MARK: - What the daemon sends

struct MenuItemSpec: Decodable {
    var label: String? = nil
    var separator: Bool? = nil
    var enabled: Bool? = nil
    var key: String? = nil
    var post: String? = nil
    /// Sent as the body of the POST. Decoded as raw JSON and passed straight
    /// through: what a setting is worth is the daemon's business, not ours.
    var body: AnyJSON? = nil
    var open: String? = nil
    var quit: Bool? = nil
    /// Drawn with a checkmark. A settings item is told whether it is the one
    /// in force; it never works that out for itself.
    var checked: Bool? = nil
    var submenu: [MenuItemSpec]? = nil
}

/// Just enough of a JSON value to carry a settings body from the daemon back
/// to it untouched.
enum AnyJSON: Decodable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([AnyJSON])
    case object([String: AnyJSON])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let v = try? container.decode(Bool.self) { self = .bool(v) }
        else if let v = try? container.decode(Double.self) { self = .number(v) }
        else if let v = try? container.decode(String.self) { self = .string(v) }
        else if let v = try? container.decode([AnyJSON].self) { self = .array(v) }
        else if let v = try? container.decode([String: AnyJSON].self) { self = .object(v) }
        else { self = .null }
    }

    var value: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let v): return v
        case .number(let v): return v == v.rounded() && abs(v) < 1e15 ? Int(v) : v
        case .string(let v): return v
        case .array(let v): return v.map { $0.value }
        case .object(let v): return v.mapValues { $0.value }
        }
    }
}

struct MenuSpec: Decodable {
    var icon: String? = nil
    var fallback: String? = nil
    var tooltip: String? = nil
    var dimmed: Bool? = nil
    var items: [MenuItemSpec]? = nil
}

/// Shown when the daemon cannot be reached — during a restart, or because it
/// stopped without taking us with it.
private let offlineSpec = MenuSpec(
    icon: "exclamationmark.triangle",
    fallback: "Slacken ?",
    tooltip: "Slacken — not responding",
    dimmed: true,
    items: [
        MenuItemSpec(label: "Slacken is not responding", enabled: false),
        MenuItemSpec(separator: true),
        MenuItemSpec(label: "Hide menu bar item", quit: true),
    ]
)

// MARK: - Controller

final class Controller: NSObject, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let origin: String
    private let session: URLSession
    private var timer: Timer?
    /// Counted rather than flagged: a submenu closing while its parent is
    /// still open must not let the menu be rebuilt under the pointer.
    private var openMenus = 0

    init(port: Int) {
        self.origin = "http://127.0.0.1:\(port)"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: configuration)
        super.init()

        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
        apply(offlineSpec)

        refresh()
        let timer = Timer(timeInterval: 2.0, repeats: true) { [weak self] _ in self?.refresh() }
        // .common so the menu bar being held open does not stop the clock.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func url(_ path: String) -> URL? {
        URL(string: origin + (path.hasPrefix("/") ? path : "/" + path))
    }

    // MARK: Polling

    private func refresh() {
        guard let endpoint = url("/menubar") else { return }
        session.dataTask(with: endpoint) { [weak self] data, _, _ in
            guard let self = self else { return }
            let spec = data.flatMap { try? JSONDecoder().decode(MenuSpec.self, from: $0) }
            DispatchQueue.main.async { self.apply(spec ?? offlineSpec) }
        }.resume()
    }

    /// Rebuilding the menu under an open one would move the item the pointer is
    /// already on, so an open menu is left alone. The icon still updates: that
    /// is the part you can see without clicking.
    private func apply(_ spec: MenuSpec) {
        applyIcon(spec)
        guard openMenus == 0 else { return }
        menu.removeAllItems()
        for item in spec.items ?? [] {
            menu.addItem(build(item))
        }
    }

    private func applyIcon(_ spec: MenuSpec) {
        guard let button = statusItem.button else { return }
        button.toolTip = spec.tooltip
        button.appearsDisabled = spec.dimmed ?? false

        if #available(macOS 11.0, *), let name = spec.icon,
           let image = NSImage(systemSymbolName: name, accessibilityDescription: "Slacken") {
            image.isTemplate = true
            button.image = image
            button.title = ""
            return
        }
        button.image = nil
        button.title = spec.fallback ?? "Slacken"
    }

    private func build(_ spec: MenuItemSpec) -> NSMenuItem {
        if spec.separator == true { return NSMenuItem.separator() }

        let item = NSMenuItem(title: spec.label ?? "", action: nil, keyEquivalent: spec.key ?? "")
        item.state = spec.checked == true ? .on : .off

        if let children = spec.submenu {
            let submenu = NSMenu()
            submenu.autoenablesItems = false
            // Delegated too, so opening a submenu counts as the menu being
            // open and a refresh cannot rebuild it out from under the pointer.
            submenu.delegate = self
            for child in children { submenu.addItem(build(child)) }
            item.submenu = submenu
            return item
        }

        let clickable = spec.post != nil || spec.open != nil || spec.quit == true
        if clickable {
            item.action = #selector(clicked(_:))
            item.target = self
            item.representedObject = spec
            return item
        }

        // A line of status is not something you can click, but it still has to
        // be legible: a plain disabled item greys into the background, so it is
        // drawn deliberately instead, one size down and in the secondary colour.
        item.isEnabled = false
        item.attributedTitle = NSAttributedString(
            string: spec.label ?? "",
            attributes: [
                .font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]
        )
        return item
    }

    // MARK: Actions

    @objc private func clicked(_ sender: NSMenuItem) {
        guard let spec = sender.representedObject as? MenuItemSpec else { return }

        if spec.quit == true {
            NSApp.terminate(nil)
            return
        }
        if let file = spec.open {
            NSWorkspace.shared.open(URL(fileURLWithPath: file))
            return
        }
        guard let path = spec.post, let endpoint = url(path) else { return }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        if let body = spec.body,
           let encoded = try? JSONSerialization.data(withJSONObject: body.value, options: []) {
            request.httpBody = encoded
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else {
            request.httpBody = Data()
        }
        session.dataTask(with: request) { [weak self] _, _, _ in
            // Draw the result of the click rather than assuming it, so the menu
            // can never disagree with the daemon about what actually happened.
            DispatchQueue.main.async { self?.refresh() }
        }.resume()
    }

    // MARK: NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        openMenus += 1
    }

    func menuDidClose(_ menu: NSMenu) {
        openMenus = max(0, openMenus - 1)
        // Only once the whole stack is closed: redrawing on a submenu closing
        // would move the item the pointer is still resting on.
        if openMenus == 0 { refresh() }
    }
}

// MARK: - Entry point

func parsePort() -> Int {
    let args = CommandLine.arguments
    for (index, arg) in args.enumerated() where arg == "--port" && index + 1 < args.count {
        if let port = Int(args[index + 1]) { return port }
    }
    return 8787
}

/// stdin is how the daemon holds our leash. Nothing is ever written to it; the
/// end of the pipe means the daemon is gone, and so should we be.
func exitWhenParentGoesAway() {
    FileHandle.standardInput.readabilityHandler = { handle in
        if handle.availableData.isEmpty {
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

var controller: Controller?

let app = NSApplication.shared
// Accessory: a menu bar item, with no Dock tile and no menu bar of its own.
_ = app.setActivationPolicy(.accessory)
controller = Controller(port: parsePort())
exitWhenParentGoesAway()
app.run()
