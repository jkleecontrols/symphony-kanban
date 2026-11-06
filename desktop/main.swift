// Symphony.app — a native window around the Symphony Local board.
//
// On launch it looks for a board already answering on 127.0.0.1:<port>. If there is
// none it starts `node src/cli.js start` from the repository the app was built from,
// waits for it, and shows the board in a WebKit window. Closing the window keeps the
// server running (so desktop notifications keep arriving); clicking the Dock icon
// brings it back. Quitting stops the server only if this app started it.

import AppKit
import WebKit

let info = Bundle.main.infoDictionary ?? [:]
let repo = (info["SymphonyRepo"] as? String) ?? FileManager.default.currentDirectoryPath
let port = (info["SymphonyPort"] as? String) ?? "8787"
let boardURL = URL(string: "http://127.0.0.1:\(port)/")!
let probeURL = URL(string: "http://127.0.0.1:\(port)/api/config")!
let logURL = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Logs/Symphony.log")

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var server: Process?
  var waitStarted = Date()

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()

    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsMagnification = true

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable],
                      backing: .buffered, defer: false)
    window.title = "Symphony"
    window.minSize = NSSize(width: 720, height: 480)
    window.contentView = web
    window.isReleasedWhenClosed = false
    window.setFrameAutosaveName("SymphonyMain")
    if !window.setFrameUsingName("SymphonyMain") { window.center() }
    window.makeKeyAndOrderFront(nil)

    retry()
    NSApp.activate(ignoringOtherApps: true)
  }

  // MARK: server

  func probe(_ done: @escaping (Bool) -> Void) {
    var req = URLRequest(url: probeURL, timeoutInterval: 1.5)
    req.cachePolicy = .reloadIgnoringLocalCacheData
    URLSession.shared.dataTask(with: req) { _, resp, _ in
      let ok = (resp as? HTTPURLResponse)?.statusCode == 200
      DispatchQueue.main.async { done(ok) }
    }.resume()
  }

  func startServer() {
    if !FileManager.default.fileExists(atPath: logURL.path) {
      FileManager.default.createFile(atPath: logURL.path, contents: nil)
    }
    let log = try? FileHandle(forWritingTo: logURL)
    log?.seekToEndOfFile()

    // A login shell so the server — and the claude/codex sessions it launches — get
    // the same PATH as a terminal, not the bare one Finder hands to apps.
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "exec node src/cli.js start --port \(port)"]
    p.currentDirectoryURL = URL(fileURLWithPath: repo)
    var env = ProcessInfo.processInfo.environment
    let extra = ["/opt/homebrew/bin", "/usr/local/bin", "\(NSHomeDirectory())/.local/bin"]
    env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
    p.environment = env
    p.standardOutput = log
    p.standardError = log
    p.terminationHandler = { proc in
      DispatchQueue.main.async {
        guard self.server === proc else { return }
        self.server = nil
        self.web.loadHTMLString(Pages.failed(status: proc.terminationStatus), baseURL: nil)
      }
    }
    do {
      try p.run()
      server = p
    } catch {
      web.loadHTMLString(Pages.failed(status: -1), baseURL: nil)
      return
    }
    waitStarted = Date()
    waitForServer()
  }

  func waitForServer() {
    probe { up in
      if up {
        self.web.load(URLRequest(url: boardURL))
      } else if self.server != nil && Date().timeIntervalSince(self.waitStarted) < 30 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.waitForServer() }
      } else if self.server != nil {
        self.stopServer()
        self.web.loadHTMLString(Pages.failed(status: -2), baseURL: nil)
      }
    }
  }

  func stopServer() {
    guard let p = server, p.isRunning else { return }
    server = nil
    p.terminate() // SIGTERM: cli.js stops the orchestrator and closes the port
    let deadline = Date().addingTimeInterval(4)
    while p.isRunning && Date() < deadline { usleep(50_000) }
    if p.isRunning { kill(p.processIdentifier, SIGKILL) }
  }

  @objc func retry() {
    web.loadHTMLString(Pages.loading, baseURL: nil)
    probe { up in
      if up { self.web.load(URLRequest(url: boardURL)) } else { self.startServer() }
    }
  }

  @objc func openLog() { NSWorkspace.shared.open(logURL) }
  @objc func openInBrowser() { NSWorkspace.shared.open(boardURL) }
  @objc func reload() {
    if web.url?.host == "127.0.0.1" { web.reload() } else { retry() }
  }

  // MARK: app lifecycle

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  func applicationWillTerminate(_ note: Notification) { stopServer() }

  // MARK: web view

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.allow) }
    // Buttons on the app's own loading / error pages.
    if url.scheme == "symphony" {
      if url.host == "retry" { retry() }
      if url.host == "log" { openLog() }
      return decisionHandler(.cancel)
    }
    // Links that leave the board open in the default browser.
    if action.navigationType == .linkActivated && (url.host != "127.0.0.1" || action.targetFrame == nil) {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.runModal()
    completionHandler()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }

  // The board stopped answering (e.g. the server was stopped from a terminal).
  func webView(_ webView: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
    if server == nil { web.loadHTMLString(Pages.failed(status: -3), baseURL: nil) }
  }

  // MARK: menu

  func buildMenu() {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let app = NSMenu()
    app.addItem(withTitle: "About Symphony", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    app.addItem(.separator())
    app.addItem(withTitle: "Hide Symphony", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    others.keyEquivalentModifierMask = [.command, .option]
    app.addItem(.separator())
    app.addItem(withTitle: "Quit Symphony", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = app
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)

    let viewItem = NSMenuItem()
    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
    view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "b")
    view.addItem(withTitle: "Show Server Log", action: #selector(openLog), keyEquivalent: "l")
    view.addItem(.separator())
    let full = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
    full.keyEquivalentModifierMask = [.command, .control]
    viewItem.submenu = view
    main.addItem(viewItem)

    let windowItem = NSMenuItem()
    let win = NSMenu(title: "Window")
    win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowItem.submenu = win
    main.addItem(windowItem)
    NSApp.windowsMenu = win

    NSApp.mainMenu = main
  }
}

enum Pages {
  static let style = """
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; height: 100vh; display: grid; place-items: center;
           font: 15px -apple-system, system-ui, sans-serif; color: #4a3a55;
           background: linear-gradient(135deg, #ffe4ef, #efe2ff 55%, #dcebff); }
    @media (prefers-color-scheme: dark) {
      body { color: #eadff2; background: linear-gradient(135deg, #3a2638, #2c2442 55%, #1f2a40); }
    }
    .box { text-align: center; padding: 0 16px; }
    .mochi { font-size: 64px; display: inline-block; animation: bob 1.4s ease-in-out infinite; }
    @keyframes bob { 50% { transform: translateY(-10px); } }
    h1 { font-size: 20px; margin: 12px 0 4px; }
    p { margin: 4px 0; opacity: .75; }
    a { display: inline-block; margin: 14px 6px 0; padding: 8px 16px; border-radius: 999px;
        background: #b98ae6; color: white; text-decoration: none; font-weight: 600; }
    a.ghost { background: transparent; color: inherit; border: 1px solid currentColor; }
    code { font-size: 13px; }
  </style>
  """

  static let loading = """
  <!doctype html><html><head><meta charset="utf-8">\(style)</head><body><div class="box">
    <div class="mochi">🍡</div><h1>Symphony is waking up…</h1><p>Starting the board</p>
  </div></body></html>
  """

  static func failed(status: Int32) -> String {
    let why: String
    switch status {
    case -1: why = "Couldn't launch <code>zsh</code>."
    case -2: why = "The server didn't answer within 30 seconds."
    case -3: why = "The board stopped answering."
    default: why = "The server exited (status \(status))."
    }
    return """
    <!doctype html><html><head><meta charset="utf-8">\(style)</head><body><div class="box">
      <div class="mochi">🥺</div><h1>The board isn't running</h1><p>\(why)</p>
      <p><code>\(repo)</code></p>
      <a href="symphony://retry">Try again</a><a class="ghost" href="symphony://log">Show log</a>
    </div></body></html>
    """
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
