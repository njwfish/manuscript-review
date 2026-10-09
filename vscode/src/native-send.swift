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

func descendants(_ root: AXUIElement, excluding excluded: AXUIElement? = nil) -> [AXUIElement] {
    var result = [AXUIElement](), queue = [root], seen = Set<CFHashCode>()
    while let element = queue.popLast(), result.count < 6000 {
        if cancelled() { return [] }
        if let excluded, CFEqual(element, excluded) { continue }
        guard seen.insert(CFHash(element)).inserted else { continue }
        result.append(element)
        queue += (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).reversed()
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
      let identifier = request["pid"], let pid = Int32(identifier), pid > 0,
      let discussion = request["discussion"], !discussion.isEmpty,
      let prompt = request["prompt"], prompt.contains(discussion) else { fail("Invalid native agent request.") }
guard let app = NSRunningApplication(processIdentifier: pid),
      ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"].contains(app.bundleIdentifier ?? "") else {
    fail("The native request did not originate in a VS Code desktop window.")
}
let application = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetMessagingTimeout(application, 1)
guard let value = attribute(application, kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else {
    fail("The manuscript’s VS Code window is unavailable.")
}
let window = unsafeBitCast(value, to: AXUIElement.self)
func frameID(_ element: AXUIElement) -> String {
    URLComponents(string: text(element, kAXURLAttribute))?.queryItems?.first { $0.name == "id" }?.value ?? ""
}
func frames() -> [AXUIElement] {
    var byID = [String: AXUIElement]()
    for element in descendants(window) {
        let url = text(element, kAXURLAttribute).lowercased()
        if text(element, kAXRoleAttribute) == "AXWebArea" && url.hasPrefix("vscode-webview://")
            && url.contains("extensionid=" + provider) {
            let id = frameID(element)
            if !id.isEmpty { byID[id] = element }
        }
    }
    return Array(byID.values)
}
let existing = Set(frames().map(frameID))
emit("ready")
guard readLine() == "submit" else { fail("The native agent request was cancelled.") }

let deadline = Date().addingTimeInterval(12)
var frame: AXUIElement?, composer: AXUIElement?
while Date() < deadline {
    if cancelled() { fail("The native agent request was cancelled.") }
    guard let current = attribute(application, kAXFocusedWindowAttribute), CFEqual(current, window) else { fail("The active VS Code window changed. The request was not sent.") }
    let fresh = frames().filter { !existing.contains(frameID($0)) }
    guard fresh.count <= 1 else { fail("More than one new agent tab opened. The request was not sent.") }
    if let candidate = fresh.first {
        let inputs = descendants(candidate).filter { text($0, kAXRoleAttribute) == kAXTextAreaRole }
        if inputs.count == 1 { frame = candidate; composer = inputs[0]; break }
    }
    Thread.sleep(forTimeInterval: 0.1)
}
guard let frame, let composer else { fail("The new agent composer is unavailable. Complete the agent’s setup, close its empty tab, and send this saved comment again.") }
guard let initial = attribute(composer, kAXValueAttribute) as? String else { fail("The new agent composer is not readable. Nothing was sent.") }
// Some native composers expose their placeholder as AXValue. A paste still has
// to produce the complete request before any Send is permitted.
let placeholder = text(composer, kAXDescriptionAttribute)
func validDraft(_ value: String) -> Bool {
    value.isEmpty || sameText(value, prompt) || (!placeholder.isEmpty && sameText(value, placeholder))
}
guard validDraft(initial) else { fail("The agent composer already contains other text. The request was not sent.") }
func composerFocused() -> Bool {
    attribute(application, kAXFocusedUIElementAttribute).map { CFEqual($0, composer) } ?? false
}
if !composerFocused() {
    // Codex focuses after mounting and does not expose a writable focus attribute.
    _ = AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let focusDeadline = Date().addingTimeInterval(2)
    while Date() < focusDeadline && !composerFocused() && !cancelled() {
        Thread.sleep(forTimeInterval: 0.05)
    }
}
guard composerFocused() else { fail("The agent composer could not be focused. The request was not sent.") }

guard let draft = attribute(composer, kAXValueAttribute) as? String, validDraft(draft) else {
    fail("The agent composer changed. The request was not sent.")
}
if !sameText(draft, prompt) {
    // A real paste updates React/Lexical state as well as the accessible value.
    guard let focused = attribute(application, kAXFocusedUIElementAttribute), CFEqual(focused, composer) else {
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
      let focusedWindow = attribute(application, kAXFocusedWindowAttribute), CFEqual(focusedWindow, window),
      let focusedInput = attribute(application, kAXFocusedUIElementAttribute), CFEqual(focusedInput, composer),
      (attribute(buttons[0], kAXEnabledAttribute) as? Bool) == true else {
    fail("The agent composer changed or the handoff was cancelled. The request was not sent.")
}
// Never retry this action: an AX timeout can still mean the click happened.
let pressed = AXUIElementPerformAction(buttons[0], kAXPressAction as CFString)
let submittedFrame = frameID(frame)
let sentDeadline = Date().addingTimeInterval(4)
while Date() < sentDeadline {
    if cancelled() { break }
    // The first message can remount the composer; its accessible value may also
    // contain a keyboard hint. Confirm the submitted text in the conversation.
    guard let currentFrame = frames().first(where: { frameID($0) == submittedFrame }) else { break }
    let elements = descendants(currentFrame)
    let inputs = elements.filter { text($0, kAXRoleAttribute) == kAXTextAreaRole }
    if inputs.count == 1, let value = attribute(inputs[0], kAXValueAttribute) as? String, !sameText(value, prompt) {
        let shown = descendants(currentFrame, excluding: inputs[0]).filter { text($0, kAXRoleAttribute) == kAXStaticTextRole }.map { element in
            let value = text(element, kAXValueAttribute)
            return value.isEmpty ? text(element, kAXTitleAttribute) : value
        }.joined()
        if shown.contains(discussion) { emit("sent"); exit(0) }
    }
    Thread.sleep(forTimeInterval: 0.1)
}
emit("uncertain", pressed == .success ? "The agent received Send, but submission could not be confirmed. Check its tab before sending again." : "Submission could not be confirmed. Check the agent tab before sending again.")
exit(1)
