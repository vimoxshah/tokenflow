//  TokenFlowBar — TokenFlow's native macOS menu bar application.
//
//  Reads $TOKENFLOW_HOME/data/status.json (written by `tokenflow watch`) and
//  renders an adaptive status item plus a rich native dropdown: today/week/
//  month usage, per-provider breakdown, declared limits with live meters and
//  reset countdowns, forecast, anomaly alerts, and actions.
//
//  Everything is local. Nothing leaves the machine.
//
//  Design language: Apple-native. System fonts with monospaced digits for all
//  figures, SF Symbols for actions, semantic state colors (green/orange/red),
//  small-caps section headers, hairline separators. Dark/light follows the
//  system appearance automatically.

import AppKit

// ============================================================ data model ===

struct TFStatus: Decodable {
    struct Tokens: Decodable { var total: Double? }
    struct UsageSlice: Decodable {
        var tokens: Tokens?
        var requests: Double?
        var cost: Double?
        var costMeasured: Double?
        var sessions: Int?
    }
    struct ProviderRow: Decodable {
        var key: String
        var tokens: Double?
        var requests: Double?
        var cost: Double?
        var costMeasured: Double?
    }
    struct LimitState: Decodable {
        var id: String?
        var label: String?
        var scope: String?
        var metric: String?
        var used: Double?
        var cap: Double?
        var remaining: Double?
        var pctUsed: Double?
        var status: String?
        var etaHours: Double?
        var etaVia: String?
        var resetsInMs: Double?
    }
    struct CapacitySummary: Decodable {
        var anyExceeded: Bool?
        var anyWarn: Bool?
        var worst: LimitState?
        var firstToHit: LimitState?
        var counts: [String: Int]?
    }
    struct Capacity: Decodable {
        var summary: CapacitySummary?
        var states: [LimitState]?
        var invalidCount: Int?
    }
    struct Forecast: Decodable {
        var tomorrow: Double?
        var next7days: Double?
        var next7daysCost: Double?
        var monthEnd: Double?
        var monthEndCost: Double?
        var confidence: String?
        var n: Int?
    }
    struct Anomaly: Decodable {
        var id: String?
        var type: String?
        var date: String?
        var severity: String?
        var detail: String?
    }
    struct Freshness: Decodable {
        var lastRefresh: String?
        var ageMs: Double?
        var staleAfterMs: Double?
        var stale: Bool?
    }
    struct Watcher: Decodable {
        var pid: Int?
        var mode: String?
        var intervalSeconds: Double?
        var cycles: Int?
    }
    struct LastError: Decodable { var message: String?; var at: String? }
    struct Health: Decodable { var records: Int?; var grade: String? }

    var generatedAt: String?
    var demo: Bool?
    var usage: [String: UsageSlice]?
    var providersToday: [ProviderRow]?
    var capacity: Capacity?
    var forecast: Forecast?
    var anomalies: [Anomaly]?
    var freshness: Freshness?
    var watcher: Watcher?
    var lastError: LastError?
    var health: Health?

    var lastRefreshDate: Date? {
        guard let iso = freshness?.lastRefresh else { return nil }
        return parseISO(iso)
    }
}

func parseISO(_ s: String?) -> Date? {
    guard let s else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = fractional.date(from: s) { return d }
    let plain = ISO8601DateFormatter()
    return plain.date(from: s)
}

// ========================================================== status loading ==

enum Paths {
    static let envHome = ProcessInfo.processInfo.environment["TOKENFLOW_HOME"]
    static var home: String {
        if let envHome { return envHome }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".tokenflow", isDirectory: true).path
    }
    static var statusFile: String { home + "/data/status.json" }
    static var configFile: String { home + "/config.yaml" }
    static var dashboardPort: Int {
        // Same value the dashboard reads; a regex over one well-known line is
        // enough and keeps this app free of a YAML parser.
        if let text = try? String(contentsOfFile: configFile, encoding: .utf8),
           let range = text.range(of: #"(?m)^\s*port:\s*(\d{2,5})"#, options: .regularExpression) {
            let digits = text[range].compactMap { $0.isNumber ? Character(String($0)) : nil }
            if let port = Int(String(digits)), (1024..<65536).contains(port) { return port }
        }
        return 7799
    }
    /// Embedded into Info.plist by scripts/build-menubar-app.sh.
    static var embeddedCLI: String? {
        Bundle.main.object(forInfoDictionaryKey: "TokenFlowCLIPath") as? String
    }
    static var embeddedNode: String? {
        Bundle.main.object(forInfoDictionaryKey: "TokenFlowNodePath") as? String
    }
    static var cliPath: String {
        if let e = embeddedCLI, FileManager.default.fileExists(atPath: e) { return e }
        return "/usr/local/bin/tokenflow"
    }
    static var nodePath: String {
        if let e = embeddedNode, FileManager.default.fileExists(atPath: e) { return e }
        return "/usr/bin/env"
    }
}

func loadStatus() -> TFStatus? {
    guard let data = FileManager.default.contents(atPath: Paths.statusFile) else { return nil }
    return try? JSONDecoder().decode(TFStatus.self, from: data)
}

func processAlive(_ pid: Int?) -> Bool {
    guard let pid, pid > 1 else { return false }
    if kill(pid_t(pid), 0) == 0 { return true }
    return errno != ESRCH
}

// ============================================================ formatting ====

func compactTokens(_ n: Double?) -> String {
    guard let n, n.isFinite else { return "—" }
    let sign = n < 0 ? "-" : ""
    let v = abs(n)
    func q(_ divisor: Double, _ suffix: String) -> String {
        let x = v / divisor
        let digits = x >= 100 ? 0 : (x >= 10 ? 1 : 2)
        var s = String(format: "%.\(digits)f", x)
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        return sign + s + suffix
    }
    if v >= 1e12 { return q(1e12, "T") }
    if v >= 1e9 { return q(1e9, "B") }
    if v >= 1e6 { return q(1e6, "M") }
    if v >= 1e3 { return q(1e3, "K") }
    if v.rounded() == v { return sign + String(Int(v)) }
    return sign + String(format: "%.1f", v)
}

func money(_ n: Double?) -> String {
    guard let n, n.isFinite else { return "—" }
    let sign = n < 0 ? "-" : ""
    let a = abs(n)
    if a >= 1000 { return "\(sign)$\(String(format: "%.1f", a / 1000))K" }
    if a >= 100 { return "\(sign)$\(String(format: "%.0f", a))" }
    return "\(sign)$\(String(format: "%.2f", a))"
}

func countdown(_ ms: Double?) -> String {
    guard let ms, ms.isFinite, ms >= 0 else { return "—" }
    let sec = Int((ms / 1000).rounded())
    if sec < 60 { return "\(sec)s" }
    let m = sec / 60
    if m < 60 { return "\(m)m" }
    let h = m / 60
    if h < 48 { return m % 60 > 0 ? "\(h)h \(m % 60)m" : "\(h)h" }
    let d = h / 24
    return h % 24 > 0 ? "\(d)d \(h % 24)h" : "\(d)d"
}

func relativeAge(_ msAgo: Double?) -> String {
    guard let msAgo else { return "never" }
    if msAgo < 45_000 { return "just now" }
    let min = Int(msAgo / 60_000)
    if min < 60 { return "\(min) min ago" }
    let hr = min / 60
    if hr < 24 { return "\(hr)h ago" }
    return "\(hr / 24)d ago"
}

private let numFont = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .regular)

/// Two/three-column attributed row aligned with tab stops — the classic,
/// fully native way to get tidy columns inside NSMenu items.
func tableRow(label: String, mid: String?, right: String,
              labelColor: NSColor = .labelColor,
              valueColor: NSColor? = nil,
              font: NSFont = .systemFont(ofSize: 13)) -> NSAttributedString {
    let para = NSMutableParagraphStyle()
    para.tabStops = [
        NSTextTab(textAlignment: .left, location: 128, options: [:]),
        NSTextTab(textAlignment: .right, location: 388, options: [:]),
    ]
    let text = label + (mid.map { "\t\($0)" } ?? "") + "\t\(right)"
    let out = NSMutableAttributedString(string: text, attributes: [
        .font: font, .foregroundColor: labelColor, .paragraphStyle: para,
    ])
    if !right.isEmpty, let range = text.range(of: right, options: .backwards) {
        out.addAttributes([.font: numFont, .foregroundColor: valueColor ?? labelColor],
                          range: NSRange(range, in: text))
    }
    return out
}

// ============================================================= meter view ===

final class MeterView: NSView {
    let fraction: CGFloat
    let tint: NSColor

    init(fraction: CGFloat, tint: NSColor) {
        self.fraction = min(1, max(0, fraction))
        self.tint = tint
        super.init(frame: NSRect(x: 0, y: 0, width: 110, height: 9))
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.separatorColor.withAlphaComponent(0.5).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 4.5, yRadius: 4.5).fill()
        guard fraction > 0.001 else { return }
        let w = max(6, bounds.width * fraction)
        tint.setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: w, height: bounds.height),
                     xRadius: 4.5, yRadius: 4.5).fill()
    }
}

/// One capacity row as a custom menu-item view:
///   ✓ label            [meter]   42%    resets 3d 4h
final class LimitRowView: NSView {
    init(state: TFStatus.LimitState) {
        super.init(frame: NSRect(x: 0, y: 0, width: 430, height: 26))
        wantsLayer = true

        let st = state.status ?? "unknown"
        let tint: NSColor = st == "exceeded" ? .systemRed : st == "warn" ? .systemOrange : .systemGreen
        let glyph = st == "exceeded" ? "✗" : st == "warn" ? "⚠" : "✓"
        let name = state.label ?? state.id ?? "limit"

        let nameField = NSTextField(labelWithString: "\(glyph) \(name)")
        nameField.font = .systemFont(ofSize: 12.5, weight: .medium)
        nameField.textColor = .labelColor
        nameField.lineBreakMode = .byTruncatingTail
        nameField.frame = NSRect(x: 16, y: 5.5, width: 150, height: 15)
        addSubview(nameField)

        let meter = MeterView(fraction: CGFloat(state.pctUsed ?? 0), tint: tint)
        meter.frame.origin = NSPoint(x: 170, y: 8.5)
        addSubview(meter)

        let pctText = state.pctUsed.map { $0 >= 10 ? "\(Int($0))×" : "\(Int(($0 * 100).rounded()))%" } ?? "—"
        let pctField = NSTextField(labelWithString: pctText)
        pctField.font = numFont
        pctField.textColor = st == "ok" ? .secondaryLabelColor : tint
        pctField.alignment = .right
        pctField.frame = NSRect(x: 284, y: 5.5, width: 48, height: 15)
        addSubview(pctField)

        var tail = "resets \(countdown(state.resetsInMs))"
        if let eta = state.etaHours, st != "exceeded" {
            tail = "ETA \(countdown(eta * 3600_000)) · " + tail
        }
        let tailField = NSTextField(labelWithString: tail)
        tailField.font = NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
        tailField.textColor = .secondaryLabelColor
        tailField.alignment = .right
        tailField.lineBreakMode = .byTruncatingHead
        tailField.frame = NSRect(x: 334, y: 6.5, width: 92, height: 14)
        addSubview(tailField)
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }
}

// ============================================================== app delegate =

@objc final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var status: TFStatus?
    private var refreshing = false

    // ---------------------------------------------------------- lifecycle --

    func applicationDidFinishLaunching(_ notification: Notification) {
        item.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        item.button?.toolTip = "TokenFlow — AI usage & capacity"
        menu.autoenablesItems = false
        menu.delegate = self
        item.menu = menu
        reloadAndRender()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            self?.reloadAndRenderTitleOnly()
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    private func reloadAndRender() {
        status = loadStatus()
        rebuildMenu()
        renderTitle()
    }

    private func reloadAndRenderTitleOnly() {
        status = loadStatus()
        renderTitle()
    }

    // ------------------------------------------------------- status title --

    private var watcherRunning: Bool { processAlive(status?.watcher?.pid) }

    /// Adaptive headline: worst limit when configured, else today's cost when
    /// priced, else today's tokens — mirroring `status --bar`.
    private func headlineValue() -> (text: String, kind: String)? {
        guard let s = status, let today = s.usage?["today"],
              let tokens = today.tokens?.total, (s.health?.records ?? 0) > 0 else { return nil }
        if let worst = s.capacity?.summary?.worst, let pct = worst.pctUsed {
            switch worst.status {
            case "exceeded": return ("\(Int((pct * 100).rounded()))%", "exceeded")
            case "warn": return ("\(Int((pct * 100).rounded()))%", "warn")
            case "ok":
                if pct >= 0.02 { return ("\(Int((pct * 100).rounded()))%", "ok") }
            default: break
            }
        }
        if let cost = today.cost ?? today.costMeasured { return (money(cost), "cost") }
        return (compactTokens(tokens), "tokens")
    }

    private func renderTitle() {
        guard let button = item.button else { return }
        let base: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.labelColor,
        ]
        if refreshing {
            button.attributedTitle = NSAttributedString(string: "TF ⟳", attributes: base)
            return
        }
        guard let head = headlineValue() else {
            button.attributedTitle = NSAttributedString(string: "TF", attributes: base)
            return
        }
        let tint: NSColor
        let prefix: String
        switch head.kind {
        case "exceeded": tint = .systemRed; prefix = "✗ "
        case "warn": tint = .systemOrange; prefix = "▲ "
        case "ok": tint = .systemGreen; prefix = "● "
        default: tint = .labelColor; prefix = ""
        }
        let out = NSMutableAttributedString(
            string: (prefix.isEmpty ? "" : prefix + " ") + head.text, attributes: base)
        if !prefix.isEmpty {
            out.addAttribute(.foregroundColor, value: tint, range: NSRange(location: 0, length: prefix.count))
        }
        button.attributedTitle = out
    }

    // ------------------------------------------------------------ the menu --

    func menuNeedsUpdate(_ menu: NSMenu) {
        status = loadStatus()
        rebuildMenu()
    }

    private func sectionHeader(_ title: String) -> NSMenuItem {
        let it = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        it.attributedTitle = NSAttributedString(
            string: title.uppercased(),
            attributes: [
                .font: NSFont.systemFont(ofSize: 10.5, weight: .bold),
                .foregroundColor: NSColor.secondaryLabelColor,
                .kern: NSNumber(value: 0.6),
            ])
        it.isEnabled = false
        return it
    }

    private func noteItem(_ text: String, color: NSColor = .secondaryLabelColor, size: CGFloat = 11) -> NSMenuItem {
        let it = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        it.attributedTitle = NSAttributedString(
            string: text,
            attributes: [.font: NSFont.systemFont(ofSize: size), .foregroundColor: color])
        it.isEnabled = false
        return it
    }

    private func actionItem(_ title: String, key: String = "", symbol: String? = nil,
                            handler: @escaping () -> Void) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
        it.target = self
        it.representedObject = handler
        if let symbol {
            let cfg = NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)
            it.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)?
                .withSymbolConfiguration(cfg)
        }
        return it
    }

    @objc private func menuAction(_ sender: NSMenuItem) {
        (sender.representedObject as? (() -> Void))?()
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        // ---- header --------------------------------------------------------
        let fresh = status?.freshness
        let stale = fresh?.stale ?? true
        let snapshotAge: Double? = {
            guard let gen = status?.generatedAt, let t = parseISO(gen) else { return nil }
            return Date().timeIntervalSince(t) * 1000
        }()
        let updated = relativeAge(status?.lastRefreshDate.map { Date().timeIntervalSince($0) * 1000 } ?? snapshotAge)
        let badge = watcherRunning ? "live" : "watcher off"

        let header = NSMutableAttributedString(
            string: "TokenFlow",
            attributes: [.font: NSFont.systemFont(ofSize: 13.5, weight: .bold),
                         .foregroundColor: NSColor.labelColor])
        if status?.demo == true {
            header.append(NSAttributedString(
                string: "  [DEMO DATA]",
                attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                             .foregroundColor: NSColor.systemRed]))
        }
        let headerItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        headerItem.attributedTitle = header
        headerItem.isEnabled = false
        menu.addItem(headerItem)

        let subColor: NSColor = stale ? .systemOrange : .systemGreen
        let subItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        subItem.attributedTitle = NSAttributedString(
            string: "\(badge) · data \(stale ? "stale" : "updated") \(updated)",
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .regular),
                         .foregroundColor: subColor])
        subItem.isEnabled = false
        menu.addItem(subItem)
        menu.addItem(.separator())

        // ---- usage ----------------------------------------------------------
        guard let s = status, let today = s.usage?["today"], (s.health?.records ?? 0) > 0 else {
            menu.addItem(noteItem("No usage data yet.", color: .labelColor, size: 12.5))
            menu.addItem(actionItem("Run tokenflow setup…", symbol: "wand.and.stars") { [weak self] in
                self?.runCLI(["setup"])
            })
            menu.addItem(.separator())
            menu.addItem(actionItem("Quit TokenFlow", key: "q", symbol: "power") {
                NSApp.terminate(nil)
            })
            return
        }

        func usageRow(_ name: String, _ slice: TFStatus.UsageSlice?) -> NSMenuItem {
            guard let u = slice else { return NSMenuItem(title: name, action: nil, keyEquivalent: "") }
            let cost = u.cost ?? u.costMeasured
            let it = NSMenuItem(title: name, action: nil, keyEquivalent: "")
            it.attributedTitle = tableRow(
                label: name,
                mid: "\(compactTokens(u.tokens?.total ?? 0)) tok · \(Int(u.requests ?? 0)) req",
                right: cost.map(money) ?? "—",
                valueColor: cost != nil ? NSColor.labelColor : NSColor.secondaryLabelColor)
            it.isEnabled = false
            return it
        }
        menu.addItem(usageRow("Today", today))
        menu.addItem(usageRow("Week", s.usage?["weekToDate"]))
        menu.addItem(usageRow("Month", s.usage?["monthToDate"]))

        // ---- providers today -------------------------------------------------
        if let provs = s.providersToday, !provs.isEmpty {
            menu.addItem(.separator())
            menu.addItem(sectionHeader("Today by provider"))
            let total = provs.compactMap(\.tokens).reduce(0, +)
            for p in provs.prefix(5) {
                let tokens = p.tokens ?? 0
                let share = total > 0 ? tokens / total : 0
                let filled = min(8, max(tokens > 0 ? 1 : 0, Int((share * 8).rounded())))
                let bar = String(repeating: "▰", count: filled) + String(repeating: "▱", count: 8 - filled)
                let cost = p.cost ?? p.costMeasured
                let it = NSMenuItem(title: p.key, action: nil, keyEquivalent: "")
                it.attributedTitle = tableRow(
                    label: "  \(bar)  \(p.key)",
                    mid: compactTokens(tokens),
                    right: cost.map(money) ?? "",
                    valueColor: cost != nil ? NSColor.labelColor : NSColor.secondaryLabelColor,
                    font: .systemFont(ofSize: 12.5))
                it.isEnabled = false
                menu.addItem(it)
            }
        }

        // ---- capacity ---------------------------------------------------------
        let states = s.capacity?.states ?? []
        menu.addItem(.separator())
        if !states.isEmpty {
            menu.addItem(sectionHeader("Capacity"))
            for st in states.prefix(5) {
                let row = NSMenuItem(title: "", action: nil, keyEquivalent: "")
                row.view = LimitRowView(state: st)
                row.isEnabled = false
                menu.addItem(row)
            }
            if let hit = s.capacity?.summary?.firstToHit, let eta = hit.etaHours {
                menu.addItem(noteItem("First projected hit: \(hit.label ?? "?") in \(countdown(eta * 3600_000))"))
            }
        } else {
            menu.addItem(sectionHeader("Capacity"))
            menu.addItem(noteItem("No limits configured — set budgets in the Live tab."))
        }

        // ---- forecast -----------------------------------------------------------
        if let f = s.forecast, let tomorrow = f.tomorrow {
            menu.addItem(.separator())
            menu.addItem(sectionHeader("Forecast"))
            var line = "Tomorrow ≈ \(compactTokens(tomorrow))"
            if let week = f.next7days { line += "  ·  7d ≈ \(compactTokens(week))" }
            let it = NSMenuItem(title: "", action: nil, keyEquivalent: "")
            it.attributedTitle = tableRow(
                label: line, mid: nil,
                right: f.monthEndCost.map { "≈ \(money($0)) mo-end" } ?? "",
                font: .systemFont(ofSize: 12.5))
            it.isEnabled = false
            menu.addItem(it)
            menu.addItem(noteItem("Confidence: \(f.confidence ?? "?")\(f.n.map { " (\($0)-day trend)" } ?? "")"))
        }

        // ---- alerts ---------------------------------------------------------------
        let highs = (s.anomalies ?? []).filter { $0.severity == "high" }.prefix(2)
        if highs.count > 0 {
            menu.addItem(.separator())
            menu.addItem(sectionHeader("Alerts"))
            for a in highs {
                menu.addItem(noteItem("‼️ \((a.date ?? "")) — \((a.detail ?? "").replacingOccurrences(of: "\n", with: " "))", size: 11))
            }
        }
        if let err = s.lastError?.message {
            menu.addItem(noteItem("⚠︎ Watcher error: \(err)", color: .systemOrange, size: 11))
        }

        // ---- actions ------------------------------------------------------------------
        menu.addItem(.separator())
        let refresh: NSMenuItem = actionItem(refreshing ? "Refreshing…" : "Refresh now",
                                             key: "r", symbol: "arrow.clockwise") { [weak self] in
            self?.refreshNow()
        }
        refresh.keyEquivalentModifierMask = NSEvent.ModifierFlags([.command])
        menu.addItem(refresh)
        menu.addItem(actionItem("Open Dashboard", symbol: "macwindow") { [weak self] in
            self?.openDashboard()
        })
        if watcherRunning {
            menu.addItem(actionItem("Stop watcher", symbol: "stop.circle") { [weak self] in
                self?.runCLI(["watch", "--stop"])
                self?.reloadSoon()
            })
        } else {
            menu.addItem(actionItem("Start watcher", symbol: "play.circle") { [weak self] in
                self?.startWatcherDetached()
                self?.reloadSoon()
            })
        }
        menu.addItem(.separator())
        menu.addItem(actionItem("Quit TokenFlow", key: "q", symbol: "power") {
            NSApp.terminate(nil)
        })
    }

    // -------------------------------------------------------------- actions --

    /// `node <cli> <args>` — direct exec, no shell quoting involved.
    private func nodeProcess(_ args: [String], detached: Bool) -> Process? {
        let node = Paths.nodePath
        guard FileManager.default.fileExists(atPath: node) || node == "/usr/bin/env",
              FileManager.default.fileExists(atPath: Paths.cliPath) else { return nil }
        let proc = Process()
        if node == "/usr/bin/env" {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", Paths.cliPath] + args
        } else {
            proc.executableURL = URL(fileURLWithPath: node)
            proc.arguments = [Paths.cliPath] + args
        }
        if detached {
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
        }
        return proc
    }

    private func runCLI(_ args: [String]) {
        guard !refreshing else { return }
        guard let proc = nodeProcess(args, detached: false) else { return }
        refreshing = true
        renderTitle()
        rebuildMenu()
        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.refreshing = false
                self?.reloadAndRender()
            }
        }
        do { try proc.run() } catch { refreshing = false; reloadAndRender() }
    }

    /// Children survive parent exit on Unix; null stdio keeps them quiet.
    private func startWatcherDetached() {
        guard let proc = nodeProcess(["watch"], detached: true) else { return }
        try? proc.run()
    }

    private func refreshNow() { runCLI(["watch", "--once"]) }

    private func reloadSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.reloadAndRender()
        }
    }

    private func openDashboard() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(Paths.dashboardPort)")!)
    }
}

// ==================================================================== boot ===

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // no Dock icon; menu bar only
app.run()
