// EL-SDK: Electron (a VS Code fork); Claude Code through the Agent Client Protocol adapter
// `@agentclientprotocol/claude-agent-acp` (Claude Agent SDK over the system `claude`), Codex through `codex-acp` (ADES.md 3.18).
import { profileAdapter } from "./profile.ts";

export const volt = profileAdapter({
  id: "volt",
  name: "Volt",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  appName: "Volt",
  bundleId: "com.leularia.volt",
  // ADES.md 3.18: the app's own CLI (`bin/code <folder>`) opens the arena; CDP and the agent server's HTTP API exist too.
  drive: "cli",
  // ADES.md 3.18: Electron profile in ~/Library/Application Support/Volt, Volt's own data in ~/.volt.
  dataDirs: ["~/Library/Application Support/Volt", "~/.volt"],
  // ADES.md 3.18: the agent server runs as a launch agent named after the user data folder:
  // com.volt.agent-server.<first 12 hex of sha256("/Users/ademark/Library/Application Support/Volt")>.
  launchAgents: ["com.volt.agent-server.f097d5268fa1"],
  vendorDirs: ["~/.volt"],
});
