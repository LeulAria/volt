#!/bin/zsh
# GPU process memory split over time for the running arm: every <step> s, footprint categories that matter.
#   ./gpusplit.sh <ud-suffix> <count> [step=5] -> one line per sample
ud=$HOME/.volt-r9/render/ud-$1
for i in $(seq 1 $2); do
	GP=$(pgrep -f "type=gpu-process.*$ud" | head -1)
	RP=$(pgrep -f "type=renderer.*$ud" | tr '\n' ' ')
	F=$(footprint -p $GP 2>/dev/null)
	R=$(for p in ${=RP}; do footprint -p $p 2>/dev/null | sed -n 2p | sed 's/.*Footprint: //;s/ (.*//'; done | tr '\n' ',')
	echo "$(date +%T) gpu $(echo $F | sed -n 2p | sed 's/.*Footprint: //;s/ (.*//') | $(echo $F | grep -E 'IOSurface|unmapped|IOAccelerator \(graphics\)|tag 14' | awk '{s=$1$2; for(i=1;i<=7;i++)$i=""; gsub(/^ +/,""); print s"="$0";"}' | tr '\n' ' ') | renderers $R"
	sleep ${3:-5}
done
