import Foundation
import CoreGraphics
import ApplicationServices

struct Command: Decodable {
    let t: String
    let x: Double?
    let y: Double?
    let dx: Double?
    let dy: Double?
    let b: Int?
    let text: String?
}

let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
_ = AXIsProcessTrustedWithOptions(prompt)

func point(_ cmd: Command) -> CGPoint {
    CGPoint(x: cmd.x ?? 0, y: cmd.y ?? 0)
}

func mouseButton(_ cmd: Command) -> CGMouseButton {
    cmd.b == 1 ? .right : .left
}

func postMouse(_ type: CGEventType, _ cmd: Command) {
    if let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point(cmd), mouseButton: mouseButton(cmd)) {
        event.post(tap: .cghidEventTap)
    }
}

func handle(_ cmd: Command) {
    switch cmd.t {
    case "move":
        postMouse(.mouseMoved, cmd)
    case "down":
        postMouse(cmd.b == 1 ? .rightMouseDown : .leftMouseDown, cmd)
    case "drag":
        postMouse(cmd.b == 1 ? .rightMouseDragged : .leftMouseDragged, cmd)
    case "up":
        postMouse(cmd.b == 1 ? .rightMouseUp : .leftMouseUp, cmd)
    case "wheel":
        let dy = Int32(-(cmd.dy ?? 0))
        let dx = Int32(cmd.dx ?? 0)
        if let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
            event.location = point(cmd)
            event.post(tap: .cghidEventTap)
        }
    case "text":
        let chars = Array((cmd.text ?? "").utf16)
        guard !chars.isEmpty else { return }
        chars.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            if let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) {
                down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: base)
                down.post(tap: .cghidEventTap)
            }
            if let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
                up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: base)
                up.post(tap: .cghidEventTap)
            }
        }
    default:
        break
    }
}

while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let cmd = try? JSONDecoder().decode(Command.self, from: data) else { continue }
    handle(cmd)
}
