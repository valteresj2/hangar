// Agent Hangar Desktop — the macOS helper of the computer workstation (src/main/features/computer).
// Same JSON-lines protocol as the Windows helper: {"id":1,"cmd":"capture","hwnd":123} -> {"id":1,"ok":true,...}.
// It only does what the main process asks after its checks. Compiled on first use with `swiftc` (Xcode Command Line
// Tools) or shipped prebuilt. Needs macOS 14+ (ScreenCaptureKit screenshots) and two permissions for Agent Hangar
// Desktop: Accessibility (input, elements) and Screen Recording (capture, window titles).
//
// Coordinates are global display points (top-left origin), as CGWindowList and CGEvent use them.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

// ------------------------------------------------------------------ JSON
typealias Obj = [String: Any]

func reply(_ o: Obj) {
    if let d = try? JSONSerialization.data(withJSONObject: o, options: []), let s = String(data: d, encoding: .utf8) {
        FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    }
}

func num(_ v: Any?, _ d: Double = 0) -> Double {
    if let n = v as? NSNumber { return n.doubleValue }
    if let s = v as? String, let n = Double(s) { return n }
    return d
}

func strs(_ v: Any?) -> [String] { (v as? [Any])?.compactMap { $0 as? String } ?? [] }
func ints(_ v: Any?) -> Set<Int> { Set((v as? [Any])?.map { Int(num($0)) } ?? []) }

struct HelperError: Error { let message: String }

// ------------------------------------------------------------------ clock and presence
var lastInjectEnd: Double = 0
func nowMs() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }
func injected() { lastInjectEnd = nowMs() }

// ------------------------------------------------------------------ windows
struct Win {
    let id: Int
    let pid: Int32
    let owner: String
    let title: String
    let rect: CGRect
}

func listWindows() -> [Win] {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [Win] = []
    for w in raw {
        guard (w[kCGWindowLayer as String] as? Int ?? 1) == 0 else { continue }
        if let a = w[kCGWindowAlpha as String] as? Double, a <= 0 { continue }
        guard let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { continue }
        if r.width < 2 || r.height < 2 { continue }
        out.append(Win(id: w[kCGWindowNumber as String] as? Int ?? 0,
                       pid: Int32(w[kCGWindowOwnerPID as String] as? Int ?? 0),
                       owner: w[kCGWindowOwnerName as String] as? String ?? "",
                       title: w[kCGWindowName as String] as? String ?? "",
                       rect: r))
    }
    return out  // front to back
}

func rectObj(_ r: CGRect) -> Obj {
    ["x": Int(r.origin.x.rounded()), "y": Int(r.origin.y.rounded()), "width": Int(r.width.rounded()), "height": Int(r.height.rounded())]
}

func describe(_ w: Win, front: Int?) -> Obj {
    let app = NSRunningApplication(processIdentifier: w.pid)
    let exe = app?.executableURL?.path ?? ""
    let process = app?.executableURL?.lastPathComponent ?? w.owner
    var title = w.title
    if title.isEmpty, let t = axWindow(pid: w.pid, rect: w.rect).flatMap({ axString($0, kAXTitleAttribute) }) { title = t }
    if title.isEmpty { title = w.owner }
    return ["hwnd": w.id, "title": title, "className": app?.bundleIdentifier ?? "", "pid": Int(w.pid), "ownerPid": Int(w.pid),
            "exe": exe, "process": process, "elevated": false, "rect": rectObj(w.rect), "minimized": false,
            "foreground": front == w.id]
}

func frontId(_ all: [Win]) -> Int? { all.first?.id }

func findWin(_ id: Int, _ all: [Win]) throws -> Win {
    guard let w = all.first(where: { $0.id == id }) else { throw HelperError(message: "janela fechada ou fora da tela") }
    return w
}

// ------------------------------------------------------------------ accessibility
func axString(_ el: AXUIElement, _ attr: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
    if let s = v as? String { return s }
    return nil
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success else { return [] }
    return (v as? [AXUIElement]) ?? []
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    var p: CFTypeRef?
    var s: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &p) == .success,
          AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &s) == .success,
          let pv = p, let sv = s else { return nil }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &pt)
    AXValueGetValue(sv as! AXValue, .cgSize, &sz)
    return CGRect(origin: pt, size: sz)
}

/** The AX window of a process closest to a CGWindow's bounds. */
func axWindow(pid: Int32, rect: CGRect) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v) == .success, let wins = v as? [AXUIElement] else { return nil }
    var best: AXUIElement?
    var dist = CGFloat.greatestFiniteMagnitude
    for w in wins {
        guard let f = axFrame(w) else { continue }
        let d = abs(f.origin.x - rect.origin.x) + abs(f.origin.y - rect.origin.y) + abs(f.width - rect.width) + abs(f.height - rect.height)
        if d < dist { best = w; dist = d }
    }
    return best
}

let INTERACTIVE: [String: String] = [
    "AXButton": "button", "AXTextField": "edit", "AXSecureTextField": "edit", "AXTextArea": "edit", "AXComboBox": "combo box",
    "AXCheckBox": "check box", "AXRadioButton": "radio button", "AXPopUpButton": "combo box", "AXMenuButton": "button",
    "AXMenuItem": "menu item", "AXLink": "link", "AXCell": "data item", "AXRow": "list item", "AXSlider": "slider",
    "AXIncrementor": "spinner", "AXTab": "tab item", "AXDisclosureTriangle": "button",
]

func isPassword(_ el: AXUIElement) -> Bool {
    axString(el, kAXRoleAttribute) == "AXSecureTextField" || axString(el, kAXSubroleAttribute) == "AXSecureTextField"
}

func elements(_ w: Win, max: Int) -> [Obj] {
    guard let root = axWindow(pid: w.pid, rect: w.rect) else { return [] }
    var out: [Obj] = []
    var queue: [AXUIElement] = [root]
    var seen = 0
    let deadline = Date().addingTimeInterval(1.5)
    while !queue.isEmpty && out.count < max && seen < 4000 && Date() < deadline {
        let el = queue.removeFirst()
        seen += 1
        let role = axString(el, kAXRoleAttribute) ?? ""
        if let kind = INTERACTIVE[role], let f = axFrame(el), f.width > 1, f.height > 1 {
            let pw = isPassword(el)
            let name = axString(el, kAXTitleAttribute) ?? axString(el, kAXDescriptionAttribute)
                ?? axString(el, "AXPlaceholderValue") ?? axString(el, kAXHelpAttribute) ?? ""
            var value = pw ? "" : (axString(el, kAXValueAttribute) ?? "")
            if value.count > 80 { value = String(value.prefix(80)) + "…" }
            out.append(["name": name.trimmingCharacters(in: .whitespacesAndNewlines), "type": kind, "password": pw,
                        "x": Int(f.origin.x), "y": Int(f.origin.y), "width": Int(f.width), "height": Int(f.height), "value": value])
        }
        queue.append(contentsOf: axChildren(el).prefix(500))
    }
    return out
}

func focused() -> Obj? {
    let sys = AXUIElementCreateSystemWide()
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &v) == .success, let raw = v else { return nil }
    let el = raw as! AXUIElement
    var pid: pid_t = 0
    AXUIElementGetPid(el, &pid)
    return ["name": axString(el, kAXTitleAttribute) ?? axString(el, kAXDescriptionAttribute) ?? "",
            "type": axString(el, kAXRoleAttribute) ?? "", "password": isPassword(el), "pid": Int(pid)]
}

// ------------------------------------------------------------------ focus
func focus(_ w: Win) {
    if let app = NSRunningApplication(processIdentifier: w.pid) {
        app.activate(options: [.activateIgnoringOtherApps])
    }
    if let ax = axWindow(pid: w.pid, rect: w.rect) {
        AXUIElementSetAttributeValue(ax, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(ax, kAXRaiseAction as CFString)
    }
    for _ in 0..<20 {
        if listWindows().first?.id == w.id { return }
        Thread.sleep(forTimeInterval: 0.05)
    }
}

// ------------------------------------------------------------------ capture (ScreenCaptureKit, only the allowed apps)
func capture(_ w: Win, maxWidth: Int, allowedPids: Set<Int>) throws -> Obj {
    let sem = DispatchSemaphore(value: 0)
    var image: CGImage?
    var failure: String?
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let center = CGPoint(x: w.rect.midX, y: w.rect.midY)
            guard let display = content.displays.first(where: { $0.frame.contains(center) }) ?? content.displays.first else {
                throw HelperError(message: "sem tela para capturar")
            }
            var pids = allowedPids
            pids.insert(Int(w.pid))
            let apps = content.applications.filter { pids.contains(Int($0.processID)) }
            // only the allowed apps are drawn: other apps (and this app's indicator) are simply not in the picture
            let filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
            let cfg = SCStreamConfiguration()
            let local = CGRect(x: w.rect.origin.x - display.frame.origin.x, y: w.rect.origin.y - display.frame.origin.y,
                               width: w.rect.width, height: w.rect.height)
            cfg.sourceRect = local
            let backing = CGFloat(filter.pointPixelScale)
            var pw = w.rect.width * backing
            var ph = w.rect.height * backing
            if pw > CGFloat(maxWidth) { ph = ph * CGFloat(maxWidth) / pw; pw = CGFloat(maxWidth) }
            cfg.width = Int(pw.rounded())
            cfg.height = Int(ph.rounded())
            cfg.showsCursor = false
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        } catch let e as HelperError {
            failure = e.message
        } catch {
            failure = "\(error.localizedDescription) (permita Gravação de Tela para o Agent Hangar Desktop em Ajustes)"
        }
        sem.signal()
    }
    sem.wait()
    guard let img = image else { throw HelperError(message: failure ?? "captura falhou") }
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { throw HelperError(message: "png") }
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
    let all = listWindows()
    return ["png": (data as Data).base64EncodedString(), "width": img.width, "height": img.height,
            "scale": Double(img.width) / Double(w.rect.width), "rect": rectObj(w.rect), "masked": [Obj](),
            "window": describe(w, front: frontId(all))]
}

// ------------------------------------------------------------------ input
func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

func click(x: Double, y: Double, button: String, double: Bool) {
    let p = CGPoint(x: x, y: y)
    let right = button == "right"
    let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
    let btn: CGMouseButton = right ? .right : .left
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: btn))
    Thread.sleep(forTimeInterval: 0.03)
    for n in 1...(double ? 2 : 1) {
        let d = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: btn)
        let u = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: btn)
        d?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        u?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        post(d)
        post(u)
    }
    injected()
}

func keyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags = []) {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    e?.flags = flags
    post(e)
}

func typeText(_ text: String) {
    for ch in text {
        if ch == "\n" || ch == "\r\n" { keyEvent(36, down: true); keyEvent(36, down: false) }
        else if ch == "\r" { continue }
        else if ch == "\t" { keyEvent(48, down: true); keyEvent(48, down: false) }
        else {
            let units = Array(String(ch).utf16)
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                post(e)
            }
        }
        Thread.sleep(forTimeInterval: 0.004)
    }
    injected()
}

let KEYCODES: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
    "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "kp_enter": 76, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "esc": 53,
    "delete": 117, "del": 117, "home": 115, "end": 119, "pageup": 116, "page_up": 116, "prior": 116, "pagedown": 121,
    "page_down": 121, "next": 121, "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
    "f11": 103, "f12": 111,
]

func keyCombo(_ key: String, _ mods: [String]) throws {
    guard let code = KEYCODES[key.lowercased()] else { throw HelperError(message: "tecla desconhecida: \(key)") }
    var flags: CGEventFlags = []
    for m in mods {
        switch m.lowercased() {
        case "cmd", "command", "win", "super", "meta": flags.insert(.maskCommand)
        case "ctrl", "control": flags.insert(.maskControl)
        case "alt", "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: throw HelperError(message: "modificador desconhecido: \(m)")
        }
    }
    keyEvent(code, down: true, flags: flags)
    keyEvent(code, down: false, flags: flags)
    injected()
}

func scroll(x: Double, y: Double, direction: String, amount: Int) {
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left))
    let n = Int32(max(1, min(amount, 20)))
    let dy: Int32 = direction == "up" ? n : direction == "down" ? -n : 0
    let dx: Int32 = direction == "left" ? n : direction == "right" ? -n : 0
    post(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
    injected()
}

func release() {
    for code: CGKeyCode in [55, 54, 56, 60, 58, 61, 59, 62] { keyEvent(code, down: false) }
    let p = CGEvent(source: nil)?.location ?? .zero
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: p, mouseButton: .right))
    injected()
}

func idle() -> Obj {
    // hidSystemState: the person's hardware input (our posted events are compared through lastInjectEnd anyway)
    let any = CGEventType(rawValue: ~0)!
    let secs = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: any)
    let now = nowMs()
    let p = CGEvent(source: nil)?.location ?? .zero
    var locked = false
    if let d = CGSessionCopyCurrentDictionary() as? [String: Any] { locked = (d["CGSSessionScreenIsLocked"] as? Bool) ?? false }
    return ["now": now, "lastInput": now - secs * 1000, "lastInjectEnd": lastInjectEnd,
            "cursor": ["x": Int(p.x), "y": Int(p.y)], "locked": locked]
}

// ------------------------------------------------------------------ dispatch
func handle(_ r: Obj) throws -> Obj {
    let cmd = r["cmd"] as? String ?? ""
    switch cmd {
    case "hello":
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let ax = AXIsProcessTrustedWithOptions(opts)
        var screen = CGPreflightScreenCaptureAccess()
        if !screen { screen = CGRequestScreenCaptureAccess() }
        return ["pid": Int(ProcessInfo.processInfo.processIdentifier), "version": 1, "accessibility": ax, "screen": screen]
    case "exit": return [:]
    case "windows":
        let all = listWindows()
        return ["windows": all.map { describe($0, front: frontId(all)) }]
    case "foreground":
        let all = listWindows()
        return ["window": all.first.map { describe($0, front: $0.id) } ?? NSNull()]
    case "window":
        let all = listWindows()
        if let w = all.first(where: { $0.id == Int(num(r["hwnd"])) }) { return ["window": describe(w, front: frontId(all))] }
        return ["window": NSNull()]
    case "focus":
        let w = try findWin(Int(num(r["hwnd"])), listWindows())
        focus(w)
        let all = listWindows()
        return ["window": describe(all.first(where: { $0.id == w.id }) ?? w, front: frontId(all))]
    case "capture":
        let w = try findWin(Int(num(r["hwnd"])), listWindows())
        return try capture(w, maxWidth: Int(num(r["maxWidth"], 1366)), allowedPids: ints(r["allowedPids"]))
    case "elements":
        let w = try findWin(Int(num(r["hwnd"])), listWindows())
        return ["elements": elements(w, max: Int(num(r["max"], 150)))]
    case "focused":
        return ["focused": focused() ?? NSNull()]
    case "hit":
        let p = CGPoint(x: num(r["x"]), y: num(r["y"]))
        let ignore = ints(r["ignoreHwnds"])
        let all = listWindows()
        let w = all.first(where: { !ignore.contains($0.id) && $0.rect.contains(p) })
        return ["window": w.map { describe($0, front: frontId(all)) } ?? NSNull()]
    case "click":
        click(x: num(r["x"]), y: num(r["y"]), button: r["button"] as? String ?? "left", double: (r["double"] as? Bool) ?? false)
        return [:]
    case "type":
        typeText(r["text"] as? String ?? "")
        return [:]
    case "key":
        try keyCombo(r["key"] as? String ?? "", strs(r["modifiers"]))
        return [:]
    case "scroll":
        scroll(x: num(r["x"]), y: num(r["y"]), direction: r["direction"] as? String ?? "down", amount: Int(num(r["amount"], 3)))
        return [:]
    case "release":
        release()
        return [:]
    case "idle":
        return idle()
    default:
        throw HelperError(message: "comando desconhecido: \(cmd)")
    }
}

setvbuf(stdout, nil, _IONBF, 0)
while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    var id: Any = NSNull()
    var out: Obj
    var cmd = ""
    do {
        guard let data = line.data(using: .utf8), let req = try JSONSerialization.jsonObject(with: data) as? Obj else {
            throw HelperError(message: "pedido inválido")
        }
        id = req["id"] ?? NSNull()
        cmd = req["cmd"] as? String ?? ""
        out = try handle(req)
        out["ok"] = true
    } catch let e as HelperError {
        out = ["ok": false, "error": e.message]
    } catch {
        out = ["ok": false, "error": error.localizedDescription]
    }
    out["id"] = id
    reply(out)
    if cmd == "exit" { break }
}
