// winwait: waits for the first on-screen layer-0 window owned by a process whose executable path
// starts with --prefix. Needs no Screen Recording grant (window owner and bounds only).
// Prints {"pid":..,"t_ns":..,"w":..,"h":..} with t_ns on CLOCK_UPTIME_RAW (the clock ADEMark uses).
import Foundation
import CoreGraphics
import Darwin

func now() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }
var prefix = ""; var timeout = 60.0; var minSide = 200.0
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
  switch a {
  case "--prefix": prefix = args.next() ?? ""
  case "--timeout-s": timeout = Double(args.next() ?? "60") ?? 60
  case "--min-side": minSide = Double(args.next() ?? "200") ?? 200
  default: break
  }
}
func pathOf(_ pid: pid_t) -> String {
  var buf = [CChar](repeating: 0, count: 4096)
  let n = proc_pidpath(pid, &buf, UInt32(buf.count))
  return n > 0 ? String(cString: buf) : ""
}
var known: [pid_t: Bool] = [:]
let start = now()
while Double(now() - start) / 1e9 < timeout {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { continue }
  for w in list {
    guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
          let pid = w[kCGWindowOwnerPID as String] as? Int32,
          let b = w[kCGWindowBounds as String] as? [String: Double] else { continue }
    let ok: Bool
    if let k = known[pid] { ok = k } else {
      var p = pathOf(pid)
      if p.hasPrefix("/private/") { p = String(p.dropFirst(8)) }
      var q = prefix
      if q.hasPrefix("/private/") { q = String(q.dropFirst(8)) }
      ok = p.hasPrefix(q); known[pid] = ok
    }
    if ok, (b["Width"] ?? 0) >= minSide, (b["Height"] ?? 0) >= minSide {
      print("{\"pid\":\(pid),\"t_ns\":\(now()),\"w\":\(b["Width"]!),\"h\":\(b["Height"]!)}")
      exit(0)
    }
  }
  usleep(2000)
}
print("{\"error\":\"timeout\"}"); exit(4)
