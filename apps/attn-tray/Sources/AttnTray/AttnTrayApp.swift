// AttnTray — macOS menubar app for attention-router.
//
// Two surfaces:
//   1. Persistent icon in the top menubar (NSStatusItem). Badge shows
//      pending count. Click → opens the decision window manually.
//   2. A FLOATING window that auto-pops up above every other app the
//      moment a NEW pending card is detected by the poller. This is the
//      "push" surface the user actually needs.
//
// One process. No Dock icon (.accessory activation policy).

import AppKit
import Combine
import SwiftUI

// MARK: - Daemon types

struct AskOption: Decodable, Identifiable {
  let id: String
  let label: String
  let evidence: [String]
  let predicted_next_step: String
  let cost_if_wrong: String
  let confidence: Double
}

struct Ask: Decodable {
  let id: String
  let project_name: String
  let title: String
  let context: String
  let options: [AskOption]
  let default_option_id: String
  let expires_in_seconds: Int
  let requested_human_seconds: Int
  let created_at: String
}

struct CouncilSummary: Decodable {
  let predicted_human_choice: String?
  let entropy: Double?
}

struct BidSummary: Decodable {
  let score: Double?
  let reason: String?
}

struct Record: Decodable, Identifiable {
  let ask: Ask
  let status: String
  let urgency: String?
  let council: CouncilSummary?
  let bid: BidSummary?
  var id: String { ask.id }
}

struct NextResponse: Decodable {
  let batch: [Record]
}

// MARK: - Daemon client

enum DaemonError: Error { case http(Int, String) }

actor Daemon {
  let baseURL: URL
  let token: String?

  init() {
    let env = ProcessInfo.processInfo.environment
    let raw = env["AR_ROUTER_URL"] ?? "http://\(env["AR_HOST"] ?? "127.0.0.1"):\(env["AR_PORT"] ?? "7777")"
    self.baseURL = URL(string: raw)!
    self.token = env["AR_AUTH_TOKEN"]
  }

  private func req(_ method: String, _ path: String, body: Data? = nil) -> URLRequest {
    var r = URLRequest(url: baseURL.appendingPathComponent(path))
    r.httpMethod = method
    r.setValue("application/json", forHTTPHeaderField: "content-type")
    if let t = token { r.setValue("Bearer \(t)", forHTTPHeaderField: "authorization") }
    r.httpBody = body
    return r
  }

  func nextBatch() async throws -> [Record] {
    let r = req("GET", "/next?max=3")
    NSLog("[attn-tray] GET %@", r.url?.absoluteString ?? "(nil url)")
    let (data, resp) = try await URLSession.shared.data(for: r)
    guard let h = resp as? HTTPURLResponse else {
      throw DaemonError.http(-1, "no HTTP response")
    }
    NSLog("[attn-tray] response status=%d bytes=%d", h.statusCode, data.count)
    guard h.statusCode == 200 else {
      throw DaemonError.http(h.statusCode, String(data: data, encoding: .utf8) ?? "")
    }
    return try JSONDecoder().decode(NextResponse.self, from: data).batch
  }

  /// Exposed for the popover error view.
  func currentURL() -> String { baseURL.absoluteString }

  func decide(askId: String, choice: String, override: String? = nil) async throws {
    var body: [String: Any] = ["ask_id": askId, "choice": choice, "create_rule": true]
    if let o = override { body["override_text"] = o }
    let data = try JSONSerialization.data(withJSONObject: body)
    let (rd, resp) = try await URLSession.shared.data(for: req("POST", "/decisions", body: data))
    guard let h = resp as? HTTPURLResponse, (200..<300).contains(h.statusCode) else {
      throw DaemonError.http((resp as? HTTPURLResponse)?.statusCode ?? -1, String(data: rd, encoding: .utf8) ?? "")
    }
  }

  func skip(askId: String) async throws {
    let data = try JSONSerialization.data(withJSONObject: ["id": askId])
    _ = try await URLSession.shared.data(for: req("POST", "/skip", body: data))
  }
}

// MARK: - Polling state

@MainActor
final class Poller: ObservableObject {
  @Published var batch: [Record] = []
  @Published var statusText: String = "polling…"
  @Published var lastError: String? = nil
  private let daemon = Daemon()
  private let intervalSec: TimeInterval
  private var seenIds = Set<String>()
  private var firstPoll = true

  /// Fires when at least one ID appears that the poller hasn't seen before.
  /// Skipped on the very first poll so existing pending cards don't pop the
  /// window the moment AttnTray launches.
  var onNewCard: (() -> Void)?

  init() {
    let raw = ProcessInfo.processInfo.environment["AR_TRAY_INTERVAL_SEC"] ?? "5"
    self.intervalSec = Double(raw) ?? 5
    Task { await self.loop() }
  }

  func loop() async {
    while true {
      do {
        let recs = try await daemon.nextBatch()
        let newIds = recs.map(\.ask.id).filter { !seenIds.contains($0) }
        for id in newIds { seenIds.insert(id) }
        batch = recs
        statusText = recs.isEmpty ? "inbox zero" : "\(recs.count) pending"
        lastError = nil
        if !newIds.isEmpty && !firstPoll {
          onNewCard?()
        }
        firstPoll = false
      } catch {
        // Surface the actual error to the popover instead of a generic line —
        // makes 'daemon unreachable' actionable (DNS? port? auth? ATS?).
        let detail = "\(error)"
        lastError = "ERROR: \(detail.prefix(200))"
        statusText = "error"
        NSLog("[attn-tray] poll error: %@", detail)
      }
      try? await Task.sleep(nanoseconds: UInt64(intervalSec * 1_000_000_000))
    }
  }

  /// Exposed for the popover error view.
  func daemonURL() async -> String { await daemon.currentURL() }

  func decide(_ choice: String) async {
    guard let rec = batch.first else { return }
    try? await daemon.decide(askId: rec.ask.id, choice: choice)
    await refreshNow()
  }

  func override(_ text: String) async {
    guard let rec = batch.first, !text.isEmpty else { return }
    try? await daemon.decide(askId: rec.ask.id, choice: "override", override: text)
    await refreshNow()
  }

  func skipCurrent() async {
    guard let rec = batch.first else { return }
    try? await daemon.skip(askId: rec.ask.id)
    await refreshNow()
  }

  private func refreshNow() async {
    if let recs = try? await daemon.nextBatch() {
      batch = recs
      statusText = recs.isEmpty ? "inbox zero" : "\(recs.count) pending"
    }
  }
}

// MARK: - Card view (shared between popover & floating window)

struct CardContent: View {
  @ObservedObject var poller: Poller
  @State private var overrideText: String = ""
  @State private var showOverride: Bool = false
  let onDismiss: () -> Void

  var body: some View {
    if let rec = poller.batch.first {
      cardView(rec)
    } else {
      emptyView
    }
  }

  @State private var diagURL: String = "?"

  private var emptyView: some View {
    VStack(spacing: 10) {
      Image(systemName: "tray").font(.system(size: 40)).foregroundStyle(.secondary)
      Text("Inbox zero").font(.headline)
      Text(poller.statusText).font(.caption).foregroundStyle(.tertiary)
      Text("daemon: \(diagURL)")
        .font(.system(.caption2, design: .monospaced))
        .foregroundStyle(.tertiary)
        .textSelection(.enabled)
      if let err = poller.lastError {
        ScrollView {
          Text(err)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.red)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 80)
      }
    }
    .frame(width: 420, height: 240)
    .padding(20)
    .task { diagURL = await poller.daemonURL() }
  }

  private func cardView(_ rec: Record) -> some View {
    let council = rec.council?.predicted_human_choice
    return VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 6) {
        Text(rec.ask.project_name).font(.caption).foregroundStyle(.secondary)
        Text("·").foregroundStyle(.tertiary)
        Text(rec.urgency ?? "?").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
          .background(urgencyColor(rec.urgency).opacity(0.18))
          .foregroundStyle(urgencyColor(rec.urgency))
          .cornerRadius(3)
        Spacer()
        if poller.batch.count > 1 {
          Text("+\(poller.batch.count - 1) more").font(.caption2).foregroundStyle(.tertiary)
        }
      }

      Text(rec.ask.title)
        .font(.headline)
        .fixedSize(horizontal: false, vertical: true)

      ScrollView {
        Text(rec.ask.context).font(.callout).foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 90)

      Divider()

      ForEach(rec.ask.options) { opt in
        optionButton(opt: opt,
                     isDefault: opt.id == rec.ask.default_option_id,
                     isCouncilPick: opt.id == council)
      }

      Divider()

      HStack {
        Button("Skip") { Task { await poller.skipCurrent(); onDismiss() } }
          .keyboardShortcut("s", modifiers: [.command])
        Spacer()
        Button(showOverride ? "Cancel override" : "Override…") { showOverride.toggle() }
          .keyboardShortcut("o", modifiers: [.command])
      }

      if showOverride {
        TextField("Tell the agent exactly what to do", text: $overrideText, axis: .vertical)
          .textFieldStyle(.roundedBorder)
          .lineLimit(2...4)
        HStack {
          Spacer()
          Button("Submit override") {
            let text = overrideText
            Task { await poller.override(text); onDismiss() }
            overrideText = ""
            showOverride = false
          }
          .buttonStyle(.borderedProminent)
          .disabled(overrideText.trimmingCharacters(in: .whitespaces).isEmpty)
          .keyboardShortcut(.return, modifiers: [.command])
        }
      }

      if let bid = rec.bid?.reason, !bid.isEmpty {
        Text(bid).font(.caption2).foregroundStyle(.tertiary).italic()
          .lineLimit(2)
      }
    }
    .padding(16)
    .frame(width: 480)
  }

  private func optionButton(opt: AskOption, isDefault: Bool, isCouncilPick: Bool) -> some View {
    Button(action: { Task { await poller.decide(opt.id); onDismiss() } }) {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(opt.id).font(.title2.bold()).frame(width: 22)
          Text(opt.label).font(.subheadline.bold()).fixedSize(horizontal: false, vertical: true)
          Spacer()
          if isDefault { tag("default", .blue) }
          if isCouncilPick { tag("council", .purple) }
        }
        Text("→ \(opt.predicted_next_step)").font(.caption).foregroundStyle(.secondary)
        Text("⚠ \(opt.cost_if_wrong)").font(.caption).foregroundStyle(.secondary)
      }
      .padding(8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 6).fill(Color(NSColor.controlBackgroundColor)))
    }
    .buttonStyle(.plain)
    .keyboardShortcut(KeyEquivalent(Character(opt.id.lowercased())), modifiers: [])
  }

  private func tag(_ text: String, _ color: Color) -> some View {
    Text(text).font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
      .background(color.opacity(0.18)).foregroundStyle(color).cornerRadius(3)
  }

  private func urgencyColor(_ u: String?) -> Color {
    switch u {
    case "now": return .red
    case "soon": return .orange
    case "today": return .blue
    default: return .gray
    }
  }
}

// MARK: - Floating window (push surface)

@MainActor
final class FloatingWindowController {
  private var window: NSWindow?
  private let poller: Poller

  init(poller: Poller) {
    self.poller = poller
  }

  func show() {
    print("[attn-tray] FloatingWindowController.show() called")
    if window == nil { build() }
    guard let w = window else { print("[attn-tray] WARN: window is nil after build"); return }
    centerOnActiveScreen(w)
    NSApp.activate(ignoringOtherApps: true)
    w.makeKeyAndOrderFront(nil)
    print("[attn-tray] window ordered front, frame=\(w.frame), level=\(w.level.rawValue)")
  }

  func hide() {
    window?.orderOut(nil)
  }

  private func build() {
    let view = CardContent(poller: poller, onDismiss: { [weak self] in self?.hide() })
    let host = NSHostingController(rootView: view)
    let w = NSWindow(contentViewController: host)
    w.styleMask = [.titled, .closable]
    w.title = "attention-router"
    w.titlebarAppearsTransparent = true
    w.isMovableByWindowBackground = true
    w.level = .floating // above regular windows
    w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    w.isReleasedWhenClosed = false
    w.standardWindowButton(.miniaturizeButton)?.isHidden = true
    w.standardWindowButton(.zoomButton)?.isHidden = true
    self.window = w
  }

  private func centerOnActiveScreen(_ w: NSWindow) {
    guard let screen = NSScreen.main else { w.center(); return }
    let frame = screen.visibleFrame
    let size = w.frame.size
    let origin = NSPoint(
      x: frame.midX - size.width / 2,
      y: frame.midY - size.height / 2
    )
    w.setFrameOrigin(origin)
  }
}

// MARK: - Status item icon (the dot in the menubar)

@MainActor
final class MenubarController {
  let statusItem: NSStatusItem
  let popover: NSPopover
  let poller: Poller
  let floating: FloatingWindowController
  private var batchSubscription: AnyCancellable?

  init(poller: Poller, floating: FloatingWindowController) {
    self.poller = poller
    self.floating = floating
    self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    self.popover = NSPopover()
    self.popover.contentSize = NSSize(width: 480, height: 520)
    self.popover.behavior = .transient
    self.popover.contentViewController = NSHostingController(
      rootView: CardContent(poller: poller, onDismiss: { [weak self] in self?.popover.performClose(nil) })
    )

    if let button = statusItem.button {
      // bell.badge.fill is visually distinctive (bell with red dot) and clearly
      // signals "you have an alert" — unlike tray.fill which looks like Stocks.
      button.image = NSImage(systemSymbolName: "bell.badge.fill", accessibilityDescription: "attention-router")
      button.imagePosition = .imageLeft
      button.target = self
      button.action = #selector(togglePopover(_:))
    }

    poller.onNewCard = { [weak self] in
      Task { @MainActor in self?.floating.show() }
    }

    batchSubscription = poller.$batch.sink { [weak self] _ in
      Task { @MainActor in self?.refreshBadge() }
    }
  }

  @objc func togglePopover(_ sender: AnyObject?) {
    if popover.isShown {
      popover.performClose(sender)
    } else if let button = statusItem.button {
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
      popover.contentViewController?.view.window?.makeKey()
    }
  }

  func refreshBadge() {
    let n = poller.batch.count
    if let button = statusItem.button {
      if poller.lastError != nil {
        button.title = " ⚠"
      } else if n > 0 {
        button.title = " \(n)"
      } else {
        button.title = ""
      }
    }
  }
}

// MARK: - App entry (NSApplication.run, no SwiftUI App)

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  var poller: Poller!
  var menubar: MenubarController!
  var floating: FloatingWindowController!

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory) // no Dock icon
    print("[attn-tray] launched, pid=\(ProcessInfo.processInfo.processIdentifier)")
    poller = Poller()
    floating = FloatingWindowController(poller: poller)
    menubar = MenubarController(poller: poller, floating: floating)
    if let btn = menubar.statusItem.button {
      print("[attn-tray] status item button created; image=\(String(describing: btn.image))")
    } else {
      print("[attn-tray] WARN: statusItem.button is nil — icon will not appear")
    }
  }
}

@main
struct AttnTrayMain {
  @MainActor static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
  }
}
