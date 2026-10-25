/**
 * The site's own pages as data: About, Contact and Privacy (rendered as HTML by their routes and as
 * Markdown at /about.md and so on), plus the Markdown versions of the landing and download pages that
 * agents get from /index.md or with `Accept: text/markdown`. Body text is inline Markdown (bold,
 * italics, code, links), the same subset the changelog page renders.
 */

import { appName, gitConfig } from "./shared";

export const SITE_REPO_URL = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
export const SITE_DISCORD_URL = "https://discord.gg/SJ97jqDVN";
const INSTALL_COMMAND = `curl -fsSL https://raw.githubusercontent.com/${gitConfig.user}/${gitConfig.repo}/main/install.sh | bash`;

export interface InfoSection {
  heading: string;
  paragraphs: string[];
  /** Bullet items after the paragraphs. */
  items?: string[];
}

export interface InfoPage {
  path: "/about" | "/contact" | "/privacy";
  eyebrow: string;
  title: string;
  description: string;
  /** ISO date the text last changed (shown on the page and used as the sitemap's lastmod). */
  updated: string;
  sections: InfoSection[];
}

export const ABOUT_PAGE: InfoPage = {
  path: "/about",
  eyebrow: "About",
  title: "About Volt.",
  description:
    "Volt is an open-source agentic development workspace for macOS, Windows and Linux: an editor, Git, a terminal and AI coding agents in one window.",
  updated: "2026-10-25",
  sections: [
    {
      heading: "What Volt is",
      paragraphs: [
        "Volt is an agentic development workspace: a desktop app where you plan, review and ship code with AI coding agents. The editor, Git, terminals, an in-app browser and a whiteboard sit in one window, so you can watch every agent work, see each file it changed under the turn that changed it, and step in at any point.",
        "Volt is built on VS Code (Code - OSS 1.105), so it edits like the editor you know, and it installs extensions from the Open VSX registry. It adds an agent layout on top: chats with subagents, worktrees, pull requests, usage tracking and automations.",
      ],
    },
    {
      heading: "Bring your own agents",
      paragraphs: [
        "Volt doesn't sell tokens. It runs the coding agents you already pay for, such as Claude Code, Codex, OpenCode, Cursor, Grok, Antigravity and Kimi Code, with the sign-in you already have, and it can talk to local models through Ollama, LM Studio or vLLM. You keep your plan; Volt gives the agents a better place to work.",
      ],
    },
    {
      heading: "Open source, in public beta",
      paragraphs: [
        `Volt is free and open source under the MIT License. The code, the issue tracker and every release live on GitHub at [${gitConfig.user}/${gitConfig.repo}](${SITE_REPO_URL}). It is developed in the open by Volt ADK and contributors.`,
        "Volt is in public beta and below 1.0, so it changes quickly. Builds come in three channels that install side by side: Stable, Beta and Nightly. The [changelog](/changelog) lists what changed in each release, and the [download page](/download) has the latest build for your computer.",
      ],
    },
  ],
};

export const CONTACT_PAGE: InfoPage = {
  path: "/contact",
  eyebrow: "Contact",
  title: "Get in touch.",
  description:
    "How to reach the Volt team: Discord for questions, GitHub issues for bugs and ideas, and a private form for security reports.",
  updated: "2026-10-25",
  sections: [
    {
      heading: "Questions and conversation",
      paragraphs: [
        `The quickest way to reach the people who build Volt is the [Volt Discord](${SITE_DISCORD_URL}). Ask how something works, share what you are building, or tell us what got in your way.`,
      ],
    },
    {
      heading: "Bugs and feature requests",
      paragraphs: [
        `Report bugs and suggest features in [GitHub Issues](${SITE_REPO_URL}/issues/new/choose). A good bug report says which Volt version you run (Volt > About Volt), your operating system, what you did, what you expected and what happened instead. Screenshots and logs help.`,
      ],
    },
    {
      heading: "Security reports",
      paragraphs: [
        `Please don't report a security problem in a public issue. Use GitHub's [private vulnerability reporting form](${SITE_REPO_URL}/security/advisories/new) instead; only the maintainers can see it. You get an acknowledgement within 5 business days, and the fix is published with an advisory coordinated with you. The full policy is in [SECURITY.md](${SITE_REPO_URL}/blob/main/SECURITY.md).`,
      ],
    },
    {
      heading: "Contributing",
      paragraphs: [
        `Volt is open source, and pull requests are welcome. Start with [CONTRIBUTING.md](${SITE_REPO_URL}/blob/main/CONTRIBUTING.md), which explains how to build Volt from source and how changes are reviewed.`,
      ],
    },
  ],
};

export const PRIVACY_PAGE: InfoPage = {
  path: "/privacy",
  eyebrow: "Privacy",
  title: "Privacy.",
  description:
    "What this website and the Volt app collect: no cookies or ads on the site, aggregated page-view counts, and no telemetry from the app.",
  updated: "2026-10-25",
  sections: [
    {
      heading: "In short",
      paragraphs: [
        "This website sets no cookies and shows no ads. It counts page views in aggregate, without identifying you. The Volt app has no analytics or telemetry: it does not send your code, your chats or your usage to us.",
      ],
    },
    {
      heading: "This website",
      paragraphs: [
        "The site is served by Vercel. Like any web host, Vercel processes the technical details of each request (your IP address, the page you asked for, your browser's user agent) to deliver the page and protect the site from abuse, under [Vercel's privacy policy](https://vercel.com/legal/privacy-policy).",
        "Page views are counted with Vercel Web Analytics. It uses no cookies; a visitor is told apart by a hash of the request that is discarded after 24 hours. It records the page, the referring site, your country and region, your browser, operating system and device type, and we only see aggregated numbers.",
      ],
      items: [
        "**GitHub.** The download page and the header ask GitHub's public API for the latest releases and the star count, straight from your browser, so GitHub sees that request. The release list is kept in your browser's session storage for 10 minutes. Downloads and the install script come from GitHub Releases and raw.githubusercontent.com. See [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).",
        "**Google Fonts.** The monospaced font (Geist Mono) loads from Google Fonts, so Google receives the request for it. See [Google's privacy policy](https://policies.google.com/privacy).",
      ],
    },
    {
      heading: "The Volt app",
      paragraphs: [
        "Volt runs on your computer. Your code, chats, settings and history stay on your machine. The app has no analytics or telemetry service configured, so it does not report how you use it.",
        "Volt connects to services only to do what you ask, and only to the ones you choose:",
      ],
      items: [
        "**AI providers and agents** you sign in to (for example Claude Code, Codex or Cursor). Your prompts, and the code and files the agent reads, go to that provider under its terms.",
        "**GitHub** to check for updates (the release feed on raw.githubusercontent.com) and, when you use them, for Git hosting and pull requests.",
        "**MCP servers, extensions and webhooks** you add yourself.",
      ],
    },
    {
      heading: "Questions",
      paragraphs: [
        `Ask about privacy on [Discord](${SITE_DISCORD_URL}) or in a [GitHub issue](${SITE_REPO_URL}/issues/new/choose). If this policy changes, the date at the top of this page changes with it.`,
      ],
    },
  ],
};

export const INFO_PAGES: readonly InfoPage[] = [
  ABOUT_PAGE,
  CONTACT_PAGE,
  PRIVACY_PAGE,
];

export function infoPageMarkdown(page: InfoPage): string {
  const parts = [
    `# ${page.title.replace(/\.$/, "")}`,
    page.description,
    `_Last updated ${page.updated}._`,
  ];
  for (const section of page.sections) {
    parts.push(`## ${section.heading}`, ...section.paragraphs);
    if (section.items?.length) {
      parts.push(section.items.map((item) => `- ${item}`).join("\n"));
    }
  }
  parts.push(SITE_LINKS_MARKDOWN);
  return `${parts.join("\n\n")}\n`;
}

const SITE_LINKS_MARKDOWN = `## More

- [Home](/index.md) · [Download](/download.md) · [Changelog](/changelog.md) · [Docs](/docs) · [About](/about.md) · [Contact](/contact.md) · [Privacy](/privacy.md)
- Every docs page as Markdown: [/llms.txt](/llms.txt), or all of them in one file: [/llms-full.txt](/llms-full.txt)
- MCP server for agents: \`POST /api/mcp\` (Streamable HTTP)`;

/** `/` as Markdown: the landing page's words, in its order. */
export function homeMarkdown(): string {
  return `# ${appName}: the agentic development workspace

Workspace, editor, Git and terminal, unified in one lightning-fast surface. AI agents handle the mechanics so you stay in flow.

${appName} is free while in public beta, for macOS, Windows and Linux. [Download it](/download.md), or install from a terminal (macOS and Linux):

\`\`\`bash
${INSTALL_COMMAND}
\`\`\`

## Watch every agent work, start to finish

- **Visible.** Each change, each turn, each subagent. Every file sits under the turn that changed it, with the lines it added and removed.
- **Orchestrator and subagents.** The agent that orchestrates splits the work into tasks, hands them to subagents, and checks each one off as it lands.
- **In parallel.** Agents run side by side. Each one keeps its model, status and run time, and a click opens its chat beside yours.
- **Every model.** Claude, GPT, Gemini, Grok, or a local model in one picker. Tune context and effort per chat, and switch mid-conversation.
- **Usage insights.** Track where your tokens and spend go: tokens per day by kind, how much came from cache, and each model's share of the bill.
- **Skills.** Find any skill from skills.sh, plus plugins and MCP servers, in one search. Add one in a click and every agent can use it.
- **Automations.** Start an agent on a schedule, a webhook, or an event from GitHub, GitLab, Slack, Linear, Jira or Sentry.
- **Accounts with auto switch.** Sign in to several Claude accounts and see each one's session and weekly usage. Near a limit, ${appName} switches to the one with the most left.

## Agent + IDE

${appName} integrates the agent and the IDE into one. Highly inspired by Cursor, ${appName} is an open-source agentic development environment, built on VS Code.

## Bring your own subscription, or any model you like

${appName} doesn't sell tokens. Plug in Claude Code, Codex, OpenCode, Cursor, Grok, Antigravity or Kimi Code with the sign-in you already have. ${appName} runs them; you keep your plan.

- **Models:** Claude, OpenAI, Gemini, Grok, DeepSeek, Mistral, Llama, Qwen, Kimi, GLM, MiniMax, Perplexity.
- **Self-hosted and gateways:** Ollama, LM Studio, vLLM, NVIDIA NIM, Hugging Face, OpenRouter, Groq, Together AI, Amazon Bedrock, Vertex AI, Azure OpenAI.

## Get started with ${appName}

Free while in public beta. macOS, Windows and Linux. Get the latest build from the [download page](/download.md) or [GitHub Releases](${SITE_REPO_URL}/releases/latest), and follow the [install guide](/docs/install) on a Mac.

${SITE_LINKS_MARKDOWN}
`;
}

/** `/download` as Markdown. The page itself reads GitHub Releases live; this points at the same files. */
export function downloadMarkdown(): string {
  return `# Download ${appName}

${appName} is free while in public beta, for macOS (Apple silicon and Intel), Windows (x64 and Arm) and Linux (x64, arm64, armhf).

- **Latest release:** [GitHub Releases](${SITE_REPO_URL}/releases/latest) lists every file of the newest Stable build with its checksum.
- **macOS:** \`volt-stable-<version>-darwin-arm64.dmg\` for Apple silicon, \`-darwin-x64.dmg\` for Intel. The build is not signed with an Apple Developer ID yet; the [install guide](/docs/install) shows how to open it the first time.
- **Windows:** \`volt-stable-<version>-win32-<arch>-user-setup.exe\` (or the system setup and \`.zip\`).
- **Linux:** \`.deb\`, \`.rpm\` or \`.tar.gz\` for your architecture.

Install from a terminal on macOS or Linux. The script picks the right file, checks its SHA-256 against the release and installs it without \`sudo\`:

\`\`\`bash
${INSTALL_COMMAND}
\`\`\`

## Channels

Stable, Beta and Nightly are separate apps (Volt, Volt Beta, Volt Nightly) with their own settings and updates, so they install side by side. Beta builds are tagged \`v<version>-beta.<n>\`; Nightly is rebuilt every night from \`main\`.

${SITE_LINKS_MARKDOWN}
`;
}

export function notFoundMarkdown(pathname: string): string {
  return `# Not found

There is no page at \`${pathname}\` on this site.

Where to look next:

- [Home](/index.md): what ${appName} is.
- [Docs](/llms.txt): every documentation page, as Markdown links.
- [Download](/download.md) and the [changelog](/changelog.md).
- [Sitemap](/sitemap.xml): every public page.
`;
}
