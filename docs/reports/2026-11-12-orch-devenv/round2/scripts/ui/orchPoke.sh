#!/bin/sh
# Run beside orchTurn.sh: once the agents chip shows, opens each orchestration surface in turn and
# screenshots it into $1: the Tasks card expanded (poke-tasks), the agents chip's menu (poke-menu),
# a hover on the first subagent row in the side list (poke-dock-hover) and on the first transcript
# row (poke-row-hover). Escape and a mouse move close each one before the next.
DIR=$(cd "$(dirname "$0")" && pwd)
C="node $DIR/cdp.mjs 9945"
OUT=$1
ED='document.querySelector(".volt-agent-editor:not(.browser-hosted)")'
i=0
until [ "$($C eval "!!$ED.querySelector('.volt-agent-composer-chips .volt-agent-composer-chip:not(.status):not(.hidden)')")" = "true" ] || [ $i -ge 120 ]; do
	sleep 0.5
	i=$((i + 1))
done
center() {
	$C eval "(() => { const e = $1; if (!e) { return '0 0'; } const r = e.getBoundingClientRect(); const z = window.devicePixelRatio / 2; return Math.round((r.left + r.width / 2) * z) + ' ' + Math.round((r.top + r.height / 2) * z); })()" | tr -d '"'
}
$C eval "$ED.querySelector('.volt-agent-tasks-head')?.click(); 1" >/dev/null
sleep 0.6
$C shot "$OUT/poke-tasks.png" >/dev/null
$C eval "$ED.querySelector('.volt-agent-tasks-head')?.click(); 1" >/dev/null
sleep 0.4
$C click $(center "$ED.querySelector('.volt-agent-composer-chips .volt-agent-composer-chip:not(.status):not(.hidden)')") >/dev/null
sleep 0.6
$C shot "$OUT/poke-menu.png" >/dev/null
$C key Escape >/dev/null
sleep 0.4
$C move $(center "document.querySelector('.volt-agent-quick-open-body .volt-agent-lineage .monaco-list-row')") >/dev/null
sleep 1.2
$C shot "$OUT/poke-dock-hover.png" >/dev/null
$C move $(center "$ED.querySelector('.volt-tr-subagent')") >/dev/null
sleep 1.2
$C shot "$OUT/poke-row-hover.png" >/dev/null
$C move 5 400 >/dev/null
echo poked
