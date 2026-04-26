// AttnTray — minimal SwiftUI floating UI for attention-router.
// Polls the daemon every N seconds; when a new pending card escalates,
// shows a modal-style floating window with big A/B/C/Override/Skip buttons.
// Click → POST /decisions or /skip → window dismisses → back to polling.

import AppKit
import Combine
import Foundation
import SwiftUI

// MARK: - Daemon types (mirror server JSON shape, kept minimal)

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

struct Record: Decodable {
  let ask: Ask
  let status: String
  let urgency: String?
  let council: CouncilSummary?
  let bid: BidSummary?
  let decision: AnyCodable?
}

struct NextResponse: Decodable {
  let batch: [Record]
}

// throwaway box for ignored fields
struct AnyCodable: Decodable {
  init(from decoder: Decoder) throws {}
}

// MARK: - Networking

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

  func nextBatch() async throws -> NextResponse {
    let r = req("GET", "/next?max=3")
    let (data, resp) = try await URLSession.shared.data(for: r)
    guard let h = resp as? HTTPURLResponse, h.statusCode == 200 else {
      throw DaemonError.http((resp as? HTTPURLResponse)?.statusCode ?? -1,
                             String(data: data, encoding: .utf8) ?? "")
    }
    return try JSONDecoder().decode(NextResponse.self, from: data)
  }

  func decide(askId: String, choice: String, override: String? = nil) async throws {
    var body: [String: Any] = ["ask_id": askId, "choice": choice, "create_rule": true]
    if let o = override { body["override_text"] = o }
    let data = try JSONSerialization.data(withJSONObject: body)
    let r = req("POST", "/decisions", body: data)
    let (resp_data, resp) = try await URLSession.shared.data(for: r)
    guard let h = resp as? HTTPURLResponse, (200..<300).contains(h.statusCode) else {
      throw DaemonError.http((resp as? HTTPURLResponse)?.statusCode ?? -1,
                             String(data: resp_data, encoding: .utf8) ?? "")
    }
  }

  func skip(askId: String) async throws {
    let data = try JSONSerialization.data(withJSONObject: ["id": askId])
    let r = req("POST", "/skip", body: data)
    _ = try await URLSession.shared.data(for: r)
  }
}

// MARK: - Polling state

@MainActor
final class Poller: ObservableObject {
  @Published var current: Record? = nil
  @Published var statusText: String = "polling…"
  private var seen = Set<String>()
  private let daemon = Daemon()
  private let intervalSec: TimeInterval

  init() {
    let raw = ProcessInfo.processInfo.environment["AR_TRAY_INTERVAL_SEC"] ?? "5"
    self.intervalSec = Double(raw) ?? 5
    Task { await self.loop() }
  }

  func loop() async {
    // Seed with whatever's pending right now so we don't pop the window for
    // cards the human already saw before launching the tray.
    if let r = try? await daemon.nextBatch() {
      for rec in r.batch { seen.insert(rec.ask.id) }
    }
    while true {
      do {
        let resp = try await daemon.nextBatch()
        for rec in resp.batch where !seen.contains(rec.ask.id) {
          seen.insert(rec.ask.id)
          if current == nil {
            current = rec
            NSApp.activate(ignoringOtherApps: true)
          }
          break
        }
        statusText = "polling… (\(resp.batch.count) pending)"
      } catch {
        statusText = "daemon unreachable"
      }
      try? await Task.sleep(nanoseconds: UInt64(intervalSec * 1_000_000_000))
    }
  }

  func decide(_ choice: String) {
    guard let rec = current else { return }
    let askId = rec.ask.id
    Task {
      try? await daemon.decide(askId: askId, choice: choice)
      await MainActor.run { self.current = nil }
    }
  }

  func override(_ text: String) {
    guard let rec = current, !text.isEmpty else { return }
    let askId = rec.ask.id
    Task {
      try? await daemon.decide(askId: askId, choice: "override", override: text)
      await MainActor.run { self.current = nil }
    }
  }

  func skip() {
    guard let rec = current else { return }
    let askId = rec.ask.id
    Task {
      try? await daemon.skip(askId: askId)
      await MainActor.run { self.current = nil }
    }
  }
}

// MARK: - UI

struct CardView: View {
  @ObservedObject var poller: Poller
  @State private var overrideText: String = ""
  @State private var showOverride: Bool = false

  var body: some View {
    if let rec = poller.current {
      askView(rec)
    } else {
      idleView
    }
  }

  private var idleView: some View {
    VStack(spacing: 12) {
      Text("attention-router").font(.title3.bold())
      Text(poller.statusText).font(.callout).foregroundStyle(.secondary)
      Text("Waiting for new pending cards…").font(.callout).foregroundStyle(.secondary)
    }
    .padding(40)
    .frame(minWidth: 360, minHeight: 160)
  }

  private func askView(_ rec: Record) -> some View {
    let council = rec.council?.predicted_human_choice
    return VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text(rec.ask.project_name).font(.caption).foregroundStyle(.secondary)
        Spacer()
        Text("[\(rec.ask.id)]").font(.system(.caption2, design: .monospaced)).foregroundStyle(.tertiary)
      }
      Text(rec.ask.title).font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
      ScrollView {
        Text(rec.ask.context).font(.callout).foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }.frame(maxHeight: 100)

      Divider()

      ForEach(rec.ask.options) { opt in
        optionButton(opt: opt,
                     isDefault: opt.id == rec.ask.default_option_id,
                     isCouncilPick: opt.id == council)
      }

      Divider()

      HStack {
        Button("Skip (snooze)") { poller.skip() }
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
            poller.override(overrideText)
            overrideText = ""
            showOverride = false
          }
          .buttonStyle(.borderedProminent)
          .disabled(overrideText.trimmingCharacters(in: .whitespaces).isEmpty)
          .keyboardShortcut(.return, modifiers: [.command])
        }
      }

      if let bid = rec.bid?.reason {
        Text("Why this reached you: \(bid)")
          .font(.caption).foregroundStyle(.tertiary).italic()
      }
    }
    .padding(20)
    .frame(width: 560)
  }

  private func optionButton(opt: AskOption, isDefault: Bool, isCouncilPick: Bool) -> some View {
    Button(action: { poller.decide(opt.id) }) {
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(opt.id).font(.title.bold()).frame(width: 28)
          Text(opt.label).font(.headline).fixedSize(horizontal: false, vertical: true)
          Spacer()
          if isDefault { tag("default", .blue) }
          if isCouncilPick { tag("council", .purple) }
        }
        Text("→ \(opt.predicted_next_step)").font(.caption).foregroundStyle(.secondary)
        Text("⚠ \(opt.cost_if_wrong)").font(.caption).foregroundStyle(.secondary)
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 8).fill(Color(NSColor.controlBackgroundColor)))
    }
    .buttonStyle(.plain)
    .keyboardShortcut(KeyEquivalent(Character(opt.id.lowercased())), modifiers: [])
  }

  private func tag(_ text: String, _ color: Color) -> some View {
    Text(text).font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
      .background(color.opacity(0.18)).foregroundStyle(color).cornerRadius(4)
  }
}

// MARK: - App entry

@main
struct AttnTrayApp: App {
  @StateObject private var poller = Poller()

  init() {
    NSApplication.shared.setActivationPolicy(.accessory) // no Dock icon
  }

  var body: some Scene {
    WindowGroup("attention-router") {
      CardView(poller: poller)
        .background(WindowAccessor { window in
          window.level = .floating
          window.isMovableByWindowBackground = true
          window.titlebarAppearsTransparent = true
          window.titleVisibility = .hidden
          window.standardWindowButton(.miniaturizeButton)?.isHidden = true
          window.standardWindowButton(.zoomButton)?.isHidden = true
        })
    }
    .windowStyle(.hiddenTitleBar)
    .windowResizability(.contentSize)
  }
}

// SwiftUI escape hatch to grab the underlying NSWindow for chrome tweaks.
struct WindowAccessor: NSViewRepresentable {
  let callback: (NSWindow) -> Void
  func makeNSView(context: Context) -> NSView {
    let v = NSView()
    DispatchQueue.main.async {
      if let w = v.window { callback(w) }
    }
    return v
  }
  func updateNSView(_ nsView: NSView, context: Context) {}
}
