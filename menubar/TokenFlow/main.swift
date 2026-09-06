//  TokenFlowBar v3 — native menu bar app: status item + SwiftUI popover.
//
//  Design system "Aurora Compact":
//    · 360pt popover canvas on a 4pt spacing grid, 12pt card radii
//    · SF Pro Rounded numerals for hero figures; monospaced digits for tables
//    · semantic palette: indigo brand accent, green/orange/red state colors,
//      a fixed per-provider hue set; dark/light via system semantics only
//    · first-party Swift Charts for the day-wise trend; the per-source 24-hour
//      sparklines are drawn as SwiftUI Paths, because a Chart per row costs
//      more than the six polylines it would draw
//
//  Everything is local. Nothing leaves the machine.

import AppKit
@preconcurrency import SwiftUI
import Charts
// Carbon is the only supported way to claim a system-wide hotkey that fires
// while another app is frontmost. Cocoa has no equivalent.
import Carbon.HIToolbox

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

    // ---- the glanceable sections (docs/roadmap.md §3) ----------------------
    //
    // Every one of these is OPTIONAL, top to bottom. A status.json written
    // before they existed must still decode, and one written by a slightly
    // different CLI must not blank the whole menu bar over a field it spells
    // another way: a throwing decode here costs the user every other section
    // too, which is a far worse failure than a missing branch name.

    /// The guard's opinion of one session.
    struct GuardVerdict: Decodable {
        var level: String?          // "ok" | "warn" | "block"
        var reasons: [String]?
        var declared: Bool?
    }

    struct LiveSession: Decodable {
        var sessionId: String?
        var source: String?
        var provider: String?
        var model: String?
        var project: String?
        var repository: String?
        var branch: String?
        var startedAt: String?
        var lastActivityAt: String?
        var turns: Int?
        var subagentTurns: Int?
        var costUsd: Double?
        var coverage: Double?
        var contextTokens: Double?
        var contextShare: Double?
        /// `guard` is a Swift keyword, so the wire name is mapped explicitly.
        var guardState: GuardVerdict?

        enum CodingKeys: String, CodingKey {
            case sessionId, source, provider, model, project, repository, branch
            case startedAt, lastActivityAt, turns, subagentTurns, costUsd
            case coverage, contextTokens, contextShare
            case guardState = "guard"
        }
    }

    struct LiveSessions: Decodable {
        var asOf: String?
        var windowMinutes: Int?
        var sessions: [LiveSession]?
    }

    struct ReceiptItem: Decodable {
        var repo: String?
        var branch: String?
        var costUsd: Double?
        var turns: Int?
        var sessions: Int?
    }

    struct ReceiptsToday: Decodable {
        var asOf: String?
        var totalCostUsd: Double?
        var items: [ReceiptItem]?
    }

    struct GuardPolicy: Decodable {
        var warnCostUsd: Double?
        var maxCostUsd: Double?
        var warnContextTokens: Double?
        var maxContextTokens: Double?
        var warnMarginalUsd: Double?
    }

    struct GuardBlock: Decodable {
        struct Verdict: Decodable {
            var level: String?
            var sessionId: String?
            var at: String?
            var reasons: [String]?
            var source: String?
        }
        var policy: GuardPolicy?
        var declared: Bool?
        var lastVerdict: Verdict?
    }

    struct Sparklines: Decodable {
        var hours: [String]?
        var bySource: [String: [Double]]?
        var costBySource: [String: [Double]]?
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
    var liveSessions: LiveSessions?
    var receiptsToday: ReceiptsToday?
    var `guard`: GuardBlock?
    var sparklines: Sparklines?

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

/// Milliseconds since an ISO stamp, for `relativeAge`.
private func msSince(_ iso: String?) -> Double? {
    guard let d = parseISO(iso) else { return nil }
    return Date().timeIntervalSince(d) * 1000
}

/// Money for the glance rows, blank when there is no price.
///
/// `money(nil)` returns an em dash, and the copy rules forbid em and en dashes
/// in anything a user reads. An empty cell already says "not priced".
private func moneyOrBlank(_ n: Double?) -> String {
    guard let n, n.isFinite else { return "" }
    return money(n)
}

/// A plain decimal the CLI reads back with `Number()`.
///
/// The guard spec is comma-separated, so the value can never carry a comma,
/// and it must not be written in exponent form either.
private func plainNumber(_ v: Double) -> String {
    if v == v.rounded() && abs(v) < 1e15 { return String(Int(v)) }
    var s = String(format: "%.4f", v)
    while s.hasSuffix("0") { s.removeLast() }
    if s.hasSuffix(".") { s.removeLast() }
    return s
}

// -------------------------------------------------------------- guard level --

/// Severity of a guard level, so an escalation can be told from a recovery.
private func guardRank(_ level: String?) -> Int {
    switch level {
    case "block": return 2
    case "warn": return 1
    default: return 0
    }
}

/// The status colour for a guard level. Status colours mean status and
/// nothing else, so this is the only place a guard level picks up a hue.
private func guardColor(_ level: String?) -> Color {
    switch level {
    case "block": return TF.bad
    case "warn": return TF.warn
    default: return TF.good
    }
}

/// What the coloured dot means, spelled out for the tooltip.
private func guardHelp(_ level: String?) -> String {
    switch level {
    case "block": return "Guard would stop this session."
    case "warn": return "Guard is warning about this session."
    default: return "Within your caps."
    }
}

// ========================================================== design tokens ===

enum TF {
    static let width: CGFloat = 356
    static let pad: CGFloat = 14
    // Every colour comes from design/tokens.yaml via DesignTokens.swift, so the
    // menu bar and the dashboard cannot disagree about what the accent is.
    static let accent = DesignTokens.accent.color
    static let accentSolid = DesignTokens.accentSolid.color
    static let accentInk = DesignTokens.accentInk.color
    static let good = DesignTokens.good
    static let warn = DesignTokens.warning
    static let bad = DesignTokens.critical
    /// Categorical steps in fixed order, assigned by entity — never by rank.
    static let palette: [Color] = (0..<8).map { DesignTokens.series($0) }

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

// ============================================================== density =====

/// How tightly the popover is drawn.
///
/// `comfortable` reproduces the layout that shipped before this preference
/// existed, value for value, so turning it on changes nothing. `compact` takes
/// one step down the generated type scale and one step down the space scale,
/// for a laptop screen where the popover would otherwise scroll.
enum TFDensity: String, CaseIterable {
    case compact, comfortable

    static let defaultsKey = "density"
    static var stored: TFDensity {
        TFDensity(rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? "") ?? .comfortable
    }
    var title: String { self == .compact ? "Compact" : "Comfortable" }
    private var tight: Bool { self == .compact }

    // space — every value is a step of DesignTokens.space
    var pad: CGFloat { tight ? DesignTokens.space[4] : TF.pad }           // 10 : 14
    var sectionGap: CGFloat { tight ? DesignTokens.space[3] : 11 }        // 8 : 11
    var rowGap: CGFloat { tight ? DesignTokens.space[1] : DesignTokens.space[2] } // 4 : 6
    var cardPadH: CGFloat { tight ? DesignTokens.space[2] : DesignTokens.space[4] } // 6 : 10
    var cardPadV: CGFloat { tight ? DesignTokens.space[1] : 7 }           // 4 : 7
    var rowHeight: CGFloat { tight ? 17 : 20 }
    var meterHeight: CGFloat { tight ? 4 : 5 }
    var sparkHeight: CGFloat { tight ? 16 : 22 }

    // type — one rung of the generated scale apart, never below the smallest
    var microSize: CGFloat { DesignTokens.fsMicro }                       // 10.5
    var labelSize: CGFloat { tight ? DesignTokens.fsMicro : DesignTokens.fsLabel }   // 10.5 : 11.5
    var bodySize: CGFloat { tight ? DesignTokens.fsLabel : DesignTokens.fsCaption }  // 11.5 : 12.5
    var titleSize: CGFloat { tight ? DesignTokens.fsCaption : DesignTokens.fsBody }  // 12.5 : 13.5

    func micro(_ w: Font.Weight = .regular) -> Font { .system(size: microSize, weight: w) }
    func label(_ w: Font.Weight = .regular) -> Font { .system(size: labelSize, weight: w) }
    func body(_ w: Font.Weight = .regular) -> Font { .system(size: bodySize, weight: w) }
    func figure(_ w: Font.Weight = .semibold) -> Font {
        .system(size: bodySize, weight: w).monospacedDigit()
    }
    func microFigure(_ w: Font.Weight = .semibold) -> Font {
        .system(size: microSize, weight: w).monospacedDigit()
    }
}

// ========================================================= global hotkey ====

/// The shortcut that toggles the popover from anywhere.
///
/// A system-wide hotkey is a scarce resource shared with every other app, so
/// TokenFlow claims one and offers a single alternative rather than a full
/// recorder that could shadow something important.
enum TFHotkey: String, CaseIterable {
    case controlOptionT, controlCommandT

    static let defaultsKey = "hotkey"
    static var stored: TFHotkey {
        TFHotkey(rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? "") ?? .controlOptionT
    }
    var title: String { self == .controlOptionT ? "⌃⌥T" : "⌃⌘T" }
    var keyCode: UInt32 { UInt32(kVK_ANSI_T) }
    var modifiers: UInt32 {
        self == .controlOptionT ? UInt32(controlKey | optionKey) : UInt32(controlKey | cmdKey)
    }
}

// ============================================================ state/model ===

final class StatusModel: ObservableObject {
    @Published var status: TFStatus?
    @Published var refreshing = false
    @Published var actionError: String?
    /// Read once per load, not per render — liveness costs a file read.
    @Published var watcherLive = false
    @Published var dashboardStarting = false

    /// Called when a live session's guard level RISES to warn or block.
    /// The app delegate hangs the transient alert card off this.
    var onEscalation: ((TFStatus.LiveSession) -> Void)?
    /// Guard level per session id as of the previous successful load.
    /// `nil` means "no load has succeeded yet", which is not the same as
    /// "every session was fine" and must not raise an alert.
    private var seenGuardLevels: [String: Int]?

    func load() {
        let next = loadStatus()
        let escalated = next.flatMap { escalation(in: $0) }
        status = next
        watcherLive = watcherLockIsLive()
        if let escalated { onEscalation?(escalated) }
    }

    /// The most severe session whose guard level rose since the last load.
    ///
    /// Rises only. Going from block back to warn is a recovery, and a card
    /// that slides out to announce good news would train people to ignore it.
    /// A session appearing already at warn counts as a rise, because the
    /// crossing happened while we were watching; a session already at warn on
    /// the FIRST load does not, or every launch would fire a card.
    private func escalation(in next: TFStatus) -> TFStatus.LiveSession? {
        let sessions = next.liveSessions?.sessions ?? []
        var levels: [String: Int] = [:]
        for s in sessions {
            guard let id = s.sessionId else { continue }
            levels[id] = guardRank(s.guardState?.level)
        }
        defer { seenGuardLevels = levels }
        guard let before = seenGuardLevels else { return nil }

        var best: (session: TFStatus.LiveSession, rank: Int)?
        for s in sessions {
            guard let id = s.sessionId else { continue }
            let now = guardRank(s.guardState?.level)
            guard now > 0, now > (before[id] ?? 0) else { continue }
            if best == nil || now > best!.rank { best = (s, now) }
        }
        return best?.session
    }
}

struct AppActions {
    var refresh: () -> Void = {}
    var openDashboard: () -> Void = {}
    var toggleWatcher: () -> Void = {}
    var runSetup: () -> Void = {}
    var cycleTheme: () -> Void = {}
    var quit: () -> Void = {}
    /// Ask for a dollar figure and hand it to `tokenflow guard --set`.
    var raiseCostCap: () -> Void = {}
    /// Clear all five guard thresholds at once.
    var clearCaps: () -> Void = {}
    /// Persist the shortcut and re-register it with Carbon.
    var setHotkey: (TFHotkey) -> Void = { _ in }
}

// ============================================================ app delegate ==

@objc final class AppDelegate: NSObject, NSApplicationDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    let model = StatusModel()
    private var outsideMonitor: Any?
    private var insideMonitor: Any?
    private var keyMonitor: Any?
    /// The transient guard card. One at a time, never modal.
    private let alerts = TFAlertPanel()
    private var hotKeyRef: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?

    func applicationWillTerminate(_ note: Notification) {
        if let m = outsideMonitor { NSEvent.removeMonitor(m) }
        if let m = insideMonitor { NSEvent.removeMonitor(m) }
        if let m = keyMonitor { NSEvent.removeMonitor(m) }
        if let ref = hotKeyRef { UnregisterEventHotKey(ref) }
        if let h = hotKeyHandler { RemoveEventHandler(h) }
    }

    lazy var actions: AppActions = AppActions(
        refresh: { [weak self] in self?.runCLI(["watch", "--once"]) },
        openDashboard: { [weak self] in self?.openDashboard() },
        toggleWatcher: { [weak self] in self?.toggleWatcherAction() },
        runSetup: { [weak self] in self?.runCLI(["setup"]) },
        cycleTheme: { [weak self] in self?.cycleThemeAction() },
        quit: { NSApp.terminate(nil) },
        raiseCostCap: { [weak self] in self?.raiseCostCapAction() },
        clearCaps: { [weak self] in self?.clearCapsAction() },
        setHotkey: { [weak self] hk in self?.setHotkeyAction(hk) })

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
                  // The transient alert card is ours too. Without this, a click
                  // on the card closes the popover and the card's own tap
                  // handler reopens it a frame later.
                  !self.alerts.owns(hitWindow),
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
        // Set BEFORE the first load: the model suppresses alerts on the load
        // that has nothing to compare against, so this cannot fire a card for
        // a session that was already warning when the app launched.
        model.onEscalation = { [weak self] session in self?.showGuardAlert(session) }
        model.load()
        installHotkey(TFHotkey.stored)
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
        // The click path animates; the keyboard path does not, so the flag is
        // set on entry to each rather than saved and restored.
        popover.animates = true
        if popover.isShown { popover.performClose(nil); return }
        model.load()
        renderTitle()
        guard let button = item.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }

    // ---- global hotkey ------------------------------------------------------

    /// Claim the shortcut, replacing whatever was claimed before.
    ///
    /// Carbon, because there is no Cocoa API for a hotkey that fires while
    /// another application is frontmost. The event handler is installed once;
    /// only the registration is swapped when the preference changes.
    private func installHotkey(_ hk: TFHotkey) {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
        if hotKeyHandler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                     eventKind: UInt32(kEventHotKeyPressed))
            // A @convention(c) callback captures nothing, so the delegate
            // travels as userData and is recovered unretained.
            InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
                guard let userData else { return noErr }
                let me = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async { me.hotkeyFired() }
                return noErr
            }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &hotKeyHandler)
        }
        let id = EventHotKeyID(signature: OSType(0x5446_4C57 /* 'TFLW' */), id: 1)
        RegisterEventHotKey(hk.keyCode, hk.modifiers, id,
                            GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    /// Toggle with no open or close animation. A keyboard action should land
    /// the moment the keys go down.
    fileprivate func hotkeyFired() {
        popover.animates = false
        if popover.isShown { popover.performClose(nil); return }
        model.load()
        renderTitle()
        guard let button = item.button else { return }
        // An accessory app is never frontmost, so without this the popover
        // opens unfocused and the Escape monitor never sees a key.
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }

    private func setHotkeyAction(_ hk: TFHotkey) {
        UserDefaults.standard.set(hk.rawValue, forKey: TFHotkey.defaultsKey)
        installHotkey(hk)
    }

    // ---- transient guard alert ---------------------------------------------

    /// A live session's guard level just rose. Show the card under the status
    /// item; clicking it opens the popover on the section that explains why.
    private func showGuardAlert(_ session: TFStatus.LiveSession) {
        guard let button = item.button, let win = button.window else { return }
        let anchor = win.convertToScreen(button.convert(button.bounds, to: nil))
        alerts.show(session: session, density: TFDensity.stored, anchor: anchor) { [weak self] in
            guard let self, !self.popover.isShown else { return }
            self.togglePopover(nil)
        }
    }

    // ---- guard caps ---------------------------------------------------------

    /// Ask for a dollar figure, then write it through the CLI.
    ///
    /// The app never edits config.yaml itself: `tokenflow guard --set` is the
    /// one writer, so the menu bar and the hook can never disagree about what
    /// the caps are.
    private func raiseCostCapAction() {
        let alert = NSAlert()
        alert.messageText = "Raise the cost cap"
        alert.informativeText = "The guard stops a session once it passes this figure. Enter dollars."
        alert.addButton(withTitle: "Set cap")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 24))
        field.placeholderString = "for example 50"
        if let current = model.status?.guard?.policy?.maxCostUsd, current.isFinite {
            field.stringValue = plainNumber(current)
        }
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        // An accessory app has no key window, so the sheet would come up with
        // the text field unfocused and look frozen.
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let raw = field.stringValue
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespaces)
        guard let value = Double(raw), value.isFinite, value > 0 else {
            model.actionError = "Enter a dollar amount above zero."
            return
        }
        setGuard("maxCostUsd=\(plainNumber(value))")
    }

    /// Clear all five thresholds. An empty value removes a key, which is the
    /// documented contract of `applySet` in src/commands/guard.js.
    private func clearCapsAction() {
        let spec = ["warnCostUsd", "maxCostUsd", "warnContextTokens",
                    "maxContextTokens", "warnMarginalUsd"]
            .map { "\($0)=" }
            .joined(separator: ",")
        setGuard(spec)
    }

    /// Write a guard spec, then run one refresh cycle.
    ///
    /// `--set` writes config.yaml; status.json only learns the new policy on
    /// the next cycle, so without the second run the popover would keep
    /// showing the caps the user just changed.
    private func setGuard(_ spec: String) {
        runCLI(["guard", "--set", spec]) { [weak self] in
            self?.runCLI(["watch", "--once"])
        }
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
        case "exceeded": tint = NSColor(dkHex: DesignTokens.StatusHex.critical); prefix = "✗ "
        case "warn": tint = NSColor(dkHex: DesignTokens.StatusHex.warning); prefix = "▲ "
        case "ok": tint = NSColor(dkHex: DesignTokens.StatusHex.good); prefix = "● "
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

    /// Run one CLI command. `then` runs after a SUCCESSFUL exit, once the
    /// status file has been re-read, so one action can chain into a refresh.
    private func runCLI(_ args: [String], then next: (() -> Void)? = nil) {
        guard !model.refreshing, let proc = makeProcess(args, detached: false) else { return }
        model.refreshing = true
        renderTitle()
        proc.terminationHandler = { [weak self] p in
            DispatchQueue.main.async {
                guard let self else { return }
                self.model.refreshing = false
                let failed = p.terminationReason == .uncaughtSignal || p.terminationStatus != 0
                if failed {
                    self.model.actionError = "\(args.first ?? "command") exited (\(p.terminationStatus))"
                }
                self.model.load()
                self.renderTitle()
                if !failed { next?() }
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
                    .fill(TF.accentSolid)
                Image(systemName: "bolt.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(TF.accentInk)
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
                    .foregroundColor(TF.accentInk)
                Text(m.detail ?? "")
                    .font(.system(size: 10.5))
                    .foregroundColor(TF.accentInk.opacity(0.85))
                    .lineLimit(2)
            }
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        // A solid accent surface: the system allows a gradient only behind a
        // single hero number, never behind text or a mark.
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(TF.accentSolid))
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
    var d: TFDensity = .comfortable

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
        .frame(height: d.rowHeight)
    }
}

private struct SourceRow: View {
    // Same grid as ProviderRow but with a square glyph: source is "which app",
    // provider is "whose model" — the shape difference makes that legible.
    let index: Int
    let row: TFStatus.ProviderRow
    let maxTokens: Double
    var d: TFDensity = .comfortable

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
        .frame(height: d.rowHeight)
    }
}

private struct ModelRow: View {
    let row: TFStatus.ProviderRow
    let maxTokens: Double
    var d: TFDensity = .comfortable

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
        .frame(height: d.rowHeight)
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
    var d: TFDensity = .comfortable
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
        }.frame(height: d.rowHeight)
    }
}
private struct ForecastBlock: View {
    let f: TFStatus.Forecast
    var d: TFDensity = .comfortable
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
                             cost: f.monthEndCost, d: d)
                if let wk = f.next7days {
                    ForecastLine(icon: "calendar", label: "Next week",
                                 tokens: wk, cost: f.next7daysCost, d: d)
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
    var d: TFDensity = .comfortable
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
        .padding(.horizontal, d.cardPadH).padding(.vertical, d.cardPadV)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(TF.cardBG(cs)))
    }
}

private struct SessionBlockRow: View {
    let b: TFStatus.SessionBlock
    var d: TFDensity = .comfortable

    var body: some View {
        let expired = (b.resetsInMs ?? 0) <= 0
        let tint = b.key == "anthropic" ? TF.palette[1] : TF.palette[2]
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
                                             : AnyShapeStyle(TF.warn))
            }
        }
        .padding(.horizontal, d.cardPadH).padding(.vertical, d.cardPadV)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(tint.opacity(0.07)))
    }
}

// ============================================= glance sections (roadmap §3) ==
//
// Live ticker, today's receipts, guard state and per-source sparklines. Each
// one is drawn only when its key is PRESENT in status.json: a file written
// before these existed shows exactly what it showed before, not three new
// rows apologising for data it was never asked to carry. A key that is present
// but empty is a different fact, and gets an empty state that says so.

/// How much of the context window this session is re-sending.
private struct ContextGauge: View {
    let tokens: Double?
    let cap: Double
    let d: TFDensity

    var body: some View {
        // The fill is the accent, never a status colour: this is a quantity,
        // and status hues are reserved for the guard dot beside it.
        VStack(alignment: .trailing, spacing: 2) {
            TFMeter(fraction: cap > 0 ? max(0, tokens ?? 0) / cap : 0,
                    color: TF.accent, height: d.meterHeight)
                .frame(width: 52)
            Text(label).font(d.micro()).foregroundStyle(.secondary).monospacedDigit()
        }
    }

    private var label: String {
        guard let t = tokens, t.isFinite else { return "of \(compactTokens(cap))" }
        return "\(compactTokens(t)) of \(compactTokens(cap))"
    }
}

private struct LiveSessionRow: View {
    let session: TFStatus.LiveSession
    let contextCap: Double
    let d: TFDensity
    @Environment(\.colorScheme) private var cs

    private var level: String? { session.guardState?.level }
    private var place: String {
        session.project ?? session.repository ?? "unknown project"
    }
    private var title: String {
        guard let b = session.branch, !b.isEmpty else { return place }
        return "\(place) · \(b)"
    }
    private var subtitle: String {
        var bits: [String] = []
        if let m = session.model, !m.isEmpty { bits.append(m) }
        bits.append("\(session.turns ?? 0) turns")
        if let sub = session.subagentTurns, sub > 0 { bits.append("\(sub) subagent") }
        return bits.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: DesignTokens.space[3]) {
            Circle().fill(guardColor(level)).frame(width: 7, height: 7)
                .help(guardHelp(level))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(d.body(.medium)).lineLimit(1).truncationMode(.middle)
                Text(subtitle).font(d.micro()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: DesignTokens.space[2])
            ContextGauge(tokens: session.contextTokens, cap: contextCap, d: d)
            Text(moneyOrBlank(session.costUsd))
                .font(d.figure()).frame(width: 46, alignment: .trailing)
        }
        .padding(.horizontal, d.cardPadH).padding(.vertical, d.cardPadV)
        .background(RoundedRectangle(cornerRadius: DesignTokens.radiusSm, style: .continuous)
            .fill(TF.cardBG(cs)))
    }
}

private struct ReceiptRow: View {
    let index: Int
    let item: TFStatus.ReceiptItem
    let d: TFDensity

    var body: some View {
        HStack(spacing: DesignTokens.space[3]) {
            RoundedRectangle(cornerRadius: 2.5)
                .fill(TF.palette[index % TF.palette.count])
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.repo ?? "unknown repo").font(d.body(.medium)).lineLimit(1)
                Text(item.branch ?? "no branch").font(d.micro())
                    .foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: DesignTokens.space[2])
            Text("\(item.turns ?? 0) turns")
                .font(d.microFigure(.regular)).foregroundStyle(.secondary)
            Text(moneyOrBlank(item.costUsd))
                .font(d.figure()).frame(width: 46, alignment: .trailing)
        }
        .padding(.vertical, d.cardPadV / 2)
    }
}

/// A small pill button, for the two guard actions.
private struct GlanceButton: View {
    let title: String
    let d: TFDensity
    var prominent = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: d.labelSize, weight: .semibold))
                .padding(.horizontal, DesignTokens.space[4])
                .padding(.vertical, DesignTokens.space[1])
                .background(Capsule().fill(prominent
                    ? AnyShapeStyle(TF.accent)
                    : AnyShapeStyle(Color.primary.opacity(0.07))))
                .foregroundStyle(prominent
                    ? AnyShapeStyle(TF.accentInk)
                    : AnyShapeStyle(Color.primary))
        }
        .buttonStyle(.plain)
    }
}

/// One source's last 24 hours, drawn as a polyline over a muted baseline.
private struct SparkPath: View {
    let points: [Double]
    let color: Color

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let peak = max(points.max() ?? 0, 1)
            ZStack {
                Path { p in
                    p.move(to: CGPoint(x: 0, y: h - 0.5))
                    p.addLine(to: CGPoint(x: w, y: h - 0.5))
                }
                .stroke(DesignTokens.grid.color, lineWidth: 1)

                Path { p in
                    guard points.count > 1 else { return }
                    for (i, v) in points.enumerated() {
                        let x = w * CGFloat(i) / CGFloat(points.count - 1)
                        let y = h - 1 - (h - 3) * CGFloat(min(1, max(0, v) / peak))
                        if i == 0 { p.move(to: CGPoint(x: x, y: y)) }
                        else { p.addLine(to: CGPoint(x: x, y: y)) }
                    }
                }
                .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            }
        }
    }
}

/// One source id, its polyline, its 24-hour totals.
private struct SparkSeries: Identifiable {
    let id: String
    let name: String
    /// Alphabetical position among ALL source ids. The index is what is
    /// carried, not the resolved colour: the index is the invariant worth
    /// holding, and a dark/light pair has to resolve at draw time anyway.
    /// `nil` marks the summed "other" row, which is not one entity.
    let colorIndex: Int?
    let points: [Double]
    let tokens: Double
    let cost: Double?

    var color: Color {
        guard let colorIndex else { return DesignTokens.textMuted.color }
        return DesignTokens.series(colorIndex)
    }
}

/// Build at most five source series plus a summed "other".
///
/// Colour comes from the source's ALPHABETICAL position, not its rank, so a
/// quiet hour that reorders the list never repaints a source another colour.
/// Which five are shown is by volume; "other" takes the muted text token
/// rather than a series step, because it is not one entity.
private func sparkSeries(_ sp: TFStatus.Sparklines) -> [SparkSeries] {
    let by = sp.bySource ?? [:]
    guard !by.isEmpty else { return [] }

    let alphabetical = by.keys.sorted()
    var colorIndex: [String: Int] = [:]
    for (i, name) in alphabetical.enumerated() { colorIndex[name] = i }

    /// Exactly 24 finite points: pad the front, keep the newest tail.
    func normalise(_ raw: [Double]?) -> [Double] {
        var v = (raw ?? []).map { $0.isFinite ? $0 : 0 }
        if v.count > 24 { v = Array(v.suffix(24)) }
        if v.count < 24 { v = Array(repeating: 0, count: 24 - v.count) + v }
        return v
    }
    func total(_ name: String) -> Double { normalise(by[name]).reduce(0, +) }
    func cost(_ name: String) -> Double { (sp.costBySource?[name] ?? []).filter(\.isFinite).reduce(0, +) }

    let ranked = alphabetical.sorted {
        let a = total($0), b = total($1)
        return a == b ? $0 < $1 : a > b
    }
    var out = ranked.prefix(5).map { name in
        SparkSeries(id: name, name: name, colorIndex: colorIndex[name] ?? 0,
                    points: normalise(by[name]), tokens: total(name),
                    cost: cost(name) > 0 ? cost(name) : nil)
    }
    let rest = ranked.dropFirst(5)
    if !rest.isEmpty {
        var summed = [Double](repeating: 0, count: 24)
        var summedCost = 0.0
        for name in rest {
            let p = normalise(by[name])
            for i in 0..<24 { summed[i] += p[i] }
            summedCost += cost(name)
        }
        out.append(SparkSeries(id: "__other", name: "other", colorIndex: nil,
                               points: summed, tokens: summed.reduce(0, +),
                               cost: summedCost > 0 ? summedCost : nil))
    }
    return out
}

private struct SparkRow: View {
    let series: SparkSeries
    let d: TFDensity

    var body: some View {
        HStack(spacing: DesignTokens.space[3]) {
            Text(series.name).font(d.label()).lineLimit(1).truncationMode(.middle)
                .frame(width: 76, alignment: .leading)
            SparkPath(points: series.points, color: series.color)
                .frame(height: d.sparkHeight)
            Text(compactTokens(series.tokens))
                .font(d.microFigure()).frame(width: 44, alignment: .trailing)
            Text(moneyOrBlank(series.cost))
                .font(d.microFigure(.regular)).foregroundStyle(.secondary)
                .frame(width: 42, alignment: .trailing)
        }
    }
}

/// Density and shortcut, the two preferences that change how the popover
/// behaves rather than what it says.
private struct PrefsRow: View {
    @Binding var density: String
    let hotkey: TFHotkey
    let setHotkey: (TFHotkey) -> Void
    let d: TFDensity

    var body: some View {
        HStack(spacing: DesignTokens.space[3]) {
            Text("Density").font(d.micro()).foregroundStyle(.secondary)
            Picker("", selection: $density) {
                ForEach(TFDensity.allCases, id: \.rawValue) { option in
                    Text(option.title).tag(option.rawValue)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 146)

            Spacer(minLength: DesignTokens.space[2])

            Text("Shortcut").font(d.micro()).foregroundStyle(.secondary)
            Menu(hotkey.title) {
                ForEach(TFHotkey.allCases, id: \.rawValue) { option in
                    Button(option.title) { setHotkey(option) }
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Toggle the popover from any app")
        }
    }
}

// ==================================================== transient guard alert ==

/// The card that leaves the status item when a session crosses a declared cap.
private struct GuardAlertCard: View {
    let session: TFStatus.LiveSession
    let d: TFDensity
    let onOpen: () -> Void
    let onDismiss: () -> Void
    let onHover: (Bool) -> Void

    private var level: String? { session.guardState?.level }
    private var headline: String {
        level == "block" ? "Guard stopped a session." : "Guard is warning about a session."
    }
    private var detail: String {
        var bits = [session.project ?? session.repository ?? "a session"]
        if let b = session.branch, !b.isEmpty { bits.append(b) }
        if let c = session.costUsd, c.isFinite { bits.append(money(c)) }
        return bits.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: DesignTokens.space[3]) {
            Circle().fill(guardColor(level)).frame(width: 8, height: 8)
                .padding(.top, DesignTokens.space[1])
            VStack(alignment: .leading, spacing: 2) {
                Text(headline).font(.system(size: d.bodySize, weight: .semibold)).lineLimit(1)
                Text(detail).font(.system(size: d.microSize)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: DesignTokens.space[3])
            Button(action: onDismiss) {
                Text("Dismiss")
                    .font(.system(size: d.microSize, weight: .semibold))
                    .padding(.horizontal, DesignTokens.space[3])
                    .padding(.vertical, DesignTokens.space[0])
                    .background(Capsule().fill(Color.primary.opacity(0.09)))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, DesignTokens.space[5])
        .padding(.vertical, DesignTokens.space[4])
        .frame(width: TFAlertPanel.width, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: DesignTokens.radiusSm, style: .continuous)
            .fill(Color(nsColor: .windowBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: DesignTokens.radiusSm, style: .continuous)
            .stroke(Color.primary.opacity(0.10), lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .onHover(perform: onHover)
    }
}

/// A hosting view that reports hover even while the app is not active.
///
/// SwiftUI's `.onHover` installs a tracking area that wants a key window, and
/// the alert panel is a non-activating panel owned by an accessory app, so it
/// is never key and never active. Without `.activeAlways` the pause-on-hover
/// would silently never fire. The SwiftUI handler is kept as well; `setHover`
/// is idempotent, so both paths landing costs nothing.
private final class HoverHostingView: NSHostingView<AnyView> {
    var onHoverChange: ((Bool) -> Void)?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self, userInfo: nil))
    }
    override func mouseEntered(with event: NSEvent) { onHoverChange?(true) }
    override func mouseExited(with event: NSEvent) { onHoverChange?(false) }
}

/// The window the card lives in: borderless, non-activating, never modal.
///
/// It arrives and leaves along one path — straight down from the status item
/// and straight back up — so the motion always says where it came from. A
/// second alert does not queue behind the first: the first is sent on its way
/// and the second starts immediately, which is what "interruptible" means.
final class TFAlertPanel {
    static let width: CGFloat = 306

    private var panel: NSPanel?
    /// The card on its way out. Held for the length of the exit animation so
    /// the popover's click monitor still recognises it as ours.
    private weak var retiring: NSPanel?
    private var timer: Timer?
    private var hovering = false
    private var restingFrame = NSRect.zero
    /// Bumped on every show and every dismiss. Timers and animation
    /// completions check it before touching anything, so a stale callback from
    /// the card that was just replaced cannot close the card that replaced it.
    private var generation = 0

    /// Is this window the card, arriving, resting or leaving? The popover's
    /// click monitor asks, so that a click on the card does not close the
    /// popover a frame before the card's own handler opens it.
    func owns(_ w: NSWindow?) -> Bool {
        guard let w else { return false }
        return w === panel || w === retiring
    }

    private var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }
    /// How far the card travels, and the gap it rests at under the status item.
    private var travel: CGFloat { DesignTokens.space[4] }

    func show(session: TFStatus.LiveSession, density: TFDensity,
              anchor: NSRect, onOpen: @escaping () -> Void) {
        generation += 1
        let gen = generation
        timer?.invalidate(); timer = nil
        hovering = false
        if let old = panel { retire(old) }

        let host = HoverHostingView(rootView: AnyView(
            GuardAlertCard(
                session: session, d: density,
                onOpen: { [weak self] in self?.dismiss(); onOpen() },
                onDismiss: { [weak self] in self?.dismiss() },
                onHover: { [weak self] inside in self?.setHover(inside, gen: gen) })))
        host.onHoverChange = { [weak self] inside in self?.setHover(inside, gen: gen) }
        host.layoutSubtreeIfNeeded()
        // Two text lines plus the card's vertical padding. The floor matters:
        // fittingSize can report zero for a view that has never been in a
        // window, and a short panel would clip the second line.
        let floor = density.bodySize + density.microSize + 6 + 2 * DesignTokens.space[4]
        let height = max(floor, host.fittingSize.height)

        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: height),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isFloatingPanel = true
        p.level = .statusBar
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = true
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        // Without this the hover pause never fires: a borderless panel does
        // not track the mouse unless it is asked to.
        p.acceptsMouseMovedEvents = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        p.contentView = host
        panel = p

        let screen = NSScreen.screens.first { $0.frame.intersects(anchor) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let x = min(max(anchor.midX - Self.width / 2, visible.minX + 8),
                    max(visible.minX + 8, visible.maxX - Self.width - 8))
        restingFrame = NSRect(x: x, y: anchor.minY - height - travel,
                              width: Self.width, height: height)
        // Flush under the status item, then down. Never over the menu bar.
        let start = NSRect(x: x, y: anchor.minY - height, width: Self.width, height: height)

        p.setFrame(reduceMotion ? restingFrame : start, display: false)
        p.alphaValue = 0
        p.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = DesignTokens.durBase
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            if !reduceMotion { p.animator().setFrame(restingFrame, display: true) }
            p.animator().alphaValue = 1
        }
        arm(gen: gen)
    }

    /// Send the card back the way it came.
    func dismiss() {
        generation += 1
        timer?.invalidate(); timer = nil
        hovering = false
        guard let p = panel else { return }
        panel = nil
        retire(p)
    }

    /// Animate one panel out and drop it. Safe to call while another panel is
    /// arriving: the closure owns the only remaining reference.
    private func retire(_ p: NSPanel) {
        retiring = p
        // A card that is leaving stops taking clicks. Dismiss means dismissed,
        // even while the last frames of the animation are still on screen.
        p.ignoresMouseEvents = true
        let back = NSRect(x: restingFrame.minX, y: restingFrame.minY + travel,
                          width: p.frame.width, height: p.frame.height)
        let reduce = reduceMotion
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = DesignTokens.durBase
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            if !reduce { p.animator().setFrame(back, display: true) }
            p.animator().alphaValue = 0
        }, completionHandler: { p.orderOut(nil) })
    }

    /// Auto dismiss after 8 s. Hovering stops the clock; leaving restarts it.
    private func arm(gen: Int) {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 8.0, repeats: false) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.generation == gen, !self.hovering else { return }
                self.dismiss()
            }
        }
    }

    private func setHover(_ inside: Bool, gen: Int) {
        guard generation == gen else { return }
        hovering = inside
        if inside { timer?.invalidate(); timer = nil } else { arm(gen: gen) }
    }
}

// ------------------------------------------------------------------- root ----

struct MenuContentView: View {
    @ObservedObject var model: StatusModel
    var actions: AppActions
    /// Forces a density regardless of the preference. Only the off-screen
    /// preview renderer uses it, so a screenshot run never writes defaults.
    var densityOverride: TFDensity? = nil

    @AppStorage(TFDensity.defaultsKey) private var densityPref = TFDensity.comfortable.rawValue
    @AppStorage(TFHotkey.defaultsKey) private var hotkeyPref = TFHotkey.controlOptionT.rawValue

    private var d: TFDensity {
        densityOverride ?? TFDensity(rawValue: densityPref) ?? .comfortable
    }
    private var hotkey: TFHotkey { TFHotkey(rawValue: hotkeyPref) ?? .controlOptionT }

    private var s: TFStatus? { model.status }
    private var hasData: Bool { (s?.health?.records ?? 0) > 0 }
    /// One source of truth for "is it live": the watcher's own lock file,
    /// boot-verified. `status.watcher` only records that a watcher once ran.
    private var watcherLive: Bool { model.watcherLive }
    private var updatedAge: Double? {
        guard let d = s?.lastRefreshDate else { return nil }
        return Date().timeIntervalSince(d) * 1000
    }
    /// What the context gauge measures against: the declared cap when there is
    /// one, otherwise the 200K window every current frontier model shares.
    private var contextCap: Double {
        if let m = s?.guard?.policy?.maxContextTokens, m.isFinite, m > 0 { return m }
        return 200_000
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            contentBody
        }
        .frame(maxHeight: 640)
    }

    private var contentBody: some View {
        VStack(alignment: .leading, spacing: d.sectionGap) {
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

                // The glanceable trio, above the historical breakdowns: what
                // is running now, what today cost per branch, what the guard
                // is holding you to.
                liveSection
                receiptsSection
                guardSection

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
                            ProviderWindowRow(index: i, w: w, d: d)
                        }
                    }
                    NoteText("measured rolling usage per tool · hour granularity")
                }

                if let blocks = s?.sessionBlocks, !blocks.isEmpty {
                    SectionHeader("Sessions · 5h model")
                    VStack(spacing: 7) {
                        ForEach(blocks, id: \.key) { b in
                            SessionBlockRow(b: b, d: d)
                        }
                    }
                }

                if let provs = s?.providersToday, !provs.isEmpty {
                    SectionHeader("Today by provider")
                    VStack(spacing: 7) {
                        let maxTokens = provs.compactMap(\.tokens).max() ?? 0
                        ForEach(Array(provs.filter { ($0.tokens ?? 0) > 0 }.prefix(5).enumerated()),
                                id: \.offset) { i, p in
                            ProviderRow(index: i, row: p, maxTokens: maxTokens, d: d)
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
                            SourceRow(index: i, row: p, maxTokens: maxTokens, d: d)
                        }
                    }
                }

                sparklineSection

                if let models = s?.modelsToday, !models.isEmpty {
                    SectionHeader("Top models today")
                    VStack(spacing: 7) {
                        let maxTokens = models.compactMap(\.tokens).max() ?? 0
                        ForEach(Array(models.filter { ($0.tokens ?? 0) > 0 }.prefix(5).enumerated()),
                                id: \.offset) { i, mrow in
                            ModelRow(row: mrow, maxTokens: maxTokens, d: d)
                        }
                    }
                }

                SectionHeader("Capacity")
                capacityBlock

                if let f = s?.forecast, f.tomorrow != nil {
                    ForecastBlock(f: f, d: d)
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
                PrefsRow(density: $densityPref, hotkey: hotkey,
                         setHotkey: actions.setHotkey, d: d)
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
        .padding(d.pad)
        .frame(width: TF.width)
        // Opaque, appearance-adaptive backdrop: the popover supplies one at
        // runtime, but off-screen previews composite transparency as black,
        // which made light-mode text unreadable.
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // ---- the glanceable sections ------------------------------------------
    //
    // Each one draws only when its key is present. `if let` on an optional
    // section IS the absent test: a status.json from an older CLI carries none
    // of them and the popover looks exactly as it did before.

    @ViewBuilder private var liveSection: some View {
        if let live = s?.liveSessions {
            let sessions = live.sessions ?? []
            // "as of" and not "now": this is the last refresh cycle's picture,
            // and a ticker that implies real time would be lying by a minute.
            SectionHeader("Live, as of \(relativeAge(msSince(live.asOf)))")
            if sessions.isEmpty {
                NoteText("No session active in the last \(live.windowMinutes ?? 10) minutes.")
            } else {
                VStack(spacing: d.rowGap) {
                    ForEach(Array(sessions.prefix(3).enumerated()), id: \.offset) { _, sess in
                        LiveSessionRow(session: sess, contextCap: contextCap, d: d)
                    }
                }
                if sessions.count > 3 {
                    NoteText("\(sessions.count - 3) more running.")
                }
            }
        }
    }

    @ViewBuilder private var receiptsSection: some View {
        if let receipts = s?.receiptsToday {
            let items = receipts.items ?? []
            SectionHeader("Today's receipts")
            if items.isEmpty {
                NoteText("No branch spend recorded today.")
            } else {
                VStack(spacing: d.rowGap) {
                    ForEach(Array(items.prefix(3).enumerated()), id: \.offset) { i, item in
                        ReceiptRow(index: i, item: item, d: d)
                    }
                }
                if let total = receipts.totalCostUsd, total.isFinite {
                    NoteText("\(money(total)) today across \(items.count) branches.")
                }
            }
        }
    }

    @ViewBuilder private var guardSection: some View {
        if let g = s?.guard {
            SectionHeader("Guard")
            VStack(alignment: .leading, spacing: d.rowGap) {
                Text(capsLine(g)).font(d.body()).lineLimit(2)
                if let v = g.lastVerdict {
                    HStack(alignment: .top, spacing: DesignTokens.space[2]) {
                        Circle().fill(guardColor(v.level)).frame(width: 7, height: 7)
                            .padding(.top, 3)
                        Text(verdictLine(v)).font(d.micro())
                            .foregroundStyle(.secondary).lineLimit(2)
                    }
                } else {
                    NoteText("No verdict yet.")
                }
                HStack(spacing: DesignTokens.space[3]) {
                    GlanceButton(title: "Raise cost cap", d: d, prominent: true,
                                 action: actions.raiseCostCap)
                    GlanceButton(title: "Clear caps", d: d, action: actions.clearCaps)
                    Spacer()
                }
            }
        }
    }

    /// The caps you declared, in the order the CLI stores them.
    private func capsLine(_ g: TFStatus.GuardBlock) -> String {
        var bits: [String] = []
        if let v = g.policy?.warnCostUsd { bits.append("warn at \(money(v))") }
        if let v = g.policy?.maxCostUsd { bits.append("stop at \(money(v))") }
        if let v = g.policy?.warnContextTokens { bits.append("warn at \(compactTokens(v)) context") }
        if let v = g.policy?.maxContextTokens { bits.append("stop at \(compactTokens(v)) context") }
        if let v = g.policy?.warnMarginalUsd { bits.append("warn at \(money(v)) a turn") }
        return bits.isEmpty ? "No caps set" : bits.joined(separator: " · ")
    }

    private func verdictLine(_ v: TFStatus.GuardBlock.Verdict) -> String {
        let head = "Last verdict \(v.level ?? "ok"), \(relativeAge(msSince(v.at)))"
        let reasons = (v.reasons ?? []).joined(separator: "; ")
        return reasons.isEmpty ? head + "." : head + ". " + reasons + "."
    }

    @ViewBuilder private var sparklineSection: some View {
        if let sp = s?.sparklines {
            let rows = sparkSeries(sp)
            SectionHeader("Last 24 hours by source")
            if rows.isEmpty {
                NoteText("No hourly usage recorded yet.")
            } else {
                VStack(spacing: d.rowGap) {
                    ForEach(rows) { row in
                        SparkRow(series: row, d: d)
                    }
                }
                NoteText("tokens per hour, last 24 h")
            }
        }
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
        guard let status = model.status else {
            FileHandle.standardError.write(Data("preview: no status at \(Paths.statusFile)\n".utf8))
            exit(1)
        }
        for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
            // The two existing filenames keep their meaning: comfortable is
            // still what "<prefix>-light.png" shows.
            snapshot(MenuContentView(model: model, actions: AppActions(),
                                     densityOverride: .comfortable)
                        .environment(\.colorScheme, scheme),
                     size: NSSize(width: 360, height: 640),
                     to: "\(prefix)-\(name).png", label: name)
            snapshot(MenuContentView(model: model, actions: AppActions(),
                                     densityOverride: .compact)
                        .environment(\.colorScheme, scheme),
                     size: NSSize(width: 360, height: 640),
                     to: "\(prefix)-compact-\(name).png", label: "compact-\(name)")

            // The transient card is its own window at runtime, so it is
            // snapshotted on its own. It needs a live session to describe; with
            // none in the file there is nothing honest to draw.
            if let session = status.liveSessions?.sessions?.first {
                snapshot(GuardAlertCard(session: session, d: .comfortable,
                                        onOpen: {}, onDismiss: {}, onHover: { _ in })
                            .padding(DesignTokens.space[3])
                            .background(Color(nsColor: .windowBackgroundColor))
                            .environment(\.colorScheme, scheme),
                         size: NSSize(width: TFAlertPanel.width + 2 * DesignTokens.space[3], height: 76),
                         to: "\(prefix)-alert-\(name).png", label: "alert-\(name)")
            }
        }
    }

    /// ImageRenderer cannot draw ScrollView content off-screen (it renders
    /// fully transparent), so the view is laid out in an off-screen hosting
    /// window and its layer is snapshotted instead.
    @MainActor
    private static func snapshot<V: View>(_ view: V, size: NSSize, to path: String, label: String) {
        let controller = NSHostingController(rootView: AnyView(view))
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = controller.view
        controller.view.frame = NSRect(origin: .zero, size: size)
        controller.view.layoutSubtreeIfNeeded()
        guard let bitmap = controller.view.bitmapImageRepForCachingDisplay(in: controller.view.bounds) else {
            FileHandle.standardError.write(Data("preview: failed to render \(label)\n".utf8))
            return
        }
        controller.view.cacheDisplay(in: controller.view.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write(Data("preview: failed to render \(label)\n".utf8))
            return
        }
        try? png.write(to: URL(fileURLWithPath: path))
        print("wrote \(path) (\(bitmap.pixelsWide)x\(bitmap.pixelsHigh))")
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
