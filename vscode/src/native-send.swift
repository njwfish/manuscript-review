import AppKit
import ApplicationServices
import Darwin

func cancelled() -> Bool {
    var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLHUP), revents: 0)
    return poll(&descriptor, 1, 0) > 0 && descriptor.revents & Int16(POLLHUP) != 0
}

// The extension opens the tab between Ready and Submit. Keep the original window
// and exclude its existing frames so an older agent conversation cannot receive it.
func emit(_ status: String, _ message: String? = nil) {
    var value = ["status": status]
    if let message { value["message"] = message }
    let data = try! JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data + Data([10]))
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func text(_ element: AXUIElement, _ name: String) -> String {
    if let value = attribute(element, name) as? String { return value }
    if let value = attribute(element, name) as? URL { return value.absoluteString }
    return ""
}

func descendants(_ root: AXUIElement) -> [AXUIElement] {
    var result = [AXUIElement](), queue = [root], seen = Set<CFHashCode>()
    while let element = queue.popLast(), result.count < 6000 {
        if cancelled() { return [] }
        guard seen.insert(CFHash(element)).inserted else { continue }
        result.append(element)
        queue += attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }
    return result
}

func sameText(_ value: String, _ prompt: String) -> Bool {
    value.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .newlines)
        == prompt.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .newlines)
}

func fail(_ message: String) -> Never { emit("error", message); exit(1) }

func paste(_ prompt: String, into composer: AXUIElement, app: NSRunningApplication) -> Bool {
    let board = NSPasteboard.general
    let saved = (board.pasteboardItems ?? []).map { item in
        Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type, $0) } })
    }
    if cancelled() { return false }
    board.clearContents(); board.setString(prompt, forType: .string)
    let count = board.changeCount
    defer {
        if board.changeCount == count {
            board.clearContents()
            board.writeObjects(saved.map { values in
                let item = NSPasteboardItem()
                for (type, data) in values { item.setData(data, forType: type) }
                return item
            })
        }
    }
    if cancelled() { return false }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: false)
    down?.flags = .maskCommand; up?.flags = .maskCommand
    down?.postToPid(app.processIdentifier); up?.postToPid(app.processIdentifier)
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline && !cancelled() {
        if let value = attribute(composer, kAXValueAttribute) as? String, sameText(value, prompt) { return true }
        Thread.sleep(forTimeInterval: 0.05)
    }
    return false
}

guard AXIsProcessTrusted() else {
    emit("permission", "Enable Accessibility for Visual Studio Code in macOS System Settings to send comments automatically.")
    exit(1)
}
guard let line = readLine(), let bytes = line.data(using: .utf8),
      let request = try? JSONSerialization.jsonObject(with: bytes) as? [String: String],
      let provider = request["extension"], ["openai.chatgpt", "anthropic.claude-code"].contains(provider),
      let prompt = request["prompt"], !prompt.isEmpty else { fail("Invalid native agent request.") }
guard let app = NSWorkspace.shared.frontmostApplication,
      ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"].contains(app.bundleIdentifier ?? "") else {
    fail("Keep the manuscript’s VS Code window active while opening the agent.")
}
let application = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetMessagingTimeout(application, 1)
guard let value = attribute(application, kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else {
    fail("The manuscript’s VS Code window is unavailable.")
}
let window = unsafeBitCast(value, to: AXUIElement.self)
func frames() -> [AXUIElement] {
    var byURL = [String: AXUIElement]()
    for element in descendants(window) {
        let url = text(element, kAXURLAttribute).lowercased()
        if text(element, kAXRoleAttribute) == "AXWebArea" && url.hasPrefix("vscode-webview://")
            && url.contains("extensionid=" + provider) { byURL[url] = element }
    }
    return Array(byURL.values)
}
let existing = Set(frames().map { text($0, kAXURLAttribute) })
emit("ready")
guard readLine() == "submit" else { fail("The native agent request was cancelled.") }

let deadline = Date().addingTimeInterval(12)
var frame: AXUIElement?, composer: AXUIElement?
while Date() < deadline {
    if cancelled() { fail("The native agent request was cancelled.") }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
        fail("The active app changed. The agent request was not sent.")
    }
    let fresh = frames().filter { !existing.contains(text($0, kAXURLAttribute)) }
    guard fresh.count <= 1 else { fail("More than one new agent tab opened. The request was not sent.") }
    if let candidate = fresh.first {
        let inputs = descendants(candidate).filter { text($0, kAXRoleAttribute) == kAXTextAreaRole }
        if inputs.count == 1 { frame = candidate; composer = inputs[0]; break }
    }
    Thread.sleep(forTimeInterval: 0.1)
}
guard let frame, let composer else { fail("The new agent composer is unavailable. Check that the agent is signed in.") }
guard let initial = attribute(composer, kAXValueAttribute) as? String else { fail("The new agent composer is not readable. Nothing was sent.") }
guard initial.isEmpty || sameText(initial, prompt) else { fail("The agent composer already contains other text. The request was not sent.") }
guard AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
    fail("The agent composer could not be focused. The request was not sent.")
}

if initial.isEmpty {
    // A real paste updates React/Lexical state as well as the accessible value.
    guard let focused = attribute(application, kAXFocusedUIElementAttribute), CFEqual(focused, composer),
          NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
        fail("The agent composer could not be focused. The request was not sent.")
    }
    guard paste(prompt, into: composer, app: app) else { fail("The agent composer did not receive the complete request. Nothing was sent.") }
}
let buttons = descendants(frame).filter { button in
    let labels = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute].map { text(button, $0).lowercased() }
    return text(button, kAXRoleAttribute) == kAXButtonRole && labels.contains { ["send", "send message", "send prompt"].contains($0) }
        && (attribute(button, kAXEnabledAttribute) as? Bool) == true
}
guard buttons.count == 1 else { fail("The agent’s Send button is unavailable. The prepared request is in its tab.") }
guard !cancelled(), let current = attribute(composer, kAXValueAttribute) as? String, sameText(current, prompt),
      NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
      let focusedWindow = attribute(application, kAXFocusedWindowAttribute), CFEqual(focusedWindow, window),
      let focusedInput = attribute(application, kAXFocusedUIElementAttribute), CFEqual(focusedInput, composer),
      (attribute(buttons[0], kAXEnabledAttribute) as? Bool) == true else {
    fail("The agent composer changed or the handoff was cancelled. The request was not sent.")
}
// Never retry this action: an AX timeout can still mean the click happened.
let pressed = AXUIElementPerformAction(buttons[0], kAXPressAction as CFString)
let sentDeadline = Date().addingTimeInterval(4)
while Date() < sentDeadline {
    if cancelled() { break }
    if let value = attribute(composer, kAXValueAttribute) as? String, value.isEmpty { emit("sent"); exit(0) }
    Thread.sleep(forTimeInterval: 0.1)
}
emit("uncertain", pressed == .success ? "The agent received Send, but submission could not be confirmed. Check its tab before sending again." : "Submission could not be confirmed. Check the agent tab before sending again.")
exit(1)
