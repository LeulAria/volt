#!/bin/sh
# Like liveTurn.sh, for the orchestration sweep: new chat in the test window (CDP 9945), sends $2,
# installs orchSweep.js (clip/overlap/contrast/align/jump per frame) and the label monitor, screenshots
# every 0.4 s, $3 times, into $1, then writes the sweep's findings to $1/sweep.json and what each
# place says about the subagents over time (agentsTrace.js) to $1/trace.json.
# usage: orchTurn.sh <outdir> <prompt> [frames=80]
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
C="node $DIR/cdp.mjs 9945"
OUT=$1
FRAMES=${3:-80}
rm -rf "$OUT" && mkdir -p "$OUT"
$C eval '(() => { const b = [...document.querySelectorAll(".part.titlebar [aria-label]")].find(e => e.getAttribute("aria-label") === "New Agent"); b.click(); return 1; })()' >/dev/null
sleep 2
$C evalf "$DIR/orchSweep.js" >/dev/null
$C evalf "$DIR/labelMonitor.js" >/dev/null
$C evalf "$DIR/agentsTrace.js" >/dev/null
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
$C eval 'JSON.stringify({ sweep: window.__voltSweep.filter(f => f.kind !== "contrast"), contrast: window.__voltSweep.filter(f => f.kind === "contrast").map(f => f.ratio + " " + f.text), labelHits: window.__voltLabelHits.slice(0, 20) }, null, 1)' > "$OUT/sweep.json"
$C eval 'JSON.stringify(window.__voltAgentsTrace, null, 1)' > "$OUT/trace.json"
cat "$OUT/sweep.json"
node -e 'for (const l of JSON.parse(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")))) console.log(l.t, JSON.stringify(l))' "$OUT/trace.json"
