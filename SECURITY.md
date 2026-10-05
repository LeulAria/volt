# Security Policy

Volt runs AI agents against your source code, your shell, and your browser sessions. We take that seriously, and we want to hear about anything that weakens the guarantees described below.

## Reporting a vulnerability

**Please don't report security vulnerabilities through public issues, discussions, or pull requests.**

Use GitHub's private reporting form instead:

**[Report a vulnerability](https://github.com/LeulAria/VOLT/security/advisories/new)**

Only the maintainers can see what you submit there. If the form isn't available to you, open a public issue that says only that you have a security report and asks for a private channel. Don't include any details.

A good report has:

- What the issue is and which component it affects (for example the access broker, the host MCP server, the in-app browser, or project cloning)
- The Volt commit or version, your operating system, and which agent or model was in use
- Steps to reproduce, or a proof of concept. Minimal is better.
- What an attacker gains: what they can read, write, run, or exfiltrate, and what they need first
- Whether you've shared it with anyone else, and any disclosure deadline you're working to

Please redact secrets, tokens, and other people's data from anything you attach.

### What to expect

| Step | Target |
| --- | --- |
| Acknowledgement of your report | within 5 business days |
| First assessment (accepted, needs more information, or declined, with reasons) | within 14 days |
| Fix or mitigation for a confirmed issue | depends on severity; we'll keep you updated at least every 14 days |
| Public advisory | after a fix is available, coordinated with you |

We follow coordinated disclosure. Please give us up to **90 days** from your report to ship a fix before you publish details. If an issue is being actively exploited, tell us and we'll move faster. We'll credit you in the advisory unless you ask us not to. Volt is a volunteer-run open-source project, so we don't offer a bug bounty.

### Safe harbor

If you act in good faith, we won't pursue or support legal action against you for research that follows this policy. That means you:

- Test only against your own installs, accounts, and data
- Avoid privacy violations, data destruction, and service disruption
- Stop and report as soon as you can show impact, instead of going further
- Give us reasonable time to respond before disclosing

## Supported versions

Volt is a public beta and moves quickly. Security fixes go into the latest commit on `main` and, once packaged installers are published, the most recent release. Older builds are not patched; update to the newest one.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Latest release | Yes |
| Anything older | No |

## Scope

### In scope

Weaknesses in code that Volt itself adds to VS Code, especially anything that lets an attacker cross a trust boundary the user relied on:

- **The access broker and policy compiler** (`src/vs/workbench/services/voltRuntime/common/access`): getting an agent to perform an action that the active preset, project rules, or mode should have denied or asked about, including bypasses of the hard-deny list
- **Host tools and the loopback MCP server** (`src/vs/platform/voltHostMcp`): reaching the server from a web page, another local user, or a non-Volt process; token or `Host`/`Origin` validation flaws
- **Process execution** (`src/vs/platform/voltStdio`): escaping the user, window, or working-directory scoping, or leaking one window's processes to another
- **Git snapshots and restore** (`src/vs/platform/voltGit`): a checkpoint or restore that touches the user's index, branches, or files outside the project, or follows a hostile path
- **Project import** (`src/vs/workbench/contrib/voltProjects`): option or command injection through Git URLs, folder names, or GitHub data; token exposure while cloning
- **The in-app browser** (`src/vs/platform/voltBrowser`, `contrib/voltAgent/browser/preview`): a page escaping its `webview`, or reaching Volt's APIs, the host MCP server, or the user's local files
- **Credential handling**: API keys or tokens written to disk, logs, transcripts, or prompts in the clear, or sent to a host other than the one the user configured
- **Session history** and attachments on disk
- **The docs site** (`apps/docs`)

### Out of scope

- **Vulnerabilities in upstream VS Code** that Volt doesn't change. Report those to the [Microsoft Security Response Center](https://msrc.microsoft.com/create-report). If you're not sure whether Volt's patches are involved, report it to us and we'll sort it out.
- **Third-party agents, models, and extensions**, such as Claude Code, Codex, or an extension from Open VSX. Report those to their vendors. A way for Volt to make one of them more dangerous than it is on its own is in scope.
- **Actions the user's own settings permit.** A *Full access* or *Auto* chat that runs a destructive command, or a *Supervised* chat after you click Allow, is working as designed. A prompt injection that gets an action through that *should* have been blocked or confirmed is in scope.
- Attacks that need an already-compromised machine, a malicious Volt build, or physical access to an unlocked device
- Missing hardening headers or best-practice suggestions with no demonstrated impact
- Denial of service through unreasonably large inputs to a local-only feature
- Social engineering of maintainers or contributors

## Trust model

Knowing what Volt does and doesn't promise will help you use it safely, and will help you judge whether something you've found is a vulnerability.

### Agents act with your authority

**Volt's permission system is an approval policy, not a sandbox.** When you allow an agent to run a shell command or edit a file, it does that as you, with your user's file access, environment variables, and network. Volt decides *whether to ask*; it does not contain what happens after you say yes.

- Four presets control the default: *Supervised* (the default; asks before edits and commands), *Auto-accept edits*, *Auto*, and *Full access*. Project, agent, session, and mode rules layer on top. *Plan* and *Ask* modes deny edits and shell outright.
- A **hard-deny list** blocks a short set of catastrophic actions, such as `rm -rf /`, force-pushes, and reading `.env*`, `.ssh`, and private-key files, and it applies even under *Full access*. It is a guardrail based on patterns. It will not stop a determined or confused agent from reaching the same outcome another way, and shouldn't be treated as a security boundary.
- Agent CLIs that Volt launches over ACP also enforce their own permission systems. Volt maps its policy onto theirs where it can, but each tool is ultimately in charge of itself.

If you need real isolation, run Volt in a container, a VM, or a separate user account, and give agents only the credentials the task needs.

### Untrusted repositories are untrusted code

Opening a repository and starting an agent is not the same as reading it. Content in a project can steer an agent or run on your machine:

- **Instruction files** such as `AGENTS.md`, `CLAUDE.md`, `.volt/AGENTS.md`, `.cursorrules`, and `.github/copilot-instructions.md` are fed to the model as instructions. A hostile file can try to talk an agent into doing things you didn't ask for.
- **MCP configuration** in `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, and `.volt/mcp.json` can name commands that Volt starts when a native-model chat discovers its tools. There is currently no per-server approval prompt for these. Read the file before you start a chat in a repository you don't trust.
- **Anything the agent reads**, including web pages in the in-app browser, issue text, and tool output, can contain prompt injection.

Use *Supervised* mode, read what an agent proposes before approving it, and keep *Full access* for code you'd be comfortable running yourself.

### What Volt does to protect you

| Area | Behavior |
| --- | --- |
| **Provider API keys** | Stored in the editor's secret storage (encrypted with the operating system's keychain where the platform provides one), never in settings files. They are sent only to the provider endpoint you configured. |
| **Agent CLI credentials** | Stay with each CLI. Volt launches the tool and doesn't copy or store its login. To show usage for Claude Code and Cursor, Volt reads their locally stored tokens and sends them only to those vendors' own usage endpoints. |
| **Host MCP server** | Volt's browser and question tools reach agents through an MCP server bound to `127.0.0.1` on a random port, one per window. Every request needs a random 32-byte bearer token (compared in constant time), a loopback `Host` header, and no `Origin` or `Sec-Fetch-*` header, so web pages, including the in-app browser's, can't call it. Only `POST` is accepted, with a 4 MB body limit. No CORS headers are ever sent. |
| **Git checkpoints** | Snapshots are built with a private index and stored under hidden refs (`refs/volt/*`). They never alter your index, working tree, or branches. Oversized files and dependency directories such as `node_modules` are skipped. |
| **Project import** | Git URLs are validated to reject option injection and the `ext::` transport. GitHub tokens are handed to Git per process, not written to config. |
| **Child processes** | Agent and shell processes are owned by the window that started them and are terminated when the window reloads or closes. |
| **Telemetry** | Volt ships with no telemetry endpoint and no update server configured. |

### What leaves your machine

Volt itself doesn't phone home. Data goes where you send it:

- **Prompts, file contents, tool results, and browser snapshots** go to the model provider or agent CLI you select for that chat. Local models (Ollama, LM Studio) keep it on your machine.
- **Tab prediction** is on by default. It sends the code around your cursor, imports, diagnostics, recent edits, and a truncated clipboard to the model you chose for prediction. Files such as `.env*`, lockfiles, and `secrets*` are excluded by default, and you can turn the feature off in **Volt Settings**.
- **Other requests**: GitHub's API when you add a project from GitHub, [Open VSX](https://open-vsx.org) for extensions, the usage endpoints of agents you've signed into, and a public price list used to estimate token costs.
- **Extension marketplace.** Extensions come from Open VSX and run in the extension host with your user's privileges, as in any VS Code. Install only what you trust.

### Supply chain

- Dependencies are locked in `package-lock.json`.
- When an ACP adapter isn't installed, Volt launches a **pinned** version of it through `npx`. Install the adapter yourself if you'd rather it come from your own toolchain.
- Built-in extensions are pinned by version and checksum in `product.json`.

## Hardening checklist

- Leave new projects on **Supervised** and widen permissions per chat, not globally.
- Use a per-chat worktree when you let an agent work unattended, so it works on a checkout you can throw away.
- Don't run *Full access* on code you haven't read, or with credentials in your environment that the task doesn't need.
- Review `AGENTS.md` and MCP configuration files in a repository before the first chat.
- Keep Volt and your agent CLIs up to date.
- Turn off tab prediction for repositories whose source can't leave your machine, or use a local model.

## Questions

For anything that isn't a vulnerability, open a normal [issue](https://github.com/LeulAria/VOLT/issues). Thank you for helping keep Volt and its users safe.
