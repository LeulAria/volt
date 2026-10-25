import { createFileRoute } from "@tanstack/react-router";
import { createFromSource } from "fumadocs-core/search/server";
import {
  changelogMarkdown,
  markdownPathFor,
  pageMarkdown,
} from "@/lib/agentMarkdown";
import { parseChangelog } from "@/lib/changelog";
import {
  CHANNELS,
  type Channel,
  pickChannelReleases,
  trimReleases,
} from "@/lib/releases";
import { absoluteUrl } from "@/lib/seo";
import { gitConfig } from "@/lib/shared";
import { source } from "@/lib/source";

/**
 * The site's MCP server (Streamable HTTP, stateless): POST one JSON-RPC message, get one JSON
 * response. Read-only tools for agents: search the docs, read any page as Markdown, find the latest
 * download, read the changelog. Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 */

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = {
  name: "volt-website",
  title: "Volt website",
  version: "1.0.0",
};
const RELEASES_API = `https://api.github.com/repos/${gitConfig.user}/${gitConfig.repo}/releases?per_page=30`;

/** Browsers may call this only from the site itself (or a local dev server); other clients send no Origin. */
const ALLOWED_ORIGIN =
  /^https?:\/\/(getvolt\.dev|www\.getvolt\.dev|volt\.leularia\.com|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/;

const search = createFromSource(source, { language: "english" });

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

const TOOLS = [
  {
    name: "search_docs",
    title: "Search the Volt docs",
    description:
      "Search Volt's documentation. Returns matching pages and headings with their URLs; read one with get_page.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to look for, e.g. 'install on mac' or 'worktrees'.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Most results to return (default 8).",
        },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_page",
    title: "Read a page as Markdown",
    description:
      "Read a page of getvolt.dev as Markdown: '/', '/download', '/changelog', '/about', '/contact', '/privacy', or any '/docs/...' page.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The page's path, e.g. '/docs/install'.",
        },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_latest_release",
    title: "Find the latest Volt download",
    description:
      "The newest Volt release on a channel (stable by default): version, date, release notes link and every download file for macOS, Windows and Linux.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          enum: [...CHANNELS],
          description: "stable, beta or nightly.",
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "get_changelog",
    title: "Read the changelog",
    description:
      "What changed in a Volt release, as Markdown. Without a version, the newest release.",
    inputSchema: {
      type: "object",
      properties: {
        version: { type: "string", description: "A version such as '0.0.3'." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const text = (value: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

async function callTool(
  name: unknown,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "search_docs": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return text("Give a query to search for.", true);
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
      const results = (await search.search(query)).slice(0, limit);
      if (!results.length)
        return text(
          `No docs match "${query}". The full list of pages is at ${absoluteUrl("/llms.txt")}.`,
        );
      return text(
        results
          .map(
            (r) =>
              `- [${r.content.replace(/<\/?mark>/g, "")}](${absoluteUrl(r.url)}) (${r.type}; Markdown: ${absoluteUrl(markdownPathFor(r.url.split("#")[0]))})`,
          )
          .join("\n"),
      );
    }
    case "get_page": {
      const path =
        typeof args.path === "string"
          ? args.path.replace(/^https?:\/\/[^/]+/, "").split(/[?#]/)[0]
          : "";
      const markdown = path ? await pageMarkdown(path) : undefined;
      return markdown
        ? text(markdown)
        : text(
            `There is no page at "${path}". See ${absoluteUrl("/sitemap.xml")} for every page.`,
            true,
          );
    }
    case "get_latest_release": {
      const channel = (CHANNELS as readonly string[]).includes(
        String(args.channel),
      )
        ? (args.channel as Channel)
        : "stable";
      const res = await fetch(RELEASES_API, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "getvolt.dev-mcp",
        },
      });
      if (!res.ok)
        return text(
          `GitHub answered ${res.status}. All releases: https://github.com/${gitConfig.user}/${gitConfig.repo}/releases`,
          true,
        );
      const release = pickChannelReleases(trimReleases(await res.json()))[
        channel
      ];
      if (!release) return text(`There is no ${channel} release yet.`, true);
      return text(
        [
          `# Volt ${release.version} (${channel})`,
          `Published ${release.publishedAt.slice(0, 10)}. Release notes: ${release.htmlUrl}`,
          "",
          ...release.assets.map(
            (a) =>
              `- ${a.os} ${a.arch} ${a.pkg}: [${a.name}](${a.url}) (${Math.round(a.size / 1e6)} MB)`,
          ),
        ].join("\n"),
      );
    }
    case "get_changelog": {
      const releases = parseChangelog(changelogMarkdown());
      const wanted =
        typeof args.version === "string"
          ? args.version.replace(/^v/, "")
          : releases[0]?.version;
      const all = changelogMarkdown();
      const start = all.indexOf(`## [${wanted}]`);
      if (start < 0)
        return text(
          `No changelog entry for ${wanted}. Versions: ${releases.map((r) => r.version).join(", ")}.`,
          true,
        );
      const next = all.indexOf("\n## [", start + 1);
      return text(all.slice(start, next < 0 ? undefined : next).trim());
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${String(name)}`), {
        code: -32602,
      });
  }
}

async function respond(message: JsonRpcMessage): Promise<unknown> {
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Read-only tools for getvolt.dev, the website of Volt (an open-source agentic development workspace). Search the docs, read any page as Markdown, find the latest download, and read the changelog.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(
        params.name,
        (params.arguments as Record<string, unknown>) ?? {},
      );
    default:
      throw Object.assign(new Error(`Method not found: ${message.method}`), {
        code: -32601,
      });
  }
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

const rpcError = (id: JsonRpcMessage["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

async function handlePost(request: Request): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_ORIGIN.test(origin)) {
    return json(rpcError(null, -32000, "Origin not allowed"), 403);
  }
  const version = request.headers.get("MCP-Protocol-Version");
  if (version && !PROTOCOL_VERSIONS.includes(version)) {
    return json(
      rpcError(null, -32000, `Unsupported MCP-Protocol-Version: ${version}`),
      400,
    );
  }
  let message: JsonRpcMessage;
  try {
    message = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    message.jsonrpc !== "2.0"
  ) {
    return json(
      rpcError(null, -32600, "Invalid request: send one JSON-RPC 2.0 message"),
      400,
    );
  }
  // Notifications and responses from the client: accepted, nothing to send back.
  if (message.id === undefined || message.method === undefined) {
    return new Response(null, { status: 202 });
  }
  try {
    return json({
      jsonrpc: "2.0",
      id: message.id,
      result: await respond(message),
    });
  } catch (error) {
    const err = error as { code?: number; message?: string };
    return json(
      rpcError(message.id, err.code ?? -32603, err.message ?? "Internal error"),
    );
  }
}

const notAllowed = () =>
  new Response("This MCP server answers POST only (no SSE stream).", {
    status: 405,
    headers: { Allow: "POST" },
  });

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      POST: ({ request }) => handlePost(request),
      GET: notAllowed,
      DELETE: notAllowed,
    },
  },
});
