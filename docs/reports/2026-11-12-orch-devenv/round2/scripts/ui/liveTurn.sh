#!/bin/sh
# Starts a new chat in the test window (CDP 9945), sends $2, and screenshots it every 0.4 s, $3 times,
# into directory $1, with the overlap and label monitors installed. Prints the monitors' findings.
# usage: liveTurn.sh <outdir> <prompt> [frames=40]
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
C="node $DIR/cdp.mjs 9945"
OUT=$1
FRAMES=${3:-40}
rm -rf "$OUT" && mkdir -p "$OUT"
$C eval '(() => { const b = [...document.querySelectorAll(".part.titlebar [aria-label]")].find(e => e.getAttribute("aria-label") === "New Agent"); b.click(); return 1; })()' >/dev/null
sleep 2
$C evalf "$DIR/overlapMonitor.js" >/dev/null
$C evalf "$DIR/labelMonitor.js" >/dev/null
$C eval 'document.querySelector(".volt-agent-editor:not(.browser-hosted) .volt-agent-monaco textarea").focus(); 1' >/dev/null
$C type "$2" >/dev/null
sleep 0.3
$C enter >/dev/null
uptime > "$OUT/uptime.txt"
i=1
while [ $i -le "$FRAMES" ]; do
	$C shot "$OUT/s$i.png" >/dev/null
	sleep 0.4
	i=$((i + 1))
done
$C eval 'JSON.stringify({ overlaps: window.__voltOverlaps.filter(o => !/status-motion|^code/.test(o.a)), labelHits: window.__voltLabelHits.slice(0, 20), labels: [...window.__voltLabelSeen] }, null, 1)' > "$OUT/monitor.json"
cat "$OUT/monitor.json"
