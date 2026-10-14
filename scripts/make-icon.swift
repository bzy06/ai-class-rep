import AppKit
import Foundation

let size = 1024
guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    fputs("无法创建图标画布\n", stderr)
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: size, height: size).fill()

let circle = NSBezierPath(ovalIn: NSRect(x: 48, y: 48, width: 928, height: 928))
NSColor(srgbRed: 180.0 / 255.0, green: 51.0 / 255.0, blue: 42.0 / 255.0, alpha: 1).setFill()
circle.fill()

let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .center
let font = NSFont(name: "Songti SC", size: 560) ?? NSFont.systemFont(ofSize: 560, weight: .bold)
let attributes: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: NSColor.white,
    .paragraphStyle: paragraph,
]
let text = "课" as NSString
text.draw(in: NSRect(x: 48, y: 230, width: 928, height: 680), withAttributes: attributes)
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else {
    fputs("无法导出图标\n", stderr)
    exit(1)
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
