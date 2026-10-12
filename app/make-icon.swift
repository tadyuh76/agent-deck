// Draws the Agent Deck app icon: six panels, one of them active.
// Usage: swift make-icon.swift <output.png>
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-1024.png"

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}
func rounded(_ rect: CGRect, _ radius: CGFloat) -> CGPath {
    CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
ctx.translateBy(x: 0, y: size)
ctx.scaleBy(x: 1, y: -1)

// Tile on the macOS icon grid.
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: color(0x000000, 0.35))
ctx.addPath(rounded(tile, 186))
ctx.setFillColor(color(0x1A1E25))
ctx.fillPath()
ctx.restoreGState()
ctx.saveGState()
ctx.addPath(rounded(tile, 186))
ctx.clip()
let background = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [color(0x2C323D), color(0x14171C)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(background, start: CGPoint(x: 0, y: tile.minY), end: CGPoint(x: 0, y: tile.maxY), options: [])
ctx.restoreGState()
ctx.addPath(rounded(tile.insetBy(dx: 1.5, dy: 1.5), 185))
ctx.setStrokeColor(color(0xFFFFFF, 0.10))
ctx.setLineWidth(3)
ctx.strokePath()

// Six panels in a 3 × 2 grid; the top middle one is active.
let cell: CGFloat = 168, gap: CGFloat = 40
let gridWidth = cell * 3 + gap * 2, gridHeight = cell * 2 + gap
let origin = CGPoint(x: (size - gridWidth) / 2, y: (size - gridHeight) / 2)
for row in 0..<2 {
    for column in 0..<3 {
        let rect = CGRect(x: origin.x + CGFloat(column) * (cell + gap), y: origin.y + CGFloat(row) * (cell + gap), width: cell, height: cell)
        if row == 0 && column == 1 {
            ctx.saveGState()
            ctx.setShadow(offset: .zero, blur: 40, color: color(0xE07B5A, 0.65))
            ctx.addPath(rounded(rect, 40))
            ctx.setFillColor(color(0xE07B5A))
            ctx.fillPath()
            ctx.restoreGState()
        } else {
            ctx.addPath(rounded(rect, 40))
            ctx.setFillColor(color(0x4A5361))
            ctx.fillPath()
        }
    }
}

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
