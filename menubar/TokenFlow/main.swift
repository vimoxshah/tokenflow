//  TokenFlowBar v3 — native menu bar app: status item + SwiftUI popover.
//
//  Design system "Aurora Compact":
//    · 360pt popover canvas on a 4pt spacing grid, 12pt card radii
//    · SF Pro Rounded numerals for hero figures; monospaced digits for tables
//    · semantic palette: indigo brand accent, green/orange/red state colors,
//      a fixed per-provider hue set; dark/light via system semantics only
//    · first-party Swift Charts for the sparkline — no hand-drawn chart code
//
//  Everything is local. Nothing leaves the machine.

import AppKit
@preconcurrency import SwiftUI
import Charts

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
    struct Windows: Decodable { var last5h: UsageSlice?; var last24h: UsageSlice? }
    struct WindowStat: Decodable {
        var tokens: Tokens?; var requests: Double?
        var cost: Double?; var costMeasured: Double?
    }
    struct ProviderWindow: Decodable {
        var key: String
        var h5: WindowStat?; var d1: WindowStat?; var d7: WindowStat?
    }
    struct SessionBlock: Decodable {
        var key: String; var label: String?
        var startMs: Double?; var resetsInMs: Double?
        var windowTokens: Double?; var windowRequests: Int?; var windowCost: Double?
        var blocksToday: Int?
    }
    struct VelocityInfo: Decodable {
        var todayTokensPerHour: Double?
        var avgTokensPerHour: Double?
        var ratio: Double?
    }

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
    var providerWindows: [ProviderWindow]?
    var sessionBlocks: [SessionBlock]?
    var velocity: VelocityInfo?
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

private func compactTokens(_ n: Double?) -> String {
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

private func money(_ n: Double?) -> String {
    guard let n, n.isFinite else { return "—" }
    let sign = n < 0 ? "-" : ""
    let a = abs(n)
    if a >= 1000 { return "\(sign)$\(String(format: "%.1f", a / 1000))K" }
    if a >= 100 { return "\(sign)$\(String(format: "%.0f", a))" }
    return "\(sign)$\(String(format: "%.2f", a))"
}

private func countdown(_ ms: Double?) -> String {
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

private func relativeAge(_ msAgo: Double?) -> String {
    guard let msAgo else { return "never" }
    if msAgo < 45_000 { return "just now" }
    let min = Int(msAgo / 60_000)
    if min < 60 { return "\(min) min ago" }
    let hr = min / 60
    if hr < 24 { return "\(hr)h ago" }
    return "\(hr / 24)d ago"
}

// ========================================================== design tokens ===

enum TF {
    static let width: CGFloat = 356
    static let pad: CGFloat = 14
    // Matches the web dashboard's Aurora accent (#8f9dff dark / #3d4dd6 light)
    static let accent = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0x8f / 255.0, green: 0x9d / 255.0, blue: 0xff / 255.0, alpha: 1)
            : NSColor(srgbRed: 0x3d / 255.0, green: 0x4d / 255.0, blue: 0xd6 / 255.0, alpha: 1)
    })
    static let good = Color.green
    static let warn = Color.orange
    static let bad = Color.red
    static let palette: [Color] = [.indigo, .teal, .purple, .orange, .pink]

    static func cardBG(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.06) : Color.black.opacity(0.045)
    }

    // type scale — SF Pro Rounded for figures gives the friendly-premium feel
    static func hero(_ size: CGFloat = 22) -> Font {
        .system(size: size, weight: .bold, design: .rounded).monospacedDigit()
    }
    static func figure(_ size: CGFloat = 13, _ weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight).monospacedDigit()
    }
    static let sectionFont = Font.system(size: 10.5, weight: .semibold)
    static let labelFont = Font.system(size: 12.5)
    static let captionFont = Font.caption
    static let microFont = Font.system(size: 9.5)
}

// ============================================================ state/model ===

final class StatusModel: ObservableObject {
    @Published var status: TFStatus?
    @Published var refreshing = false
    @Published var actionError: String?
    func load() { status = loadStatus() }
}

struct AppActions {
    var refresh: () -> Void = {}
    var openDashboard: () -> Void = {}
    var toggleWatcher: () -> Void = {}
    var runSetup: () -> Void = {}
    var quit: () -> Void = {}
}

// ============================================================ app delegate ==

@objc final class AppDelegate: NSObject, NSApplicationDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    let model = StatusModel()
    private var outsideMonitor: Any?
    private var insideMonitor: Any?
    private var keyMonitor: Any?

    func applicationWillTerminate(_ note: Notification) {
        if let m = outsideMonitor { NSEvent.removeMonitor(m) }
        if let m = insideMonitor { NSEvent.removeMonitor(m) }
        if let m = keyMonitor { NSEvent.removeMonitor(m) }
    }

    lazy var actions: AppActions = AppActions(
        refresh: { [weak self] in self?.runCLI(["watch", "--once"]) },
        openDashboard: { [weak self] in self?.openDashboard() },
        toggleWatcher: { [weak self] in self?.toggleWatcherAction() },
        runSetup: { [weak self] in self?.runCLI(["setup"]) },
        quit: { NSApp.terminate(nil) })

    func applicationDidFinishLaunching(_ note: Notification) {
        // Off-screen design verification: render light+dark previews, then quit.
        let argv = CommandLine.arguments
        if let i = argv.firstIndex(of: "--preview"), argv.count > i + 1 {
            PreviewRenderer.render(argv[i + 1])
            exit(0)
        }
        item.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        item.button?.target = self
        item.button?.action = #selector(togglePopover(_:))
        item.button?.toolTip = "TokenFlow — AI usage & capacity"
        let host = NSHostingController(rootView: MenuContentView(model: model, actions: actions))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        popover.behavior = .transient
        // Auto-dismiss, correct by construction rather than by event guessing:
        // .transient handles clicks outside for a well-behaved key window; the
        // global monitor covers other apps (which .transient can miss when the
        // app is a non-activating accessory); and the local monitor covers
        // clicks landing in this process's own non-popover windows. The status
        // bar is excluded so the toggle action can run.
        outsideMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            DispatchQueue.main.async {
                if let self, self.popover.isShown { self.popover.performClose(nil) }
            }
        }
        insideMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]) { [weak self] ev in
            guard let self, self.popover.isShown,
                  let hitWindow = ev.window,
                  let contentWindow = self.popover.contentViewController?.view.window,
                  hitWindow !== contentWindow,
                  !String(describing: type(of: hitWindow)).contains("StatusBar")
            else { return ev }
            self.popover.performClose(nil)
            return ev
        }
        // Escape closes the popover: local keyDown monitor, same lifecycle as
        // the click monitors. performClose drives the standard dismissal path.
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) {
            [weak self] ev in
            guard let self, self.popover.isShown,
                  ev.keyCode == 53 /* Escape */ else { return ev }
            self.popover.performClose(nil)
            return nil // consumed
        }
        model.load()
        renderTitle()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            DispatchQueue.main.async {
                self?.model.load()
                self?.renderTitle()
            }
        }
    }

    @objc private func togglePopover(_ sender: Any?) {
        if popover.isShown { popover.performClose(nil); return }
        model.load()
        renderTitle()
        guard let button = item.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }

    private var watcherRunning: Bool { processAlive(model.status?.watcher?.pid) }

    /// Adaptive headline: worst limit when configured, else today's cost when
    /// priced, else today's tokens — mirroring `status --bar`.
    private func headlineValue() -> (text: String, kind: String)? {
        guard let s = model.status, let today = s.usage?["today"],
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
        // Compact command-center form: "$1.42 | 1.82M tok" when priced,
        // tokens alone when today carries no cost signal.
        let tokenPart = "\(compactTokens(tokens)) tok"
        if let cost = today.cost ?? today.costMeasured {
            return ("\(money(cost)) | \(tokenPart)", "cost")
        }
        return (tokenPart, "tokens")
    }

    private func renderTitle() {
        guard let button = item.button else { return }
        let base: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.labelColor,
        ]
        if model.refreshing {
            button.attributedTitle = NSAttributedString(string: "TF ⟳", attributes: base)
            return
        }
        guard let head = headlineValue() else {
            button.attributedTitle = NSAttributedString(string: "TF", attributes: base)
            return
        }
        let tint: NSColor; let prefix: String
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

    // ---- actions -----------------------------------------------------------

    private func makeProcess(_ args: [String], detached: Bool) -> Process? {
        let node = Paths.nodePath
        guard node == "/usr/bin/env" || FileManager.default.fileExists(atPath: node) else {
            DispatchQueue.main.async { self.model.actionError = "node not found at \(node)" }
            return nil
        }
        guard FileManager.default.fileExists(atPath: Paths.cliPath) else {
            DispatchQueue.main.async { self.model.actionError = "tokenflow CLI missing at \(Paths.cliPath)" }
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
        guard !model.refreshing, let proc = makeProcess(args, detached: false) else { return }
        model.refreshing = true
        renderTitle()
        proc.terminationHandler = { [weak self] p in
            DispatchQueue.main.async {
                guard let self else { return }
                self.model.refreshing = false
                if p.terminationReason == .uncaughtSignal || p.terminationStatus != 0 {
                    self.model.actionError = "\(args.first ?? "command") exited (\(p.terminationStatus))"
                }
                self.model.load()
                self.renderTitle()
            }
        }
        do { try proc.run() } catch {
            model.refreshing = false
            model.actionError = error.localizedDescription
            renderTitle()
        }
    }

    private func startWatcherDetached() {
        guard let proc = makeProcess(["watch"], detached: true) else { return }
        try? proc.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.model.load(); self?.renderTitle()
        }
    }

    private func toggleWatcherAction() {
        if watcherRunning { runCLI(["watch", "--stop"]) } else { startWatcherDetached() }
    }

    private func openDashboard() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(Paths.dashboardPort)")!)
    }
}

// ============================================================== swiftui ui ==

private struct Pill: View {
    let text: String
    let color: Color
    var filled = false
    var body: some View {
        Text(text)
            .font(.system(size: 10.5, weight: .semibold)).monospacedDigit()
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(filled ? color : color.opacity(0.15)))
            .foregroundColor(filled ? .white : color)
    }
}

private struct SectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        HStack(spacing: 8) {
            Text(title.uppercased())
                .font(TF.sectionFont)
                .tracking(0.7)
                .foregroundStyle(.secondary)
            Rectangle().fill(Color.primary.opacity(0.08)).frame(height: 1)
        }
    }
}

private struct TFMeter: View {
    let fraction: Double
    let color: Color
    var height: CGFloat = 6
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                Capsule().fill(color)
                    .frame(width: max(4, geo.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: height)
    }
}

// ---------------------------------------------------------------- sections --

private struct BrandRow: View {
    let demo: Bool
    let live: Bool
    let stale: Bool
    let updated: String
    let everyN: Double?

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(LinearGradient(colors: [.indigo, .teal],
                                         startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "bolt.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(.white)
            }.frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 1) {
                Text("TokenFlow").font(.system(size: 14, weight: .bold))
                Text(subline).font(TF.microFont).foregroundStyle(.secondary)
            }
            Spacer()
            if demo { Pill(text: "DEMO", color: TF.bad, filled: true) }
            Pill(text: live ? (stale ? "● live · stale" : "● live") : "○ paused",
                 color: live ? (stale ? TF.warn : TF.good) : .secondary)
        }
    }

    private var subline: String {
        var s = "updated \(updated)"
        if let n = everyN { s += " · every \(Int(n))s" }
        return s + " · local-only"
    }
}

private struct MilestoneBanner: View {
    let m: TFStatus.Milestone
    var body: some View {
        HStack(spacing: 10) {
            Text(m.icon ?? "🎉").font(.system(size: 19))
            VStack(alignment: .leading, spacing: 1) {
                Text(m.title ?? "Milestone")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.white)
                Text(m.detail ?? "")
                    .font(.system(size: 10.5))
                    .foregroundColor(.white.opacity(0.85))
                    .lineLimit(2)
            }
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(LinearGradient(colors: [.indigo, .purple],
                                 startPoint: .topLeading, endPoint: .bottomTrailing)))
    }
}

private struct Sparkline: View {
    let days: [TFStatus.RecentDay]

    var body: some View {
        Chart(Array(days.enumerated()), id: \.offset) { pair in
            AreaMark(x: .value("Day", pair.offset), y: .value("Tokens", pair.element.total ?? 0))
                .interpolationMethod(.catmullRom)
                .foregroundStyle(LinearGradient(colors: [TF.accent.opacity(0.30), TF.accent.opacity(0.02)],
                                                startPoint: .top, endPoint: .bottom))
            LineMark(x: .value("Day", pair.offset), y: .value("Tokens", pair.element.total ?? 0))
                .interpolationMethod(.catmullRom)
                .foregroundStyle(TF.accent)
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            if pair.offset == days.count - 1 {
                PointMark(x: .value("Day", pair.offset), y: .value("Tokens", pair.element.total ?? 0))
                    .symbolSize(36)
                    .foregroundStyle(TF.accent)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .frame(height: 52)
    }
}

/// Day-wise bars with hover/tap tooltips: tokens + estimated cost per day.
private struct HoverBarChart: View {
    let days: [TFStatus.RecentDay]
    @State private var hovered: Int? = nil
    @Environment(\.colorScheme) private var cs

    var body: some View {
        VStack(spacing: 4) {
            ZStack(alignment: .topLeading) {
                Color.clear.frame(height: 16)
                if let i = hovered, days.indices.contains(i) {
                    let d = days[i]
                    Text("\(d.key.dropFirst(5)) · \(compactTokens(d.total)) tok\((d.cost ?? 0) > 0 ? " · \(money(d.cost))" : "")")
                        .font(.system(size: 9.5, weight: .semibold).monospacedDigit())
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(RoundedRectangle(cornerRadius: 6)
                            .fill(Color(nsColor: .labelColor)))
                        .foregroundColor(Color(nsColor: .textBackgroundColor))
                        .frame(maxWidth: .infinity, alignment: Alignment(horizontal: horizontalAnchor(for: i), vertical: .top))
                }
            }
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(Array(days.enumerated()), id: \.offset) { i, d in
                    let maxTotal = max(days.compactMap(\.total).max() ?? 0, 1)
                    let isToday = i == days.count - 1
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(isToday ? TF.accent
                              : hovered == i ? TF.accent.opacity(0.75)
                              : TF.accent.opacity(0.30))
                        .frame(height: barHeight(total: d.total ?? 0, maxTotal: maxTotal))
                        .onHover { inside in if inside { withAnimation(.easeOut(duration: 0.12)) { hovered = i } } }
                        .onTapGesture { hovered = i }
                }
            }
            .frame(height: 46)
        }
        .contentShape(Rectangle())
        .onHover { inside in if !inside { withAnimation(.easeOut(duration: 0.15)) { if hovered != nil { hovered = nil } } } }
    }

    private func barHeight(total: Double, maxTotal: Double) -> CGFloat {
        if total <= 0 { return 2.5 }
        return max(6, CGFloat(total / maxTotal) * 42)
    }
    private func horizontalAnchor(for i: Int) -> HorizontalAlignment {
        let n = days.count
        if n < 2 { return .center }
        let frac = Double(i) / Double(n - 1)
        if frac < 0.18 { return .leading }
        if frac > 0.82 { return .trailing }
        return .center
    }
}

private struct HeroCard: View {
    let today: TFStatus.UsageSlice
    let days: [TFStatus.RecentDay]

    var velocity: TFStatus.VelocityInfo?

    private var cost: Double? { today.cost ?? today.costMeasured }
    private var paceText: String? {
        guard let r = velocity?.ratio, r.isFinite, r > 0 else { return nil }
        return String(format: "⚡ %.1f× your average pace", r)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("TODAY").font(TF.sectionFont).tracking(0.7).foregroundStyle(.secondary)
                Spacer()
                if let c = cost {
                    Text(money(c))
                        .font(.system(size: 12.5, weight: .bold).monospacedDigit())
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(Capsule().fill(TF.accent))
                        .foregroundColor(.white)
                } else {
                    Pill(text: "no price data", color: .secondary)
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(compactTokens(today.tokens?.total ?? 0)).font(TF.hero()).foregroundStyle(.primary)
                Text("tokens").font(TF.captionFont).foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Text("\(Int(today.requests ?? 0)) requests · \(today.sessions ?? 0) sessions")
                    .font(TF.captionFont).foregroundStyle(.secondary)
                if let pace = paceText {
                    Text(pace).font(.system(size: 10.5, weight: .semibold))
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Capsule().fill(TF.accent.opacity(0.14)))
                        .foregroundColor(TF.accent)
                }
            }
            HoverBarChart(days: days)
        }
    }
}

private struct StatCard: View {
    let label: String
    let slice: TFStatus.UsageSlice?
    @Environment(\.colorScheme) private var cs

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(.system(size: 9, weight: .semibold))
                .tracking(0.6).foregroundStyle(.secondary)
            Text(compactTokens(slice?.tokens?.total ?? 0))
                .font(.system(size: 14, weight: .semibold, design: .rounded).monospacedDigit())
            Text(costText).font(TF.microFont).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 9).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(TF.cardBG(cs)))
    }

    private var costText: String {
        (slice?.cost ?? slice?.costMeasured).map(money) ?? "—"
    }
}

private struct ProviderRow: View {
    let index: Int
    let row: TFStatus.ProviderRow
    let maxTokens: Double

    private var costText: String {
        (row.cost ?? row.costMeasured).map(money) ?? ""
    }

    var body: some View {
        let color = TF.palette[index % TF.palette.count]
        let tokens = row.tokens ?? 0
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(row.key).font(TF.labelFont).lineLimit(1)
            Spacer(minLength: 6)
            TFMeter(fraction: maxTokens > 0 ? tokens / maxTokens : 0, color: color,
                    height: 5).frame(width: 56)
            Text(compactTokens(tokens)).font(TF.figure(11.5))
            Text(costText).font(TF.figure(11, .regular))
                .foregroundStyle(costText.isEmpty ? AnyShapeStyle(Color.clear) : AnyShapeStyle(Color.secondary))
                .frame(width: 48, alignment: .trailing)
        }
        .frame(height: 20)
    }
}

private struct CapacityRow: View {
    let st: TFStatus.LimitState
    @Environment(\.colorScheme) private var cs

    private var tint: Color {
        st.status == "exceeded" ? TF.bad : st.status == "warn" ? TF.warn : TF.good
    }
    private var glyph: String {
        st.status == "exceeded" ? "✗" : st.status == "warn" ? "⚠" : "✓"
    }
    private var pctText: String {
        guard let p = st.pctUsed else { return "—" }
        return p >= 10 ? "\(Int(p))×" : "\(Int((p * 100).rounded()))%"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text("\(glyph) \(st.label ?? st.id ?? "limit")")
                    .font(.system(size: 12.5, weight: .medium))
                    .lineLimit(1)
                Spacer()
                Pill(text: pctText, color: tint)
            }
            TFMeter(fraction: st.pctUsed ?? 0, color: tint, height: 6)
            HStack(spacing: 6) {
                if let eta = st.etaHours, st.status != "exceeded" {
                    Text("ETA \(countdown(eta * 3600_000))").font(TF.microFont)
                }
                Spacer()
                Text("resets \(countdown(st.resetsInMs))").font(TF.microFont)
            }.foregroundStyle(.secondary)
        }
    }
}

private struct AlertRow: View {
    let a: TFStatus.Anomaly
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text("‼️").font(.system(size: 12))
            Text("\((a.date ?? "")) — \((a.detail ?? "").replacingOccurrences(of: "\n", with: " "))")
                .font(.system(size: 11))
                .foregroundStyle(.primary.opacity(0.85))
                .multilineTextAlignment(.leading)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(TF.bad.opacity(0.08)))
    }
}

private struct NoteText: View {
    var text: String
    var color: Color = .secondary
    init(_ text: String, color: Color = .secondary) {
        self.text = text; self.color = color
    }
    var body: some View {
        Text(text).font(TF.microFont).foregroundStyle(color).lineLimit(2)
    }
}


private struct ForecastLine: View {
    let icon: String; let label: String; let tokens: Double?; let cost: Double?
    var body: some View {
        // Fixed-width columns so every row's figures align vertically:
        // [icon+label] grows | tokens right-aligned (72) | cost right-aligned (56)
        HStack(spacing: 6) {
            Image(systemName: icon).foregroundStyle(TF.accent).frame(width: 16)
            Text(label).font(TF.labelFont).foregroundStyle(.primary)
            Spacer(minLength: 8)
            Text("≈ \(compactTokens(tokens ?? 0))")
                .font(TF.figure(12, .semibold)).foregroundStyle(.primary)
                .frame(width: 72, alignment: .trailing)
                .monospacedDigit()
            Text(cost.map(money) ?? " ")
                .font(TF.figure(11)).foregroundStyle(.secondary)
                .frame(width: 56, alignment: .trailing)
                .monospacedDigit()
        }.frame(height: 20)
    }
}
private struct ForecastBlock: View {
    let f: TFStatus.Forecast
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "chart.line.uptrend.xyaxis")
                .foregroundStyle(TF.accent)
                .font(.system(size: 14, weight: .semibold))
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                // month-end estimate rides on the Tomorrow row's cost column
                // so both rows share one aligned grid — no floating column
                ForecastLine(icon: "sun.max", label: "Tomorrow", tokens: f.tomorrow,
                             cost: f.monthEndCost)
                if let wk = f.next7days {
                    ForecastLine(icon: "calendar", label: "Next week",
                                 tokens: wk, cost: f.next7daysCost)
                }
                HStack {
                    Text("Confidence: \(f.confidence ?? "?")\(f.n.map { " (\($0)-day trend)" } ?? "")")
                        .font(TF.microFont).foregroundStyle(.secondary)
                    Spacer()
                    if let mc = f.monthEndCost {
                        Text("mo-end est.").font(TF.microFont).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

// --------------------------------------------------------- getting started --

private struct GettingStarted: View {
    let onSetup: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("No usage data yet").font(.system(size: 14, weight: .semibold))
            Text("TokenFlow found nothing to ingest. Run setup to detect the AI tools already installed on this machine.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            Button(action: onSetup) {
                Label("Detect AI tools", systemImage: "wand.and.stars")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 9).fill(TF.accent))
                    .foregroundColor(.white)
            }
            .buttonStyle(.plain)
        }
    }
}

// -------------------------------------------------------------- actions bar --

private struct ActionsBar: View {
    let refreshing: Bool
    let live: Bool
    let actions: AppActions

    var body: some View {
        HStack(spacing: 8) {
            Button(action: actions.refresh) {
                HStack(spacing: 6) {
                    if refreshing {
                        ProgressView().controlSize(.small).tint(.white)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                    Text("Refresh").font(.system(size: 12, weight: .semibold))
                }
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Capsule().fill(TF.accent))
                .foregroundColor(.white)
            }
            .buttonStyle(.plain)
            .disabled(refreshing)
            .keyboardShortcut("r", modifiers: .command)

            Button(action: actions.openDashboard) {
                HStack(spacing: 6) {
                    Image(systemName: "macwindow")
                    Text("Dashboard").font(.system(size: 12, weight: .semibold))
                }
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Capsule().fill(Color.primary.opacity(0.07)))
            }
            .buttonStyle(.plain)

            Spacer()

            Button(action: actions.toggleWatcher) {
                Image(systemName: live ? "stop.circle.fill" : "play.circle.fill")
                    .font(.system(size: 19))
                    .foregroundStyle(live ? AnyShapeStyle(TF.bad.opacity(0.85)) : AnyShapeStyle(TF.good))
            }
            .buttonStyle(.plain)
            .help(live ? "Stop watcher" : "Start watcher")

            Button(action: actions.quit) {
                Image(systemName: "power")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Quit TokenFlow")
        }
    }
}

// ----------------------------------------------------------------- footer ----

private struct FooterRow: View {
    var body: some View {
        HStack(spacing: 4) {
            Text("local-first · nothing leaves this Mac").font(TF.microFont)
            Spacer()
            Text(version).font(TF.microFont)
        }.foregroundStyle(.tertiary)
    }

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }
}


private struct ProviderWindowRow: View {
    let index: Int
    let w: TFStatus.ProviderWindow
    @Environment(\.colorScheme) private var cs

    private func cell(_ slice: TFStatus.WindowStat?) -> some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(compactTokens(slice?.tokens?.total ?? 0))
                .font(TF.figure(11)).foregroundStyle(.primary)
            Text((slice?.cost ?? slice?.costMeasured).map(money) ?? "—")
                .font(TF.microFont).foregroundStyle(.secondary)
        }.frame(width: 64, alignment: .trailing)
    }

    var body: some View {
        let color = TF.palette[index % TF.palette.count]
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(w.key).font(TF.labelFont).lineLimit(1)
            Spacer(minLength: 6)
            cell(w.h5); cell(w.d1); cell(w.d7)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(TF.cardBG(cs)))
    }
}

private struct SessionBlockRow: View {
    let b: TFStatus.SessionBlock

    var body: some View {
        let expired = (b.resetsInMs ?? 0) <= 0
        let tint = b.key == "anthropic" ? Color.orange : Color.teal
        return HStack(spacing: 10) {
            Image(systemName: b.key == "anthropic" ? "c.circle.fill" : "z.circle.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(b.label ?? b.key).font(.system(size: 12.5, weight: .medium))
                Text(expired
                     ? "awaiting first request of a new block"
                     : "\(Int(b.windowRequests ?? 0)) requests this block")
                    .font(TF.microFont).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text(compactTokens(b.windowTokens ?? 0))
                    .font(TF.figure(12.5)).foregroundStyle(.primary)
                Text(expired ? "block elapsed" : "resets in \(countdown(b.resetsInMs))")
                    .font(TF.microFont).monospacedDigit()
                    .foregroundStyle(expired ? AnyShapeStyle(Color.secondary)
                                             : AnyShapeStyle(Color.orange))
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(tint.opacity(0.07)))
    }
}

// ------------------------------------------------------------------- root ----

struct MenuContentView: View {
    @ObservedObject var model: StatusModel
    var actions: AppActions

    private var s: TFStatus? { model.status }
    private var hasData: Bool { (s?.health?.records ?? 0) > 0 }
    private var watcherLive: Bool {
        guard let pid = s?.watcher?.pid, pid > 1 else { return false }
        return kill(pid_t(pid), 0) == 0 || errno != ESRCH
    }
    private var updatedAge: Double? {
        guard let d = s?.lastRefreshDate else { return nil }
        return Date().timeIntervalSince(d) * 1000
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            contentBody
        }
        .frame(maxHeight: 640)
    }

    private var contentBody: some View {
        VStack(alignment: .leading, spacing: 11) {
            BrandRow(
                demo: s?.demo == true,
                live: watcherLive && hasData,
                stale: s?.freshness?.stale ?? true,
                updated: relativeAge(updatedAge),
                everyN: s?.watcher?.intervalSeconds)

            if let m = s?.milestones?.first {
                MilestoneBanner(m: m)
            }

            if hasData, let today = s?.usage?["today"] {
                HeroCard(today: today, days: s?.recentDays ?? [], velocity: s?.velocity)

                SectionHeader("Windows & totals")
                HStack(spacing: 8) {
                    StatCard(label: "Week", slice: s?.usage?["weekToDate"])
                    StatCard(label: "Month", slice: s?.usage?["monthToDate"])
                }
                HStack(spacing: 8) {
                    StatCard(label: "Last 5h", slice: s?.windows?.last5h)
                    StatCard(label: "Last 24h", slice: s?.windows?.last24h)
                }

                if let pw = s?.providerWindows, !pw.isEmpty {
                    SectionHeader("Live provider windows")
                    VStack(spacing: 6) {
                        ForEach(Array(pw.enumerated()), id: \.offset) { i, w in
                            ProviderWindowRow(index: i, w: w)
                        }
                    }
                    NoteText("measured rolling usage per tool · hour granularity")
                }

                if let blocks = s?.sessionBlocks, !blocks.isEmpty {
                    SectionHeader("Sessions · 5h model")
                    VStack(spacing: 7) {
                        ForEach(blocks, id: \.key) { b in
                            SessionBlockRow(b: b)
                        }
                    }
                }

                if let provs = s?.providersToday, !provs.isEmpty {
                    SectionHeader("Today by provider")
                    VStack(spacing: 7) {
                        let maxTokens = provs.compactMap(\.tokens).max() ?? 0
                        ForEach(Array(provs.filter { ($0.tokens ?? 0) > 0 }.prefix(5).enumerated()),
                                id: \.offset) { i, p in
                            ProviderRow(index: i, row: p, maxTokens: maxTokens)
                        }
                    }
                }

                SectionHeader("Capacity")
                capacityBlock

                if let f = s?.forecast, f.tomorrow != nil {
                    ForecastBlock(f: f)
                }

                alertRows

                if let err = s?.lastError?.message {
                    errorLine("⚠︎ Watcher error: \(err)")
                }
                if let err = model.actionError {
                    errorLine("⚠︎ Action failed: \(err)")
                }

                Divider()
                ActionsBar(refreshing: model.refreshing, live: watcherLive, actions: actions)
            } else {
                GettingStarted(onSetup: actions.runSetup)
                if let err = model.actionError {
                    errorLine("⚠︎ \(err)")
                }
                Divider()
                ActionsBar(refreshing: model.refreshing, live: false, actions: actions)
            }

            FooterRow()
        }
        .padding(TF.pad)
        .frame(width: TF.width)
        // Opaque, appearance-adaptive backdrop: the popover supplies one at
        // runtime, but off-screen previews composite transparency as black,
        // which made light-mode text unreadable.
        .background(Color(nsColor: .windowBackgroundColor))
    }

    @ViewBuilder private var capacityBlock: some View {
        let states = s?.capacity?.states ?? []
        if states.isEmpty {
            NoteText("No limits configured — set budgets in the dashboard's Live tab.")
        } else {
            VStack(spacing: 9) {
                ForEach(Array(states.prefix(5).enumerated()), id: \.offset) { _, st in
                    CapacityRow(st: st)
                }
                if let hit = s?.capacity?.summary?.firstToHit, let eta = hit.etaHours {
                    NoteText("First projected hit: \(hit.label ?? "?") in \(countdown(eta * 3600_000))")
                }
            }
        }
    }

    @ViewBuilder private var alertRows: some View {
        let highs = (s?.anomalies ?? []).filter { $0.severity == "high" }
        if !highs.isEmpty {
            SectionHeader("Alerts")
            VStack(spacing: 6) {
                ForEach(Array(highs.prefix(2).enumerated()), id: \.offset) { _, a in
                    AlertRow(a: a)
                }
            }
        }
    }

    private func errorLine(_ text: String) -> some View {
        NoteText(text, color: .orange)
    }
}


// ==================================================== off-screen previews ====

enum PreviewRenderer {
    @MainActor
    static func render(_ prefix: String) {
        guard let status = loadStatus() else {
            FileHandle.standardError.write(Data("preview: no status at \(Paths.statusFile)\n".utf8))
            exit(1)
        }
        let model = StatusModel()
        model.status = status
        for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
            // ImageRenderer cannot draw ScrollView content off-screen (it renders
            // fully transparent), so lay the view out in an off-screen hosting
            // window and snapshot its layer instead.
            let controller = NSHostingController(
                rootView: MenuContentView(model: model, actions: AppActions())
                    .environment(\.colorScheme, scheme))
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 360, height: 640),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = controller.view
            controller.view.frame = NSRect(x: 0, y: 0, width: 360, height: 640)
            controller.view.layoutSubtreeIfNeeded()
            guard let bitmap = controller.view.bitmapImageRepForCachingDisplay(in: controller.view.bounds) else {
                FileHandle.standardError.write(Data("preview: failed to render \(name)\n".utf8))
                continue
            }
            controller.view.cacheDisplay(in: controller.view.bounds, to: bitmap)
            guard let png = bitmap.representation(using: .png, properties: [:]) else {
                FileHandle.standardError.write(Data("preview: failed to render \(name)\n".utf8))
                continue
            }
            try? png.write(to: URL(fileURLWithPath: "\(prefix)-\(name).png"))
            print("wrote \(prefix)-\(name).png (\(bitmap.pixelsWide)x\(bitmap.pixelsHigh))")
        }
    }
}

// ===================================================================== boot ===

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let argv = CommandLine.arguments
if let i = argv.firstIndex(of: "--preview"), argv.count > i + 1 {
    // Off-screen design previews. ImageRenderer is MainActor-isolated, so the
    // work is dispatched onto the main actor and the run loop below spins
    // until it finishes, then exits.
    let prefix = argv[i + 1]
    // The main-queue drain inside app.run() executes this block; exit() ends
    // the process before the run loop can spin forever.
    DispatchQueue.main.async {
        PreviewRenderer.render(prefix)
        exit(0)
    }
    app.run()
    exit(0)
} else {
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
