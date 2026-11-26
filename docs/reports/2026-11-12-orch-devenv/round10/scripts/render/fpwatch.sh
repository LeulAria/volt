#!/bin/zsh
# Every $2 s (default 15), footprint of the main, GPU and renderer processes of the profile $1 (a ud path), one line each.
UD=$1; EVERY=${2:-15}
fp() { footprint -p $1 2>/dev/null | sed -n 2p | grep -o 'Footprint: [0-9.]* [KMG]B' | sed 's/Footprint: //'; }
while true; do
	M=$(ps -axo pid=,command= | grep -F -- "--user-data-dir $UD" | grep -v -- "--type=" | grep -v volt-agent-server | grep -v grep | awk '{print $1}' | head -1)
	G=$(ps -axo pid=,command= | grep -F "$UD" | grep -F -- "--type=gpu-process" | grep -v grep | awk '{print $1}' | head -1)
	R=$(ps -axo pid=,command= | grep -F "$UD" | grep -F -- "--type=renderer" | grep -v grep | awk '{print $1}' | head -1)
	[ -z "$M" ] && { echo "$(date +%T) no main"; exit 0; }
	echo "$(date +%T) main $(fp $M) gpu $(fp $G) renderer $(fp $R)"
	sleep $EVERY
done
