import Cocoa
import WebKit
import Darwin

func reviewIcon() -> NSImage {
    let image = NSImage(size: NSSize(width: 1024, height: 1024))
    image.lockFocus()
    NSColor(calibratedRed: 0.22, green: 0.34, blue: 0.28, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 60, y: 60, width: 904, height: 904), xRadius: 200, yRadius: 200).fill()
    NSColor(calibratedRed: 0.98, green: 0.98, blue: 0.96, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 242, y: 172, width: 540, height: 680), xRadius: 40, yRadius: 40).fill()
    let gray = NSColor(calibratedRed: 0.65, green: 0.70, blue: 0.66, alpha: 1)
    for (y, width) in [(720.0, 260.0), (650.0, 350.0), (580.0, 310.0), (300.0, 260.0)] {
        gray.setFill(); NSBezierPath(roundedRect: NSRect(x: 322, y: y, width: width, height: 20), xRadius: 10, yRadius: 10).fill()
    }
    NSColor(calibratedRed: 0.70, green: 0.24, blue: 0.32, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 322, y: 470, width: 265, height: 24), xRadius: 12, yRadius: 12).fill()
    NSColor(calibratedRed: 0.17, green: 0.55, blue: 0.37, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 322, y: 395, width: 345, height: 24), xRadius: 12, yRadius: 12).fill()
    image.unlockFocus()
    return image
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var backend: Process?
    var libraryURL: URL?
    var shuttingDown = false
    var outputBuffer = Data()
    var pendingLibraryButton: String?
    var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.applicationIconImage = reviewIcon()
        setupMenu()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "chooseFolder")
        configuration.userContentController.add(self, name: "copyText")
        configuration.userContentController.add(self, name: "revealFolder")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 850), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Manuscript Review"
        window.minSize = NSSize(width: 620, height: 520)
        window.contentView = webView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("ManuscriptReviewWindow")
        if CommandLine.arguments.contains("--background") {
            window.orderFront(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
        }
        startBackend()
    }

    func setupMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Manuscript Review", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(withTitle: "Setup…", action: #selector(showSetup), keyEquivalent: ",")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide Manuscript Review", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Manuscript Review", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let fileMenu = NSMenu(title: "File"); fileItem.submenu = fileMenu
        fileMenu.addItem(withTitle: "Compare Versions", action: #selector(newReview), keyEquivalent: "n")
        let libraryItem = fileMenu.addItem(withTitle: "Review Library", action: #selector(showLibrary), keyEquivalent: "l")
        libraryItem.keyEquivalentModifierMask = [.command, .shift]
        fileMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let editItem = NSMenuItem(); main.addItem(editItem)
        let editMenu = NSMenu(title: "Edit"); editItem.submenu = editMenu
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let viewMenu = NSMenu(title: "View"); viewItem.submenu = viewMenu
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        NSApp.mainMenu = main
    }

    @objc func about() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "Manuscript Review", .applicationVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "", .credits: NSAttributedString(string: "Local manuscript comparisons, word-level decisions, LaTeX previews, and review comments.")])
    }
    func openLibrary(button: String? = nil) {
        flushReview { saved in
            if saved, let url = self.libraryURL {
                self.pendingLibraryButton = button
                self.webView.load(URLRequest(url: url))
            }
        }
    }
    @objc func showLibrary() { openLibrary() }
    @objc func newReview() { openLibrary(button: "new") }
    @objc func showSetup() { openLibrary(button: "setup") }
    @objc func reload() { flushReview { saved in if saved { self.webView.reload() } } }

    func flushReview(_ completion: @escaping (Bool) -> Void) {
        guard webView != nil, webView.url != nil else { completion(true); return }
        webView.callAsyncJavaScript("if (typeof window.flushReview === 'function') await window.flushReview(); return true;", arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success: completion(true)
            case .failure(let error):
                let alert = NSAlert(); alert.messageText = "Could not save your review"; alert.informativeText = error.localizedDescription + "\nThe app will stay open so you can recover your latest work."; alert.runModal()
                self.window.makeKeyAndOrderFront(nil)
                completion(false)
            }
        }
    }

    func startBackend() {
        guard let resources = Bundle.main.resourceURL else { fail("The app resources are missing."); return }
        let process = Process()
        process.executableURL = resources.appendingPathComponent("Backend/ManuscriptReviewBackend")
        process.arguments = ["--no-browser", "--native"]
        if let configuredHome = Bundle.main.object(forInfoDictionaryKey: "ReviewLibraryHome") as? String {
            process.arguments! += ["--home", configuredHome]
        }
        if let index = CommandLine.arguments.firstIndex(of: "--library-home"), index + 1 < CommandLine.arguments.count {
            process.arguments! += ["--home", CommandLine.arguments[index + 1]]
        }
        if let index = CommandLine.arguments.firstIndex(of: "--review"), index + 1 < CommandLine.arguments.count {
            process.arguments! += ["--review", CommandLine.arguments[index + 1]]
        }
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path + ":/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:/usr/bin:/bin:" + (environment["PATH"] ?? "")
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        let logFolder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Manuscript Review")
        try? FileManager.default.createDirectory(at: logFolder, withIntermediateDirectories: true)
        let log = logFolder.appendingPathComponent("app.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        process.standardError = try? FileHandle(forWritingTo: log)
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self = self, self.libraryURL == nil else { return }
                self.outputBuffer.append(chunk)
                guard let newline = self.outputBuffer.firstIndex(of: 10) else { return }
                let line = self.outputBuffer.prefix(upTo: newline)
                if let value = try? JSONSerialization.jsonObject(with: line) as? [String: String], let address = value["url"], let url = URL(string: address) {
                    self.libraryURL = URL(string: value["library_url"] ?? "")
                    self.webView.load(URLRequest(url: url))
                }
            }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self = self, !self.shuttingDown else { return }
                self.fail("The local review service stopped (exit \(process.terminationStatus)). Details are in ~/Library/Logs/Manuscript Review/app.log. Your saved reviews are preserved.")
            }
        }
        backend = process
        do { try process.run() } catch { fail("Could not start the review service: \(error.localizedDescription)") }
    }

    func fail(_ text: String) {
        let alert = NSAlert(); alert.messageText = "Manuscript Review"; alert.informativeText = text; alert.runModal(); NSApp.terminate(nil)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if backend?.isRunning != true { return .terminateNow }
        if !quitting {
            quitting = true
            DispatchQueue.main.async {
                self.flushReview { saved in self.quitting = false; sender.reply(toApplicationShouldTerminate: saved) }
            }
        }
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) {
        shuttingDown = true
        if let process = backend, process.isRunning {
            if kill(-process.processIdentifier, SIGTERM) != 0 { process.terminate() }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.request.url?.host == "127.0.0.1" else { return }
        if message.name == "copyText", let text = message.body as? String, text.count <= 200_000 {
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string); return
        }
        if message.name == "revealFolder", let path = message.body as? String, path.count <= 4000, (path as NSString).isAbsolutePath {
            var directory = ObjCBool(false)
            if FileManager.default.fileExists(atPath: path, isDirectory: &directory), directory.boolValue {
                NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true))
            }
            return
        }
        guard message.name == "chooseFolder", let values = message.body as? [String: String], let field = values["field"], ["repo", "source", "directory"].contains(field) else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.title = field == "repo" ? "Choose a manuscript folder" : field == "directory" ? "Choose a folder for the clone" : "Choose an existing review folder"
        panel.prompt = "Choose"
        panel.beginSheetModal(for: window) { [weak self] result in
            guard result == .OK, let path = panel.url?.path, let data = try? JSONSerialization.data(withJSONObject: [field, path]), let arguments = String(data: data, encoding: .utf8) else { return }
            self?.webView.evaluateJavaScript("window.folderChosen(...\(arguments));", completionHandler: nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let button = pendingLibraryButton, webView.url == libraryURL {
            pendingLibraryButton = nil
            webView.evaluateJavaScript("document.getElementById('\(button)').click();", completionHandler: nil)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        if url.scheme == "http" && url.host == "127.0.0.1" { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--make-icon" {
    let image = reviewIcon()
    if let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let data = bitmap.representation(using: .png, properties: [:]) { try data.write(to: URL(fileURLWithPath: CommandLine.arguments[2])) }
} else {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
}
