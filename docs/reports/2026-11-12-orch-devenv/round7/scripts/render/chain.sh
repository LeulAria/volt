#!/bin/zsh
# Round 7 render's release measurements, interleaved: waits for this branch's build (~/.volt-r7/render/min/READY),
# then A7 (both arms per round, a7block.sh) and A5/A10 (block.sh per arm), arm order flipped in the second round.
# Each block takes ~/.volt-r7/timing.lock itself. Log: ~/.volt-r7/render/chain.log
cd ${0:A:h}
until [ -f $HOME/.volt-r7/render/min/READY ]; do
	pgrep -f 'render/minbuild.sh' >/dev/null || { echo "build gone without READY $(date)"; exit 1; }
	sleep 60
done
echo "== chain start $(date) $(head -2 $HOME/.volt-r7/render/min/READY | tail -1)"
curl -sf http://127.0.0.1:18983/_ademark/health >/dev/null || ./setup.sh replay
ARMS="minbefore minafter" ./a7block.sh 1
./block.sh minafter
./block.sh minbefore
ARMS="minafter minbefore" ./a7block.sh 1
./block.sh minbefore
./block.sh minafter
./stopall.sh
echo "== chain done $(date)"
