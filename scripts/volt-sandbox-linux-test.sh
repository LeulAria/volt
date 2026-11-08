#!/usr/bin/env bash
#
# Linux test rig for Volt's bubblewrap sandbox backend. Works on any host with Docker (Docker
# Desktop on macOS included): the backend runs inside an Ubuntu 24.04 container as an unprivileged
# user and launches real sandboxes.
#
#   scripts/volt-sandbox-linux-test.sh [run] [--json] [--only name,name]   transpile, build the image, run every check
#   scripts/volt-sandbox-linux-test.sh bench                               startup latency: sandboxed `true` vs plain `true`
#   scripts/volt-sandbox-linux-test.sh probe                               print the backend's capability report
#   scripts/volt-sandbox-linux-test.sh shell                               a shell in the rig (out/ mounted at /volt/out)
#   scripts/volt-sandbox-linux-test.sh verify-syscalls                     check seccomp.ts's syscall numbers on arm64 and amd64
#   scripts/volt-sandbox-linux-test.sh suite                               the adversarial mocha suite (sandboxSecurity.test.ts), required to run
#
# Set VOLT_SANDBOX_NO_TRANSPILE=1 to skip `npm run transpile-client-oxc` (out/ is already fresh).
#
# The container needs three relaxations, none of which the sandbox relies on in production:
# - seccomp=unconfined: Docker's default filter refuses the unshare/clone flags bubblewrap needs.
# - apparmor=unconfined: the docker-default AppArmor profile refuses mounts.
# - systempaths=unconfined: Docker masks /proc paths (over-mounts), and the kernel refuses to
#   mount a fresh proc where any part of /proc is covered, so `bwrap --proc /proc` fails without it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=volt-sandbox-linux-test
DOCKERFILE="$ROOT/build/volt-sandbox/Dockerfile.linux-test"
# The rig mounts a snapshot of the modules it needs, not out/ itself: another build in the same
# checkout starts by deleting out/, which would pull files from under a running test.
SNAPSHOT="$(mktemp -d "${TMPDIR:-/tmp}/volt-sandbox-rig.XXXXXX")"
trap 'rm -rf "$SNAPSHOT"' EXIT
DOCKER_FLAGS=(
	# An init that reaps orphans, as systemd does on a desktop: bubblewrap's monitor exits without
	# reaping the sandbox's pid-1, which would otherwise stay a zombie under node as PID 1.
	--init
	--security-opt seccomp=unconfined
	--security-opt apparmor=unconfined
	--security-opt systempaths=unconfined
	-v "$SNAPSHOT/out:/volt/out:ro"
	-v "$ROOT/package.json:/volt/package.json:ro"
	-v "$ROOT/scripts/volt-sandbox-linux-probe.mjs:/volt/probe.mjs:ro"
)

transpile() {
	if [[ "${VOLT_SANDBOX_NO_TRANSPILE:-}" != "1" ]]; then
		echo "Transpiling src -> out ..." >&2
		(cd "$ROOT" && npm run -s transpile-client-oxc >/dev/null)
	fi
	snapshot
}

snapshot() {
	local dir
	for dir in vs/base/common vs/base/test/common vs/platform/voltSandbox; do
		if [[ ! -d "$ROOT/out/$dir" ]]; then
			echo "out/$dir is missing (another build cleaning out/?); run again" >&2
			exit 1
		fi
		mkdir -p "$SNAPSHOT/out/$dir"
		cp -R "$ROOT/out/$dir/." "$SNAPSHOT/out/$dir/"
	done
	# base/common imports vs/nls.js and its siblings.
	cp "$ROOT"/out/vs/*.js "$SNAPSHOT/out/vs/"
}

build_image() {
	echo "Building $IMAGE ..." >&2
	docker build -q -t "$IMAGE" -f "$DOCKERFILE" "$ROOT/build/volt-sandbox" >/dev/null
}

# Prints `name number` for every syscall in seccomp.ts's table for one architecture, from the
# transpiled module, or the C program that prints the same from the system headers.
syscall_table() {
	node --input-type=module -e "
		const { SECCOMP_SYSCALL_NUMBERS } = await import(process.argv[1]);
		const table = SECCOMP_SYSCALL_NUMBERS[process.argv[2]];
		if (process.argv[3] === 'c') {
			console.log('#include <stdio.h>\n#include <sys/syscall.h>\nint main(void) {');
			for (const name of Object.keys(table).sort()) {
				console.log('#ifdef __NR_' + name + '\n\tprintf(\"' + name + ' %d\\\\n\", __NR_' + name + ');\n#else\n\tprintf(\"' + name + ' missing\\\\n\");\n#endif');
			}
			console.log('\treturn 0;\n}');
		} else {
			for (const name of Object.keys(table).sort()) {
				console.log(name + ' ' + table[name]);
			}
		}
	" "$ROOT/out/vs/platform/voltSandbox/common/seccomp.js" "$1" "${2:-}"
}

verify_syscalls() {
	local failed=0
	for pair in arm64:arm64 x64:amd64; do
		local arch="${pair%%:*}" platform="${pair##*:}"
		echo "Checking $arch syscall numbers (linux/$platform) ..." >&2
		local expected actual
		expected="$(syscall_table "$arch")"
		actual="$(syscall_table "$arch" c | docker run --rm -i --platform "linux/$platform" ubuntu:24.04 bash -c '
			apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gcc libc6-dev >/dev/null 2>&1 \
				&& cat > /tmp/nr.c && gcc -o /tmp/nr /tmp/nr.c && /tmp/nr')"
		if [[ "$expected" == "$actual" ]]; then
			echo "PASS $arch: $(echo "$expected" | wc -l | tr -d ' ') syscall numbers match the kernel headers"
		else
			echo "FAIL $arch:"
			diff <(echo "$expected") <(echo "$actual") || true
			failed=1
		fi
	done
	return $failed
}

cmd="${1:-run}"
if [[ $# -gt 0 ]]; then
	shift
fi

case "$cmd" in
	run)
		transpile
		build_image
		docker run --rm "${DOCKER_FLAGS[@]}" "$IMAGE" node /volt/probe.mjs "$@"
		;;
	bench)
		transpile
		build_image
		docker run --rm "${DOCKER_FLAGS[@]}" "$IMAGE" node /volt/probe.mjs --bench "$@"
		;;
	probe)
		transpile
		build_image
		docker run --rm "${DOCKER_FLAGS[@]}" "$IMAGE" node /volt/probe.mjs --probe "$@"
		;;
	shell)
		snapshot
		build_image
		docker run --rm -it "${DOCKER_FLAGS[@]}" "$IMAGE" bash
		;;
	verify-syscalls)
		transpile
		verify_syscalls
		;;
	suite)
		transpile
		build_image
		# mocha and its dependencies are plain JavaScript, so the host's node_modules work here.
		docker run --rm "${DOCKER_FLAGS[@]}" -v "$ROOT/node_modules:/volt/node_modules:ro" -e VOLT_SANDBOX_REQUIRED=1 "$IMAGE" \
			node /volt/node_modules/mocha/bin/mocha.js --ui tdd --timeout 120000 --exit /volt/out/vs/platform/voltSandbox/test/node/sandboxSecurity.test.js "$@"
		;;
	*)
		sed -n '2,20p' "$0"
		exit 64
		;;
esac
