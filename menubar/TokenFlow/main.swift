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
    var modelsToday: [ProviderRow]?
    var sourcesToday: [ProviderRow]?
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
    static var watchLockFile: String { home + "/data/watch.pid" }
    static var watchLogFile: String { home + "/watch.log" }
    /// The supported login agent, if the CLI has installed one.
    static var watchAgentLabel: String { "app.tokenflow.watch" }
    static var watchAgentPlist: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(watchAgentLabel).plist").path
    }
    static var dashboardLogFile: String { home + "/dashboard.log" }
    static var configFile: String { home + "/config.yaml" }
    static var dashboardPort: Int {
        if let text = try? String(contentsOfFile: configFile, encoding: .utf8),
           let range = text.range(of: #"(?m)^\s*port:\s*(\d{2,5})"#, options: .regularExpression) {
            let digits = text[range].compactMap { $0.isNumber ? Character(String($0)) : nil }
            if let port = Int(String(digits)), (1024..<65536).contains(port) { return port }
        }
        return 7799
    }
    /// The CLI shipped inside this app bundle. A distributable build always
    /// has one; it is packed from the published npm package at build time.
    static var bundledCLI: String? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let p = res.appendingPathComponent("cli/package/bin/tokenflow.js").path
        return FileManager.default.fileExists(atPath: p) ? p : nil
    }

    /// Which CLI this app drives.
    ///
    /// The bundled copy comes BEFORE anything found on the system. The app and
    /// the CLI share a contract — the status file's shape, the watcher lock
    /// format, /api/ping — so the copy that ships with the binary is the only
    /// one guaranteed to match it. A newer CLI installed separately is not
    /// automatically a compatible one.
    ///
    /// A local (non-portable) build embeds the developer's clone and that wins,
    /// so an installed app still drives the checkout being edited.
    static var cliPath: String? {
        if let e = Bundle.main.object(forInfoDictionaryKey: "TokenFlowCLIPath") as? String,
           FileManager.default.fileExists(atPath: e) { return e }
        if let b = bundledCLI { return b }
        let candidates = [
            "/usr/local/bin/tokenflow",
            "/opt/homebrew/bin/tokenflow",
            NSHomeDirectory() + "/Desktop/Vimox/poc/tokenflow/bin/tokenflow.js",
            NSHomeDirectory() + "/tokenflow/bin/tokenflow.js",
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0) }
    }

    /// The lowest Node the CLI runs on (package.json "engines").
    static let minimumNodeMajor = 22

    /// An absolute node binary.
    ///
    /// launchd hands over a minimal PATH that cannot resolve an nvm install, so
    /// `env node` is not enough. nvm versions are discovered rather than named:
    /// a hardcoded version is one `nvm install` away from being wrong, and it
    /// was — the previous list led with whichever version the developer had.
    static var explicitNode: String? {
        let fm = FileManager.default
        let home = NSHomeDirectory()
        let nvm = home + "/.nvm/versions/node"
        // Highest nvm version at or above the engine floor.
        let fromNvm: [String] = ((try? fm.contentsOfDirectory(atPath: nvm)) ?? [])
            .compactMap { name in
                let major = Int(name.drop(while: { !$0.isNumber })
                    .prefix(while: { $0.isNumber })) ?? 0
                guard major >= minimumNodeMajor else { return nil }
                let bin = "\(nvm)/\(name)/bin/node"
                return fm.isExecutableFile(atPath: bin) ? bin : nil
            }
            .sorted { versionKey($0) > versionKey($1) }
        let candidates = fromNvm + [
            home + "/.nvm/current/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        return candidates.first { fm.isExecutableFile(atPath: $0) }
    }

    /// Sortable numeric key for a path containing a version like v24.13.1.
    private static func versionKey(_ path: String) -> Int {
        let digits = path.split(separator: "/")
            .first(where: { $0.hasPrefix("v") && $0.dropFirst().first?.isNumber == true }) ?? ""
        let parts = digits.dropFirst().split(separator: ".").compactMap { Int($0) }
        let p = parts + [0, 0, 0]
        return p[0] * 1_000_000 + p[1] * 1_000 + p[2]
    }

    static var nodePath: String {
        if let e = Bundle.main.object(forInfoDictionaryKey: "TokenFlowNodePath") as? String,
           FileManager.default.fileExists(atPath: e) { return e }
        return explicitNode ?? "/usr/bin/env"
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

// ========================================================== watcher lock ====

/// Epoch milliseconds of the last boot, straight from the kernel.
///
/// The watcher's lock file records the boot its pid was issued by, because pid
/// numbers restart and get reused at every boot. Without this check a lock
/// that outlived a restart keeps naming a live process — just not ours — and
/// the watcher can never start again. That is not theoretical: a lock left at
/// pid 810 was inherited by `mobilerepaird` after a reboot and TokenFlow sat
/// paused behind it, the play button doing nothing at all.
func bootTimeMs() -> Double? {
    var tv = timeval()
    var size = MemoryLayout<timeval>.stride
    var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
    guard sysctl(&mib, 2, &tv, &size, nil, 0) == 0, size > 0 else { return nil }
    return Double(tv.tv_sec) * 1000 + Double(tv.tv_usec) / 1000
}

/// Boot stamps are derived from whole-second clocks on both sides, so allow a
/// little slack; a reboot moves the stamp by far more than this.
private let bootToleranceMs: Double = 30_000

/// Is a watcher of OURS holding the lock right now?
///
/// Reads the lock file rather than `status.json`: a watcher block outlives the
/// process that wrote it, so the status file can only say that a watcher ran,
/// never that one is running.
func watcherLockIsLive() -> Bool {
    guard let raw = try? String(contentsOfFile: Paths.watchLockFile, encoding: .utf8) else { return false }
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { return false }

    // Legacy locks are a bare pid with no boot stamp. Nothing to cross-check,
    // so fall back to plain liveness; the CLI does the authoritative check
    // before it refuses to start.
    guard text.hasPrefix("{"), let data = text.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let pid = obj["pid"] as? Int
    else { return processAlive(Int(text)) }

    guard processAlive(pid) else { return false }
    guard let boot = obj["boot"] as? Double, let now = bootTimeMs() else { return true }
    return abs(boot - now) <= bootToleranceMs
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
    /// Read once per load, not per render — liveness costs a file read.
    @Published var watcherLive = false
    @Published var dashboardStarting = false
    func load() {
        status = loadStatus()
        watcherLive = watcherLockIsLive()
    }
}

struct AppActions {
    var refresh: () -> Void = {}
    var openDashboard: () -> Void = {}
    var toggleWatcher: () -> Void = {}
    var runSetup: () -> Void = {}
    var cycleTheme: () -> Void = {}
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
        cycleTheme: { [weak self] in self?.cycleThemeAction() },
        quit: { NSApp.terminate(nil) })

    // Appearance override, persisted in defaults. system → light → dark → …
    // Applied by setting NSApp.appearance; nil = follow the system.
    static let themeKey = "appearanceOverride" // "system" | "light" | "dark"

    private func cycleThemeAction() {
        let order = ["system", "light", "dark"]
        let current = UserDefaults.standard.string(forKey: Self.themeKey) ?? "system"
        let next = order[(order.firstIndex(of: current).map { $0 + 1 } ?? 0) % order.count]
        UserDefaults.standard.set(next, forKey: Self.themeKey)
        applyTheme(named: next)
        // Repaint the popover content in the new scheme immediately.
        model.load()
    }

    private func applyTheme(named name: String) {
        switch name {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark":  NSApp.appearance = NSAppearance(named: .darkAqua)
        default:      NSApp.appearance = nil
        }
        // NSHostingView does not always re-resolve its environment when an
        // already-shown popover window's appearance changes; rebuild the
        // content view so the new scheme is guaranteed to take effect.
        rebuildPopoverContent()
    }

    /** Swap in a fresh hosting controller with the persisted theme applied. */
    private func rebuildPopoverContent() {
        let theme = UserDefaults.standard.string(forKey: Self.themeKey) ?? "system"
        let content = MenuContentView(model: model, actions: actions)
        let themed: any View
        switch theme {
        case "light": themed = content.environment(\.colorScheme, .light)
        case "dark":  themed = content.environment(\.colorScheme, .dark)
        default:      themed = content
        }
        let host = NSHostingController(rootView: AnyView(themed))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        if popover.isShown, let button = item.button {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        // Restore persisted appearance override before any UI is built.
        applyTheme(named: UserDefaults.standard.string(forKey: Self.themeKey) ?? "system")
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
        rebuildPopoverContent()
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
        checkDependencies()
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

    private var watcherRunning: Bool { model.watcherLive }

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

    /// What to tell someone whose install cannot run anything. Nothing the app
    /// does works without a CLI to drive, so say the command rather than
    /// failing quietly — this is what a cask-only install looks like.
    private let missingCLIHint = "TokenFlow's CLI is missing — install it with:  npm i -g @vimoxshah/tokenflow"
    private let missingNodeHint = "Node \(Paths.minimumNodeMajor).5+ is required and was not found — install it from nodejs.org or with:  brew install node"

    /// Report a missing dependency once at launch, so the first click is not
    /// the first anyone hears of it.
    private func checkDependencies() {
        if Paths.cliPath == nil {
            model.actionError = missingCLIHint
        } else if Paths.explicitNode == nil {
            model.actionError = missingNodeHint
        }
    }

    /// Detached children we still want to hear back from: a Process released
    /// before it exits never runs its terminationHandler.
    private var watcherProc: Process?
    private var dashboardProc: Process?

    private func makeProcess(_ args: [String], detached: Bool) -> Process? {
        guard let cli = Paths.cliPath else {
            model.actionError = missingCLIHint
            return nil
        }
        // Prefer an absolute node binary (launchd's minimal PATH cannot resolve
        // an nvm-managed install via `env node`); fall back to env.
        let proc = Process()
        if let node = Paths.explicitNode {
            proc.executableURL = URL(fileURLWithPath: node)
            proc.arguments = [cli] + args
        } else {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", cli] + args
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
        // Prefer the login agent when one is installed: launchd supervises it,
        // so it restarts after a crash and comes back at the next login. A bare
        // child started here would do neither, which would quietly leave the
        // user worse off after pressing play than they were after logging in.
        if FileManager.default.fileExists(atPath: Paths.watchAgentPlist), kickstartWatchAgent() {
            model.actionError = nil
            pollUntilWatcherSeen(6)
            return
        }
        guard let proc = makeProcess(["watch"], detached: true) else {
            model.actionError = missingCLIHint
            return
        }
        // A watcher that refuses to start used to fail in complete silence:
        // output went to /dev/null and the button just stayed on "play". Send
        // it to the watcher log — the same file the launch agent uses — so the
        // popover can quote the reason and the log keeps the whole story.
        let logPath = Paths.watchLogFile
        var logFrom: UInt64 = 0
        if let log = appendHandle(logPath) {
            logFrom = (try? log.offset()) ?? 0
            proc.standardOutput = log
            proc.standardError = log
        }
        model.actionError = nil
        proc.terminationHandler = { [weak self] p in
            guard p.terminationStatus != 0 else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.model.load()
                guard !self.model.watcherLive else { return }
                self.model.actionError = lastMeaningfulLine(ofFile: logPath, from: logFrom)
                    ?? "watcher exited (\(p.terminationStatus)) — see \(logPath)"
                self.renderTitle()
            }
        }
        watcherProc = proc
        do { try proc.run() } catch {
            model.actionError = error.localizedDescription
            return
        }
        pollUntilWatcherSeen(6)
    }

    /// Ask launchd to start the agent. `false` when there is no such job, so
    /// the caller can fall back to spawning a watcher directly.
    private func kickstartWatchAgent() -> Bool {
        let uid = getuid()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        proc.arguments = ["kickstart", "gui/\(uid)/\(Paths.watchAgentLabel)"]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            return proc.terminationStatus == 0
        } catch {
            return false
        }
    }

    /// A freshly started watcher takes the lock within a moment; poll so the
    /// button flips to "stop" as soon as it does rather than looking dead.
    private func pollUntilWatcherSeen(_ attempts: Int) {
        guard attempts > 0 else { model.load(); renderTitle(); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self else { return }
            self.model.load()
            self.renderTitle()
            if self.watcherRunning { return }
            self.pollUntilWatcherSeen(attempts - 1)
        }
    }

    private func toggleWatcherAction() {
        if watcherRunning { runCLI(["watch", "--stop"]) } else { startWatcherDetached() }
    }

    /// Open the dashboard — starting the server first when nothing is serving.
    ///
    /// This button used to open a browser at the configured port and hope. With
    /// no server running (the common case: the app had just launched, or the
    /// watcher was down) the browser showed a connection error and the button
    /// looked broken.
    private func openDashboard() {
        guard !model.dashboardStarting else { return }
        let port = Paths.dashboardPort
        probeDashboard(port: port) { [weak self] serving in
            guard let self else { return }
            if serving {
                NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)")!)
            } else {
                self.startDashboard(port: port)
            }
        }
    }

    private func startDashboard(port: Int) {
        guard let proc = makeProcess(["dashboard"], detached: true) else {
            model.actionError = missingCLIHint
            return
        }
        // A file, not a Pipe — same reason as the watcher: this server runs for
        // as long as the dashboard is open and nobody would be draining it.
        let logPath = Paths.dashboardLogFile
        var logFrom: UInt64 = 0
        if let log = appendHandle(logPath) {
            logFrom = (try? log.offset()) ?? 0
            proc.standardOutput = log
            proc.standardError = log
        }
        model.actionError = nil
        model.dashboardStarting = true
        proc.terminationHandler = { [weak self] p in
            guard p.terminationStatus != 0 else { return }
            DispatchQueue.main.async {
                guard let self, self.model.dashboardStarting else { return }
                self.model.dashboardStarting = false
                self.model.actionError = lastMeaningfulLine(ofFile: logPath, from: logFrom)
                    ?? "dashboard exited (\(p.terminationStatus)) — port \(port) may be busy"
            }
        }
        dashboardProc = proc
        do { try proc.run() } catch {
            model.dashboardStarting = false
            model.actionError = error.localizedDescription
            return
        }
        // The server builds its data bundle before it binds, which on a large
        // store takes several seconds — wait generously instead of calling it
        // a failure. The CLI opens the browser itself once it is listening.
        awaitDashboard(port: port, attemptsLeft: 30)
    }

    private func awaitDashboard(port: Int, attemptsLeft: Int) {
        guard attemptsLeft > 0 else {
            model.dashboardStarting = false
            model.actionError = "the dashboard did not come up on port \(port)"
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self, self.model.dashboardStarting else { return }
            self.probeDashboard(port: port) { serving in
                if serving {
                    self.model.dashboardStarting = false
                } else {
                    self.awaitDashboard(port: port, attemptsLeft: attemptsLeft - 1)
                }
            }
        }
    }

    /// Is a TokenFlow dashboard answering on this port? Loopback only.
    private func probeDashboard(port: Int, done: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/ping") else { return done(false) }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            // Identify the app, not just an open port: something else on the
            // port is a problem to report, not a dashboard to open.
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
                && (data.flatMap { String(data: $0, encoding: .utf8) }?.contains("\"tokenflow\"") ?? false)
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }
}

/// A write handle positioned at the end of `path`, creating the file if needed.
///
/// Long-running children get their output APPENDED TO A FILE, never buffered
/// in a Pipe. The refresh cycle shells out (the git provider alone writes to
/// stderr several times a cycle), those children inherit fd 2, and a pipe that
/// nobody drains fills its buffer within hours — at which point the writer
/// blocks and the watcher this button started hangs. A file never blocks, and
/// it is the same file the launch agent writes, so there is one place to look.
private func appendHandle(_ path: String) -> FileHandle? {
    let fm = FileManager.default
    if !fm.fileExists(atPath: path) {
        fm.createFile(atPath: path, contents: nil)
    }
    guard let h = FileHandle(forWritingAtPath: path) else { return nil }
    h.seekToEndOfFile()
    return h
}

/// The line of a log worth showing a human, trimmed to fit.
///
/// Scans the tail backwards and prefers the CLI's own error marker: a failure
/// prints the reason and then a hint, so the newest line is the hint and the
/// line above it is what actually went wrong.
private func lastMeaningfulLine(ofFile path: String, from: UInt64 = 0, tailBytes: UInt64 = 4096) -> String? {
    guard let h = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? h.close() }
    guard let size = try? h.seekToEnd(), size > from else { return nil }
    // Only what THIS launch wrote: the log is shared with the launch agent and
    // accumulates for weeks, so an old line must never be quoted as the reason
    // a start that just happened failed.
    try? h.seek(toOffset: max(from, size > tailBytes ? size - tailBytes : 0))
    guard let data = try? h.readToEnd(), let text = String(data: data, encoding: .utf8) else { return nil }

    var fallback: String?
    for raw in text.split(separator: "\n").reversed() {
        // ICU takes \uhhhh, not Swift's \u{...}: the wrong form fails to
        // compile and leaves escape codes in the message.
        let plain = raw.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "\u{001B}\\[[0-9;]*m", with: "", options: .regularExpression)
        let body = plain.trimmingCharacters(in: CharacterSet(charactersIn: "✗! "))
        guard body.count > 3 else { continue }
        if plain.hasPrefix("✗") || plain.lowercased().hasPrefix("fatal") {
            return String(body.prefix(120))
        }
        if fallback == nil { fallback = String(body.prefix(120)) }
    }
    return fallback
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

private struct SourceRow: View {
    // Same grid as ProviderRow but with a square glyph: source is "which app",
    // provider is "whose model" — the shape difference makes that legible.
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
            RoundedRectangle(cornerRadius: 2.5).fill(color).frame(width: 8, height: 8)
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

private struct ModelRow: View {
    let row: TFStatus.ProviderRow
    let maxTokens: Double

    private var costText: String {
        (row.cost ?? row.costMeasured).map(money) ?? ""
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "cpu").font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary).frame(width: 12)
            Text(row.key).font(TF.labelFont).lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 6)
            Text(compactTokens(row.tokens ?? 0)).font(TF.figure(11.5))
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
    var dashboardStarting = false
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
                    if dashboardStarting {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "macwindow")
                    }
                    // Starting the server takes a few seconds on a large store,
                    // so say so rather than looking inert.
                    Text(dashboardStarting ? "Starting…" : "Dashboard")
                        .font(.system(size: 12, weight: .semibold))
                }
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Capsule().fill(Color.primary.opacity(0.07)))
            }
            .buttonStyle(.plain)
            .disabled(dashboardStarting)

            Spacer()

            Button(action: actions.toggleWatcher) {
                Image(systemName: live ? "stop.circle.fill" : "play.circle.fill")
                    .font(.system(size: 19))
                    .foregroundStyle(live ? AnyShapeStyle(TF.bad.opacity(0.85)) : AnyShapeStyle(TF.good))
            }
            .buttonStyle(.plain)
            .help(live ? "Stop watcher" : "Start watcher")

            // Theme: system → light → dark, persisted across launches.
            Button(action: actions.cycleTheme) {
                Image(systemName: "circle.lefthalf.filled")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Appearance: follow system / light / dark")

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
    /// One source of truth for "is it live": the watcher's own lock file,
    /// boot-verified. `status.watcher` only records that a watcher once ran.
    private var watcherLive: Bool { model.watcherLive }
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

                // By SOURCE — the app that wrote the log (claude-code,
                // opencode, hermes…). Answers "which tool did I use today",
                // which provider attribution cannot: hermes traffic appears
                // here under its own name even when its models are other
                // vendors'.
                if let srcs = s?.sourcesToday, !srcs.isEmpty {
                    SectionHeader("Today by source")
                    VStack(spacing: 7) {
                        let maxTokens = srcs.compactMap(\.tokens).max() ?? 0
                        ForEach(Array(srcs.filter { ($0.tokens ?? 0) > 0 }.prefix(6).enumerated()),
                                id: \.offset) { i, p in
                            SourceRow(index: i, row: p, maxTokens: maxTokens)
                        }
                    }
                }

                if let models = s?.modelsToday, !models.isEmpty {
                    SectionHeader("Top models today")
                    VStack(spacing: 7) {
                        let maxTokens = models.compactMap(\.tokens).max() ?? 0
                        ForEach(Array(models.filter { ($0.tokens ?? 0) > 0 }.prefix(5).enumerated()),
                                id: \.offset) { i, mrow in
                            ModelRow(row: mrow, maxTokens: maxTokens)
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
                ActionsBar(refreshing: model.refreshing, live: watcherLive,
                           dashboardStarting: model.dashboardStarting, actions: actions)
            } else {
                GettingStarted(onSetup: actions.runSetup)
                if let err = model.actionError {
                    errorLine("⚠︎ \(err)")
                }
                Divider()
                ActionsBar(refreshing: model.refreshing, live: false,
                           dashboardStarting: model.dashboardStarting, actions: actions)
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
        let model = StatusModel()
        // Load the way the app does, so a preview shows the real live/paused
        // state instead of a hand-assembled one.
        model.load()
        guard model.status != nil else {
            FileHandle.standardError.write(Data("preview: no status at \(Paths.statusFile)\n".utf8))
            exit(1)
        }
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

// --- single-instance guard -------------------------------------------------
// Two copies in the menu bar cause duplicate items, flaky clicks, and zombie
// popovers (launchd RunAtLoad + user double-click + `open -a` can all race).
// A lock file with the holding PID: if that PID is alive, this copy exits.
let lockPath = NSHomeDirectory() + "/.tokenflow/bar-instance.lock"
FileManager.default.createFile(atPath: lockPath, contents: nil)
// Advisory byte-range lock via Darwin fcntl: held for the process lifetime,
// released automatically when the process dies (even on crash).
var lockInfo = flock()
lockInfo.l_type = Int16(F_WRLCK)
lockInfo.l_whence = Int16(SEEK_SET)
let fd = open(lockPath, O_RDWR | O_CREAT, 0o644)
if fd >= 0 {
    let got = fcntl(fd, F_SETLK, &lockInfo) == 0
    if got {
        // We hold the lock: record our PID for diagnostics.
        var pidStr = String(ProcessInfo.processInfo.processIdentifier)
        _ = pidStr.withUTF8 { buf in
            lseek(fd, 0, SEEK_SET)
            _ = write(fd, buf.baseAddress, buf.count)
        }
        _ = pidStr
    } else {
        // Another instance holds the lock and is alive — do not duplicate.
        close(fd)
        exit(0)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// Opt out of macOS Automatic Termination: with no windows open (menu-bar-only
// app), AppKit marks the process eligible for silent termination under memory
// pressure or after idle. TokenFlow must stay resident — it is the user's
// live usage indicator — so disable both mechanisms explicitly.
ProcessInfo.processInfo.disableAutomaticTermination("TokenFlow is a menu-bar status app that must stay resident")
ProcessInfo.processInfo.disableSuddenTermination()

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
