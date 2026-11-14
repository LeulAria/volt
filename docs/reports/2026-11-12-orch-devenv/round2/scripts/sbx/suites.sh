#!/bin/bash
# The sandbox, plugin, extension-sandbox and Security-page suites in one Electron run (adversarial suite separate).
cd /Users/leularia/Desktop/VOLT/volt-e2e-sbx
unset ELECTRON_RUN_AS_NODE
ARGS=()
for f in src/vs/platform/voltSandbox/test/node/*.test.ts src/vs/platform/voltSandbox/test/common/*.test.ts src/vs/platform/voltStdio/test/*/*.test.ts src/vs/platform/voltPlugins/test/*/*.test.ts src/vs/workbench/services/voltRuntime/test/common/{chatSandbox,hostToolSandbox,managedTerminalsSandbox}.test.ts src/vs/workbench/services/voltRuntime/test/browser/cliAgentParity.test.ts src/vs/workbench/services/extensions/test/browser/voltExtensionSandboxService.test.ts src/vs/workbench/services/extensions/test/browser/voltExtensionCodeScan.test.ts src/vs/workbench/api/test/node/voltSandboxed{ExtensionHost,ExtensionSmoke}.test.ts src/vs/server/test/node/voltAgent/serverExtensionSandbox.test.ts src/vs/workbench/contrib/voltSecurity/test/browser/*.test.ts; do
	[ -f "$f" ] || continue
	[[ "$f" == *sandboxSecurity.test.ts ]] && continue
	ARGS+=(--run "$f")
done
echo "files: $(( ${#ARGS[@]} / 2 ))"
VOLT_SANDBOX_REQUIRED=1 ./scripts/test.sh "${ARGS[@]}"
