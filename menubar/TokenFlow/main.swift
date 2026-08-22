//  TokenFlowBar v2 — TokenFlow's native macOS menu bar application.
//
//  Reads $TOKENFLOW_HOME/data/status.json (written by `tokenflow watch`) and
//  renders an adaptive status item plus a rich native dropdown built entirely
//  from custom views: usage rows, a 14-day sparkline, per-provider share
//  meters, rolling-window activity, declared-limit meters with reset
//  countdowns, forecast, anomaly alerts and milestone celebrations.
//
//  Everything is local. Nothing leaves the machine.
//
//  Design system ("Aurora, distilled"):
//    · one canvas width (460pt); manual frames, no wrapping, tail truncation
//    · every content row is a custom view — AppKit dims *disabled* menu items,
//      so plain attributed titles read washed-out; views render at full ink
//    · type scale: section headers 10pt bold uppercase indigo; row labels
//      12.5pt; ALL figures monospaced-digit semibold
//    · state colors only where they mean something: green/orange/red for
//      limit health and freshness, controlAccent for brand/chart ink
//    · dark/light follows the system via semantic colors

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
    struct Capacity: Decodable { var summary: CapacitySummary?; var states: [LimitState]?; var invalidCount: Int? }
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
        var id: String?; var type: String?; var date: String?
        var severity: String?; var detail: String?
    }
    struct Freshness: Decodable {
        var lastRefresh: String?; var ageMs: Double?; var staleAfterMs: Double?; var stale: Bool?
    }
    struct Watcher: Decodable {
        var pid: Int?; var mode: String?; var intervalSeconds: Double?; var cycles: Int?
    }
    struct LastError: Decodable { var message: String?; var at: String? }
    struct Health: Decodable { var records: Int?; var grade: String? }
    struct RecentDay: Decodable { var key: String; var total: Double?; var cost: Double?; var active: Bool? }
    struct Milestone: Decodable {
        var id: String?; var type: String?; var icon: String?
        var title: String?; var detail: String?; var date: String?
    }
    /// Rolling-window slices. Unknown extra keys are ignored by design so the
    /// Node side can annotate freely without breaking older builds.
    struct Windows: Decodable { var last5h: UsageSlice?; var last24h: UsageSlice? }

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
    var windows: Windows?
    var recentDays: [RecentDay]?
    var milestones: [Milestone]?

    var lastRefreshDate: Date? { parseISO(freshness?.lastRefresh) }
}

func parseISO(_ s: String?) -> Date? {
    guard let s else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = fractional.date(from: s) { return d }
    return ISO8601DateFormatter().date(from: s)
}

// ========================================================== status loading ==

enum Paths {
    static var home: String {
        if let env = ProcessInfo.processInfo.environment["TOKENFLOW_HOME"] { return env }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".tokenflow", isDirectory: true).path
    }
    static var statusFile: String { home + "/data/status.json" }
    static var configFile: String { home + "/config.yaml" }
    static var dashboardPort: Int {
        if let text = try? String(contentsOfFile: configFile, encoding: .utf8),
           let range = text.range(of: #"(?m)^\s*port:\s*(\d{2,5})"#, options: .regularExpression) {
            let digits = text[range].compactMap { $0.isNumber ? Character(String($0)) : nil }
            if let port = Int(String(digits)), (1024..<65536).contains(port) { return port }
        }
        return 7799
    }
    static var cliPath: String {
        if let e = Bundle.main.object(forInfoDictionaryKey: "TokenFlowCLIPath") as? String,
           FileManager.default.fileExists(atPath: e) { return e }
        return "/usr/local/bin/tokenflow"
    }
    static var nodePath: String {
        if let e = Bundle.main.object(forInfoDictionaryKey: "TokenFlowNodePath") as? String,
           FileManager.default.fileExists(atPath: e) { return e }
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

private let numFont = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .semibold)
private let numSmallFont = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
private let labelFont = NSFont.systemFont(ofSize: 12.5)
private let sectionFont = NSFont.systemFont(ofSize: 10, weight: .bold)

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

// ============================================================ layout kit ====

enum Layout {
    static let width = 460.0
    static let pad = 16.0
    static var rightEdge: Double { width - pad }
}

/// Deterministic, pleasant provider dot colors (fixed palette, stable order).
let providerPalette: [NSColor] = [.systemIndigo, .systemTeal, .systemPurple,
                                  .systemOrange, .systemPink, .systemBlue]

final class DotView: NSView {
    var color: NSColor
    init(color: NSColor, size: CGFloat = 8) {
        self.color = color
        super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }
    override func draw(_ dirtyRect: NSRect) {
        color.setFill()
        NSBezierPath(ovalIn: bounds).fill()
    }
}

func label(_ text: String, font: NSFont, color: NSColor,
           x: Double, y: Double, w: Double, align: NSTextAlignment = .left) -> NSTextField {
    let f = NSTextField(labelWithString: text)
    f.font = font
    f.textColor = color
    f.alignment = align
    f.lineBreakMode = .byTruncatingTail
    f.frame = NSRect(x: x, y: y, width: w, height: font.pointSize + 4)
    return f
}

/// Rounded track + fill meter. Height-configurable so capacity rows get a
/// chunkier bar than the hairline share-meters on provider rows.
final class MeterView: NSView {
    let fraction: CGFloat
    let tint: NSColor

    init(fraction: CGFloat, tint: NSColor, height: CGFloat = 9) {
        self.fraction = min(1, max(0, fraction))
        self.tint = tint
        super.init(frame: NSRect(x: 0, y: 0, width: 110, height: height))
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }

    override func draw(_ dirtyRect: NSRect) {
        let radius = bounds.height / 2
        NSColor.separatorColor.withAlphaComponent(0.5).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
        guard fraction > 0.001 else { return }
        let w = max(bounds.height, bounds.width * fraction)
        tint.setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: w, height: bounds.height),
                     xRadius: radius, yRadius: radius).fill()
    }
}

/// Section header: 10pt bold uppercase, letterspaced, accent-tinted. Height 20.
final class SectionHeaderView: NSView {
    init(_ title: String) {
        super.init(frame: NSRect(x: 0, y: 0, width: Layout.width, height: 20))
        let t = NSTextField(labelWithString: title.uppercased())
        t.font = sectionFont
        t.textColor = .controlAccentColor
        let para = NSMutableParagraphStyle(); para.lineBreakMode = .byTruncatingTail
        t.attributedStringValue = NSAttributedString(string: title.uppercased(), attributes: [
            .font: sectionFont, .foregroundColor: NSColor.controlAccentColor, .kern: NSNumber(value: 0.7),
        ])
        t.frame = NSRect(x: Layout.pad, y: 3, width: Layout.width - Layout.pad * 2, height: 14)
        addSubview(t)
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }
}

/// Label left, value right (mono semibold). Height 22.
final class InfoRowView: NSView {
    init(label: String, value: String, valueColor: NSColor = .labelColor) {
        super.init(frame: NSRect(x: 0, y: 0, width: Layout.width, height: 22))
        let l = NSTextField(labelWithString: label)
        l.font = labelFont; l.textColor = .labelColor
        l.lineBreakMode = .byTruncatingTail
        l.frame = NSRect(x: Layout.pad, y: 3.5, width: 200, height: 15)
        addSubview(l)
        let v = NSTextField(labelWithString: value)
        v.font = numFont; v.textColor = valueColor
        v.alignment = .right
        v.frame = NSRect(x: Layout.rightEdge - 240, y: 3.5, width: 240, height: 15)
        addSubview(v)
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }
}

/// Usage row: window/period label · "tokens · requests" secondary · cost right.
final class UsageRowView: NSView {
    init(name: String, _ u: TFStatus.UsageSlice?) {
        super.init(frame: NSRect(x: 0, y: 0, width: Layout.width, height: 22))
        let l = NSTextField(labelWithString: name)
        l.font = labelFont; l.textColor = .labelColor
        l.frame = NSRect(x: Layout.pad, y: 3.5, width: 64, height: 15)
        addSubview(l)

        let tokens = compactTokens(u?.tokens?.total ?? 0)
        let reqs = Int(u?.requests ?? 0)
        let mid = NSTextField(labelWithString: "\(tokens) tok · \(reqs) req")
        mid.font = numSmallFont; mid.textColor = .secondaryLabelColor
        mid.lineBreakMode = .byTruncatingTail
        mid.frame = NSRect(x: 84, y: 4, width: 220, height: 15)
        addSubview(mid)

        let cost = u?.cost ?? u?.costMeasured
        let c = NSTextField(labelWithString: cost.map(money) ?? "—")
        c.font = numFont
        c.textColor = cost != nil ? .labelColor : .secondaryLabelColor
        c.alignment = .right
        c.frame = NSRect(x: Layout.rightEdge - 104, y: 3.5, width: 104, height: 15)
        addSubview(c)
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }
}

/// Provider row: colored dot · name · share meter · tokens · cost.
final class ProviderRowView: NSView {
    init(index: Int, _ p: TFStatus.ProviderRow, maxTokens: Double) {
        super.init(frame: NSRect(x: 0, y: 0, width: Layout.width, height: 24))
        let color = providerPalette[index % providerPalette.count]
        let dot = DotView(color: color)
        dot.frame.origin = NSPoint(x: Layout.pad, y: 8)
        addSubview(dot)

        let name = NSTextField(labelWithString: p.key)
        name.font = labelFont; name.textColor = .labelColor
        name.lineBreakMode = .byTruncatingTail
        name.frame = NSRect(x: Layout.pad + 14, y: 4.5, width: 108, height: 15)
        addSubview(name)

        let meter = MeterView(fraction: CGFloat(maxTokens > 0 ? (p.tokens ?? 0) / maxTokens : 0),
                              tint: color, height: 6)
        meter.frame.origin = NSPoint(x: 152, y: 9)
        addSubview(meter)

        let tokens = NSTextField(labelWithString: compactTokens(p.tokens))
        tokens.font = numSmallFont; tokens.textColor = .labelColor
        tokens.alignment = .right
        tokens.frame = NSRect(x: 250, y: 4.5, width: 66, height: 15)
        addSubview(tokens)

        let cost = p.cost ?? p.costMeasured
        let costField = NSTextField(labelWithString: cost.map(money) ?? "")
        costField.font = numSmallFont
        costField.textColor = cost != nil ? .secondaryLabelColor : NSColor.secondaryLabelColor.withAlphaComponent(0.001)
        costField.alignment = .right
        costField.frame = NSRect(x: Layout.rightEdge - 74, y: 4.5, width: 74, height: 15)
        addSubview(costField)
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }
}

/// 14-day sparkline: rounded bars, today solid accent, history 35% alpha,
/// zero days as hairline stubs so gaps stay honest. Height 48.
final class SparklineView: NSView {
    let days: [TFStatus.RecentDay]

    init(days: [TFStatus.RecentDay]) {
        self.days = days
        super.init(frame: NSRect(x: 0, y: 0, width: Layout.width, height: 48))
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }

    override func draw(_ dirtyRect: NSRect) {
        guard !days.isEmpty else { return }
        let areaX = Layout.pad
        let areaW = Layout.width - Layout.pad * 2
        let baseY: CGFloat = 6
        let maxHeight: CGFloat = 36
        let slot = areaW / CGFloat(days.count)
        let barW = min(18, slot - 3)

        // baseline
        NSColor.separatorColor.withAlphaComponent(0.6).setFill()
        NSBezierPath(rect: NSRect(x: areaX, y: baseY - 1, width: areaW, height: 1)).fill()

        let maxTotal = days.compactMap(\.total).max() ?? 0
        for (i, d) in days.enumerated() {
            let isToday = i == days.count - 1
            let total = d.total ?? 0
            let inactive = !(d.active ?? false) && total <= 0
            let h: CGFloat = total > 0 ? max(4, CGFloat(total / max(maxTotal, 1)) * maxHeight) : (inactive ? 2 : 3)
            let x = areaX + slot * CGFloat(i) + (slot - barW) / 2
            let rect = NSRect(x: x, y: baseY, width: barW, height: h)
            let path = NSBezierPath(roundedRect: rect, xRadius: 2, yRadius: 2)
            if isToday {
                NSColor.controlAccentColor.setFill()
            } else if inactive {
                NSColor.separatorColor.setFill()
            } else {
                NSColor.controlAccentColor.withAlphaComponent(0.32).setFill()
            }
            path.fill()
        }
    }
}

/// Capacity row: ✓/⚠/✗ label · meter · pct · ETA/reset. Width-corrected.
final class LimitRowView: NSView {
    init(state: TFStatus.LimitState) {
        super.init(frame: NSRect(x: 0, y: 0, width: Layout.width, height: 26))

        let st = state.status ?? "unknown"
        let tint: NSColor = st == "exceeded" ? .systemRed : st == "warn" ? .systemOrange : .systemGreen
        let glyph = st == "exceeded" ? "✗" : st == "warn" ? "⚠" : "✓"
        let name = state.label ?? state.id ?? "limit"

        let nameField = NSTextField(labelWithString: "\(glyph) \(name)")
        nameField.font = .systemFont(ofSize: 12.5, weight: .medium)
        nameField.textColor = .labelColor
        nameField.lineBreakMode = .byTruncatingTail
        nameField.frame = NSRect(x: Layout.pad, y: 5.5, width: 168, height: 15)
        addSubview(nameField)

        let meter = MeterView(fraction: CGFloat(state.pctUsed ?? 0), tint: tint, height: 8)
        meter.frame.origin = NSPoint(x: 188, y: 9)
        addSubview(meter)

        let pctUsed = state.pctUsed ?? 0
        let pctText = pctUsed >= 10 ? "\(Int(pctUsed))×" : "\(Int((pctUsed * 100).rounded()))%"
        let pctField = NSTextField(labelWithString: pctText)
        pctField.font = numFont
        pctField.textColor = st == "ok" ? .secondaryLabelColor : tint
        pctField.alignment = .right
        pctField.frame = NSRect(x: 304, y: 5.5, width: 52, height: 15)
        addSubview(pctField)

        var tail = "resets \(countdown(state.resetsInMs))"
        if let eta = state.etaHours, st != "exceeded" {
            tail = "ETA \(countdown(eta * 3600_000)) · " + tail
        }
        let tailField = NSTextField(labelWithString: tail)
        tailField.font = numSmallFont
        tailField.textColor = .secondaryLabelColor
        tailField.alignment = .right
        tailField.lineBreakMode = .byTruncatingHead
        tailField.frame = NSRect(x: 358, y: 6.5, width: 86, height: 14)
        addSubview(tailField)
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }
}

/// Celebration banner: 🎉 icon + bold title + supporting detail line.
final class MilestoneRowView: NSView {
    init(icon: String, title: String, detail: String) {
        super.init(frame: NSRect(x: 0, y: 0, width: Layout.width, height: 36))
        wantsLayer = true
        layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.08).cgColor
        layer?.cornerRadius = 8

        let iconField = NSTextField(labelWithString: icon.isEmpty ? "🎉" : icon)
        iconField.font = .systemFont(ofSize: 15)
        iconField.frame = NSRect(x: Layout.pad, y: 9, width: 22, height: 18)
        addSubview(iconField)

        let t = NSTextField(labelWithString: title)
        t.font = .systemFont(ofSize: 12.5, weight: .semibold)
        t.textColor = .labelColor
        t.lineBreakMode = .byTruncatingTail
        t.frame = NSRect(x: Layout.pad + 28, y: 17, width: Layout.width - Layout.pad * 2 - 28, height: 15)
        addSubview(t)

        let d = NSTextField(labelWithString: detail)
        d.font = .systemFont(ofSize: 10.5)
        d.textColor = .secondaryLabelColor
        d.lineBreakMode = .byTruncatingTail
        d.frame = NSRect(x: Layout.pad + 28, y: 3, width: Layout.width - Layout.pad * 2 - 28, height: 13)
        addSubview(d)
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }
}

/// Header: brand + live/stale badge, freshness subline. Height 40.
final class HeaderRowView: NSView {
    init(demo: Bool, watcherLive: Bool, stale: Bool, updated: String, everyN: Double?, cycles: Int?) {
        super.init(frame: NSRect(x: 0, y: 0, width: Layout.width, height: 42))

        let brand = NSTextField(labelWithString: "TokenFlow")
        brand.font = .systemFont(ofSize: 14, weight: .bold)
        brand.textColor = .labelColor
        brand.frame = NSRect(x: Layout.pad, y: 21, width: 120, height: 17)
        addSubview(brand)

        let badgeText: String
        let badgeColor: NSColor
        switch (watcherLive, stale) {
        case (true, false): badgeText = "● live"; badgeColor = .systemGreen
        case (true, true): badgeText = "● live · stale"; badgeColor = .systemOrange
        default: badgeText = "○ watcher off"; badgeColor = .secondaryLabelColor
        }
        let badge = NSTextField(labelWithString: badgeText)
        badge.font = .systemFont(ofSize: 11, weight: .medium)
        badge.textColor = badgeColor
        badge.alignment = .right
        badge.frame = NSRect(x: Layout.rightEdge - 160, y: 23, width: 160, height: 14)
        addSubview(badge)

        if demo {
            let demoTag = NSTextField(labelWithString: "[DEMO DATA]")
            demoTag.font = .systemFont(ofSize: 10, weight: .bold)
            demoTag.textColor = .systemRed
            demoTag.frame = NSRect(x: Layout.pad + 96, y: 23, width: 90, height: 13)
            addSubview(demoTag)
        }

        var sub = "updated \(updated)"
        if let n = everyN { sub += " · every \(Int(n))s" }
        if let c = cycles { sub += " · \(c) cycles" }
        let subline = NSTextField(labelWithString: sub)
        subline.font = numSmallFont
        subline.textColor = stale ? .systemOrange : .secondaryLabelColor
        subline.frame = NSRect(x: Layout.pad, y: 4, width: Layout.width - Layout.pad * 2, height: 13)
        addSubview(subline)
    }
    required init?(coder: NSCoder) { fatalError("unsupported") }
}

func menuView(_ view: NSView) -> NSMenuItem {
    let it = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    it.view = view
    it.isEnabled = false
    return it
}

// ============================================================== app delegate =

@objc final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var status: TFStatus?
    private var refreshing = false
    /// Set when an action could not spawn the CLI; rendered in the menu so a
    /// dead click is never silent.
    private var spawnError: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        item.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        item.button?.toolTip = "TokenFlow — AI usage & capacity"
        menu.autoenablesItems = false
        menu.delegate = self
        item.menu = menu
        reloadAndRender()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            self?.status = loadStatus()
            self?.renderTitle()
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    private func reloadAndRender() {
        status = loadStatus()
        // A successful read with data proves the CLI pipeline works again.
        if status != nil, (status?.health?.records ?? 0) > 0 { spawnError = nil }
        rebuildMenu()
        renderTitle()
    }

    private var watcherRunning: Bool { processAlive(status?.watcher?.pid) }

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

    func menuNeedsUpdate(_ menu: NSMenu) {
        status = loadStatus()
        rebuildMenu()
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
        let updatedAge = status?.lastRefreshDate.map { Date().timeIntervalSince($0) * 1000 } ?? snapshotAge
        menu.addItem(menuView(HeaderRowView(
            demo: status?.demo == true,
            watcherLive: watcherRunning,
            stale: stale,
            updated: relativeAge(updatedAge),
            everyN: status?.watcher?.intervalSeconds,
            cycles: status?.watcher?.cycles,
        )))
        menu.addItem(.separator())

        // ---- empty store ------------------------------------------------------
        guard let s = status, let today = s.usage?["today"], (s.health?.records ?? 0) > 0 else {
            menu.addItem(menuView(SectionHeaderView("Getting started")))
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

        // ---- milestone banner ---------------------------------------------------
        if let m = s.milestones?.first {
            menu.addItem(menuView(MilestoneRowView(
                icon: m.icon ?? "🎉",
                title: m.title ?? "Milestone",
                detail: m.detail ?? "",
            )))
            menu.addItem(.separator())
        }

        // ---- usage -----------------------------------------------------------------
        menu.addItem(menuView(SectionHeaderView("Usage")))
        menu.addItem(menuView(UsageRowView(name: "Today", today)))
        menu.addItem(menuView(UsageRowView(name: "Week", s.usage?["weekToDate"])))
        menu.addItem(menuView(UsageRowView(name: "Month", s.usage?["monthToDate"])))

        // ---- sparkline ------------------------------------------------------------
        if let days = s.recentDays, days.count >= 2 {
            menu.addItem(menuView(SparklineView(days: days)))
        }

        // ---- rolling windows ---------------------------------------------------------
        if let w = s.windows {
            menu.addItem(.separator())
            menu.addItem(menuView(SectionHeaderView("Recent windows")))
            menu.addItem(menuView(UsageRowView(name: "Last 5h", w.last5h)))
            menu.addItem(menuView(UsageRowView(name: "Last 24h", w.last24h)))
            menu.addItem(noteItem("measured locally · hour granularity"))
        }

        // ---- providers ------------------------------------------------------------------
        if let provs = s.providersToday, !provs.isEmpty {
            menu.addItem(.separator())
            menu.addItem(menuView(SectionHeaderView("Today by provider")))
            let maxTokens = provs.compactMap(\.tokens).max() ?? 0
            for (i, p) in provs.prefix(5).enumerated() {
                menu.addItem(menuView(ProviderRowView(index: i, p, maxTokens: maxTokens)))
            }
        }

        // ---- capacity ----------------------------------------------------------------------
        menu.addItem(.separator())
        menu.addItem(menuView(SectionHeaderView("Capacity")))
        let states = s.capacity?.states ?? []
        if !states.isEmpty {
            for st in states.prefix(5) {
                menu.addItem(menuView(LimitRowView(state: st)))
            }
            if let hit = s.capacity?.summary?.firstToHit, let eta = hit.etaHours {
                menu.addItem(noteItem("First projected hit: \(hit.label ?? "?") in \(countdown(eta * 3600_000))"))
            }
        } else {
            menu.addItem(noteItem("No limits configured — set budgets in the Live tab."))
        }

        // ---- forecast --------------------------------------------------------------------------
        if let f = s.forecast, let tomorrow = f.tomorrow {
            menu.addItem(.separator())
            menu.addItem(menuView(SectionHeaderView("Forecast")))
            var line = "Tomorrow ≈ \(compactTokens(tomorrow))"
            if let week = f.next7days { line += "  ·  7d ≈ \(compactTokens(week))" }
            menu.addItem(menuView(InfoRowView(label: line, value: f.monthEndCost.map { "≈ \(money($0)) mo-end" } ?? "")))
            menu.addItem(noteItem("Confidence: \(f.confidence ?? "?")\(f.n.map { " (\($0)-day trend)" } ?? "")"))
        }

        // ---- alerts -----------------------------------------------------------------------------
        let highs = (s.anomalies ?? []).filter { $0.severity == "high" }.prefix(2)
        if highs.count > 0 {
            menu.addItem(.separator())
            menu.addItem(menuView(SectionHeaderView("Alerts")))
            for a in highs {
                menu.addItem(noteItem("‼️ \((a.date ?? "")) — \((a.detail ?? "").replacingOccurrences(of: "\n", with: " "))", size: 11))
            }
        }
        if let err = s.lastError?.message {
            menu.addItem(noteItem("⚠︎ Watcher error: \(err)", color: .systemOrange, size: 11))
        }
        if let spawnErr = spawnError {
            menu.addItem(noteItem("⚠︎ Action failed: \(spawnErr)", color: .systemOrange, size: 11))
            menu.addItem(noteItem("Try: node bin/tokenflow.js \(s.health?.records ?? 0 > 0 ? "watch --once" : "setup") in Terminal", size: 10))
        }

        // ---- actions ------------------------------------------------------------------------------
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

    private func noteItem(_ text: String, color: NSColor = .secondaryLabelColor, size: CGFloat = 10.5) -> NSMenuItem {
        let it = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        it.attributedTitle = NSAttributedString(
            string: text,
            attributes: [.font: NSFont.systemFont(ofSize: size), .foregroundColor: color])
        it.isEnabled = false
        return it
    }

    // -------------------------------------------------------------- actions --

    private func nodeProcess(_ args: [String], detached: Bool) -> Process? {
        let node = Paths.nodePath
        guard node == "/usr/bin/env" || FileManager.default.fileExists(atPath: node) else {
            spawnError = "node not found at \(node)"
            return nil
        }
        guard FileManager.default.fileExists(atPath: Paths.cliPath) else {
            spawnError = "tokenflow CLI missing at \(Paths.cliPath)"
            return nil
        }
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
        guard let proc = nodeProcess(args, detached: false) else { reloadAndRender(); return }
        refreshing = true
        renderTitle()
        rebuildMenu()
        proc.terminationHandler = { [weak self] p in
            guard let self else { return }
            let failed = p.terminationReason == .uncaughtSignal || p.terminationStatus != 0
            let name = args.first ?? "command"
            DispatchQueue.main.async {
                self.refreshing = false
                if failed { self.spawnError = "\(name) exited with status \(p.terminationStatus)" }
                self.reloadAndRender()
            }
        }
        do { try proc.run() } catch {
            refreshing = false
            spawnError = error.localizedDescription
            reloadAndRender()
        }
    }

    private func refreshNow() { runCLI(["watch", "--once"]) }

    /// Children survive parent exit on Unix; null stdio keeps them quiet.
    private func startWatcherDetached() {
        guard let proc = nodeProcess(["watch"], detached: true) else { return }
        try? proc.run()
    }

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
app.setActivationPolicy(.accessory)
app.run()
