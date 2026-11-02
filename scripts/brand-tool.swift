// Brand-mark helper for thetatauzd.org (macOS, no dependencies).
//
//   swift scripts/brand-tool.swift key  IN OUT.png        white mark on a flat coloured square -> white on transparent, trimmed
//   swift scripts/brand-tool.swift trim IN OUT.png        crop to the visible box (transparent or near-white margins)
//   swift scripts/brand-tool.swift ico  OUT.ico IN.png... pack square PNGs (16-256 px) into one .ico (PNG entries)
//
// key : alpha comes from the blue channel measured against the top-left corner pixel (the flat background).
// trim: a pixel is blank when alpha <= 8; near-white pixels (all channels > 245) also count as blank, but only when
//       the top-left corner pixel is itself opaque near-white (a white-background logo). A white mark on a
//       transparent background is therefore trimmed by its alpha alone.
// Prints "OUT WxH" so the caller can record the size.
// Faster repeated runs: swiftc -O scripts/brand-tool.swift -o "$TMPDIR/brand-tool"
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let a = CommandLine.arguments
func usage() -> Never {
  FileHandle.standardError.write("usage: brand-tool key|trim IN OUT.png  |  brand-tool ico OUT.ico IN.png...\n".data(using: .utf8)!)
  exit(2)
}
if a.count < 4 { usage() }
let mode = a[1]

func load(_ path: String) -> CGImage {
  guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(s, 0, nil) else { fatalError("cannot read \(path)") }
  return img
}

if mode == "ico" {
  // ICONDIR + one ICONDIRENTRY per image + the PNG files themselves (valid since Windows Vista; all browsers).
  let ins = Array(a[3...])
  var dir = Data(), body = Data()
  func u16(_ v: Int) -> Data { var x = UInt16(v).littleEndian; return Data(bytes: &x, count: 2) }
  func u32(_ v: Int) -> Data { var x = UInt32(v).littleEndian; return Data(bytes: &x, count: 4) }
  dir += u16(0) + u16(1) + u16(ins.count)
  var offset = 6 + 16 * ins.count
  for p in ins {
    let img = load(p)
    guard img.width == img.height, img.width <= 256 else { fatalError("\(p): ico entries must be square and <= 256 px") }
    guard let png = try? Data(contentsOf: URL(fileURLWithPath: p)) else { fatalError("cannot read \(p)") }
    let side = img.width == 256 ? 0 : img.width
    dir += Data([UInt8(side), UInt8(side), 0, 0]) + u16(1) + u16(32) + u32(png.count) + u32(offset)
    body += png; offset += png.count
  }
  do { try (dir + body).write(to: URL(fileURLWithPath: a[2])) } catch { fatalError("cannot write \(a[2])") }
  print("\(a[2]) \(ins.count) image(s)")
  exit(0)
}
guard mode == "key" || mode == "trim" else { usage() }

let img = load(a[2])
let w = img.width, h = img.height
guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
  let base = ctx.data else { fatalError("cannot allocate \(w)x\(h)") }
ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
// Row 0 in memory is the top row of the image, which matches CGImage.cropping(to:) coordinates.
let p = base.bindMemory(to: UInt8.self, capacity: w * h * 4)
let bgB = Double(p[2])
let whiteBackground = p[3] > 247 && p[0] > 245 && p[1] > 245 && p[2] > 245
if mode == "key" && bgB >= 250 { fatalError("key: the corner pixel is already white; use trim") }
var x0 = w, y0 = h, x1 = -1, y1 = -1
for y in 0..<h { for x in 0..<w {
  let i = (y * w + x) * 4
  if mode == "key" {
    let v = UInt8(max(0, min(1, (Double(p[i + 2]) - bgB) / (255 - bgB))) * 255)
    p[i] = v; p[i + 1] = v; p[i + 2] = v; p[i + 3] = v   // premultiplied white at alpha v
  }
  let blank = p[i + 3] <= 8 || (mode == "trim" && whiteBackground && p[i] > 245 && p[i + 1] > 245 && p[i + 2] > 245)
  if !blank { x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y) }
} }
if x1 < 0 { fatalError("\(a[2]): nothing visible to keep") }
guard let full = ctx.makeImage(),
      let out = full.cropping(to: CGRect(x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1)),
      let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[3]) as CFURL, UTType.png.identifier as CFString, 1, nil)
else { fatalError("cannot crop or open \(a[3])") }
CGImageDestinationAddImage(d, out, nil)
guard CGImageDestinationFinalize(d) else { fatalError("cannot write \(a[3])") }
print("\(a[3]) \(x1 - x0 + 1)x\(y1 - y0 + 1)")
