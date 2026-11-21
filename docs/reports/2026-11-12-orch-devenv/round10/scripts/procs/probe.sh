#!/bin/zsh
# Per-process footprint (macOS `footprint`, phys) of the running test instance of one arm, by role.
#   ./probe.sh <arm>
cd ${0:A:h}
source ./arm.sh $1
node --input-type=module -e '
import { profileProcesses } from "./lib.mjs"; import { role } from "./roles.mjs"; import { execSync } from "child_process";
const by = {}; let total = 0;
for (const p of profileProcesses()) { let f = 0; try { const m = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(execSync(`footprint -p ${p.pid} 2>/dev/null`).toString()); f = m ? Number(m[1]) * (m[2] === "GB" ? 1024 : m[2] === "KB" ? 1 / 1024 : 1) : 0; } catch {}
  const r = role(p.cmd); const b = by[r] ??= { n: 0, mib: 0 }; b.n++; b.mib += f; total += f; }
for (const [r, b] of Object.entries(by).sort((a, b) => b[1].mib - a[1].mib)) console.log(String(Math.round(b.mib)).padStart(6), "MiB", ("n=" + b.n).padEnd(5), r);
console.log(String(Math.round(total)).padStart(6), "MiB total");'
