#!/bin/zsh
# Stops every arm's test instance (they share CDP 9983; a launch that timed out leaves its instance running).
cd ${0:A:h}
for ud in $HOME/.volt-r9/render/ud-*(N/); do
	pgrep -f -- "--user-data-dir $ud( |\$)" >/dev/null || pgrep -f -- "$ud/" >/dev/null || continue
	(source ./arm.sh ${ud:t:s/ud-//} 2>/dev/null; SPEED_UD=$ud node launch.mjs stop >/dev/null)
done
