// Draws the Symphony app icon: a little mochi peeking over a pastel kanban board.
// usage: swift make-icon.swift <out.png>   (writes a 1024x1024 PNG)

import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> NSColor {
  NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
          green: CGFloat((hex >> 8) & 0xff) / 255,
          blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

func rounded(_ r: NSRect, _ radius: CGFloat) -> NSBezierPath {
  NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius)
}

func withShadow(_ blur: CGFloat, _ dy: CGFloat, _ color: NSColor, _ draw: () -> Void) {
  NSGraphicsContext.saveGraphicsState()
  let s = NSShadow()
  s.shadowBlurRadius = blur
  s.shadowOffset = NSSize(width: 0, height: dy)
  s.shadowColor = color
  s.set()
  draw()
  NSGraphicsContext.restoreGraphicsState()
}

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
                           bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                           colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

// macOS icon grid: the tile is 824pt inside a 1024 canvas.
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = rounded(tile, 185)
withShadow(28, -12, rgb(0x6b3d7a, 0.35)) {
  rgb(0xffc8dd).setFill()
  tilePath.fill()
}
NSGradient(colors: [rgb(0xffd6e8), rgb(0xe9d5ff), rgb(0xc7e3ff)])!
  .draw(in: tilePath, angle: -60)

// Four-point sparkle.
func sparkle(_ c: NSPoint, _ r: CGFloat, _ color: NSColor) {
  let k = r * 0.15
  let p = NSBezierPath()
  p.move(to: NSPoint(x: c.x, y: c.y + r))
  p.curve(to: NSPoint(x: c.x + r, y: c.y), controlPoint1: NSPoint(x: c.x + k, y: c.y + k), controlPoint2: NSPoint(x: c.x + k, y: c.y + k))
  p.curve(to: NSPoint(x: c.x, y: c.y - r), controlPoint1: NSPoint(x: c.x + k, y: c.y - k), controlPoint2: NSPoint(x: c.x + k, y: c.y - k))
  p.curve(to: NSPoint(x: c.x - r, y: c.y), controlPoint1: NSPoint(x: c.x - k, y: c.y - k), controlPoint2: NSPoint(x: c.x - k, y: c.y - k))
  p.curve(to: NSPoint(x: c.x, y: c.y + r), controlPoint1: NSPoint(x: c.x - k, y: c.y + k), controlPoint2: NSPoint(x: c.x - k, y: c.y + k))
  color.setFill()
  p.fill()
}
sparkle(NSPoint(x: 230, y: 800), 38, rgb(0xffffff, 0.9))
sparkle(NSPoint(x: 290, y: 730), 18, rgb(0xffffff, 0.75))
sparkle(NSPoint(x: 160, y: 560), 22, rgb(0xffffff, 0.8))

// Music note (Symphony), top right.
do {
  rgb(0x9b6bd6).setFill()
  NSBezierPath(ovalIn: NSRect(x: 712, y: 708, width: 58, height: 46)).fill()
  NSBezierPath(rect: NSRect(x: 756, y: 730, width: 13, height: 120)).fill()
  let flag = NSBezierPath()
  flag.move(to: NSPoint(x: 756, y: 850))
  flag.curve(to: NSPoint(x: 820, y: 790), controlPoint1: NSPoint(x: 800, y: 845), controlPoint2: NSPoint(x: 825, y: 820))
  flag.curve(to: NSPoint(x: 769, y: 818), controlPoint1: NSPoint(x: 805, y: 805), controlPoint2: NSPoint(x: 785, y: 815))
  flag.close()
  flag.fill()
}

// The mochi, peeking out from behind the board.
let body = NSRect(x: 360, y: 520, width: 304, height: 250)
withShadow(22, -8, rgb(0x7a4c8f, 0.25)) {
  rgb(0xfffaf5).setFill()
  NSBezierPath(ovalIn: body).fill()
}
NSGradient(colors: [rgb(0xffffff), rgb(0xfff1ea)])!.draw(in: NSBezierPath(ovalIn: body), angle: -90)
// Eyes with sparkle highlights.
for ex in [455.0, 545.0] {
  rgb(0x3b2a40).setFill()
  NSBezierPath(ovalIn: NSRect(x: ex, y: 655, width: 28, height: 36)).fill()
  rgb(0xffffff).setFill()
  NSBezierPath(ovalIn: NSRect(x: ex + 13, y: 674, width: 10, height: 10)).fill()
}
// Blush.
for bx in [412.0, 578.0] {
  rgb(0xff8fab, 0.55).setFill()
  NSBezierPath(ovalIn: NSRect(x: bx, y: 636, width: 40, height: 22)).fill()
}
// Smile.
do {
  let m = NSBezierPath()
  m.move(to: NSPoint(x: 496, y: 650))
  m.curve(to: NSPoint(x: 512, y: 650), controlPoint1: NSPoint(x: 499, y: 638), controlPoint2: NSPoint(x: 509, y: 638))
  m.curve(to: NSPoint(x: 528, y: 650), controlPoint1: NSPoint(x: 515, y: 638), controlPoint2: NSPoint(x: 525, y: 638))
  m.lineWidth = 6
  m.lineCapStyle = .round
  rgb(0x3b2a40).setStroke()
  m.stroke()
}

// The kanban board.
let board = NSRect(x: 205, y: 185, width: 614, height: 430)
withShadow(30, -14, rgb(0x7a4c8f, 0.28)) {
  rgb(0xffffff).setFill()
  rounded(board, 64).fill()
}
let columns: [[UInt32]] = [[0xffb3c7, 0xffd1dc, 0xffb3c7],
                           [0xffe08a, 0xfff0b8],
                           [0xa8e6cf]]
let colW: CGFloat = 166, gap: CGFloat = 22
for (i, cards) in columns.enumerated() {
  let x = board.minX + 38 + CGFloat(i) * (colW + gap)
  rgb(0xf5f0ff).setFill()
  rounded(NSRect(x: x, y: board.minY + 34, width: colW, height: board.height - 68), 30).fill()
  for (j, hex) in cards.enumerated() {
    let y = board.maxY - 62 - CGFloat(j + 1) * 92
    rgb(hex).setFill()
    rounded(NSRect(x: x + 16, y: y, width: colW - 32, height: 74), 20).fill()
    rgb(0xffffff, 0.75).setFill()
    rounded(NSRect(x: x + 34, y: y + 42, width: colW - 92, height: 12), 6).fill()
  }
}
// A check mark on the "done" card.
do {
  let x = board.minX + 38 + 2 * (colW + gap) + 16, y = board.maxY - 62 - 92
  let check = NSBezierPath()
  check.move(to: NSPoint(x: x + 78, y: y + 26))
  check.line(to: NSPoint(x: x + 94, y: y + 14))
  check.line(to: NSPoint(x: x + 120, y: y + 40))
  check.lineWidth = 9
  check.lineCapStyle = .round
  check.lineJoinStyle = .round
  rgb(0x3fae84).setStroke()
  check.stroke()
}

// Little paws gripping the board edge.
for px in [410.0, 560.0] {
  withShadow(8, -3, rgb(0x7a4c8f, 0.2)) {
    rgb(0xfffaf5).setFill()
    NSBezierPath(ovalIn: NSRect(x: px, y: 588, width: 58, height: 46)).fill()
  }
}
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
