// Lists the on-screen layer-0 windows (pid, owner, width, height), the same query ademark-native's `cover` uses to
// find its window. a6.mjs records with it whether the test window was on the screen during a sample (it is not
// while the user works in a full-screen app: the window opens on the desktop Space, and `cover` finds nothing).
//   swiftc -O winlist.swift -o ~/.volt-r6/idle/explore/winlist/winlist
import CoreGraphics
import Foundation
let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for e in entries {
  let layer = (e[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
  if layer != 0 { continue }
  let owner = e[kCGWindowOwnerName as String] as? String ?? "?"
  let pid = (e[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
  let b = e[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print(pid, owner, b["Width"] ?? "", b["Height"] ?? "")
}
