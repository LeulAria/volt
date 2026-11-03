import { createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "@/lib/seo";

/** The site's public HTTP API, as OpenAPI 3.1 (linked from every page with rel="service-desc"). */
const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "getvolt.dev",
    version: "1.0.0",
    summary:
      "Read-only access to the Volt website for agents: pages as Markdown, the docs index and an MCP server.",
    description:
      "Every page of getvolt.dev is also available as Markdown, at its .md address or by sending `Accept: text/markdown`. The MCP server at /api/mcp offers the same content as tools (search_docs, get_page, get_latest_release, get_changelog). Releases themselves are published on GitHub.",
    license: { name: "MIT", identifier: "MIT" },
  },
  servers: [{ url: siteUrl }],
  paths: {
    "/api/mcp": {
      post: {
        operationId: "mcp",
        summary: "MCP server (Streamable HTTP, stateless JSON responses)",
        description:
          "Send one JSON-RPC 2.0 message per request: initialize, tools/list, tools/call or ping. Notifications get 202 Accepted. Protocol versions 2025-11-25, 2025-06-18 and 2025-03-26.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["jsonrpc", "method"],
                properties: {
                  jsonrpc: { const: "2.0" },
                  id: { type: ["string", "integer"] },
                  method: { type: "string", examples: ["tools/list"] },
                  params: { type: "object" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The JSON-RPC response.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "202": { description: "A notification was accepted." },
          "400": {
            description:
              "Not a single JSON-RPC 2.0 message, or an unsupported MCP-Protocol-Version.",
          },
          "403": {
            description:
              "The request came from a browser on another site (Origin not allowed).",
          },
        },
      },
    },
    "/{page}.md": {
      get: {
        operationId: "getPageMarkdown",
        summary: "A page of the site as Markdown",
        parameters: [
          {
            name: "page",
            in: "path",
            required: true,
            schema: {
              type: "string",
              enum: [
                "index",
                "download",
                "changelog",
                "about",
                "contact",
                "privacy",
              ],
            },
          },
        ],
        responses: {
          "200": {
            description: "The page as Markdown.",
            content: { "text/markdown": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/llms.mdx/docs/{slug}/content.md": {
      get: {
        operationId: "getDocsPageMarkdown",
        summary: "A docs page as Markdown",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string", examples: ["install"] },
          },
        ],
        responses: {
          "200": {
            description: "The docs page as Markdown.",
            content: { "text/markdown": { schema: { type: "string" } } },
          },
          "404": {
            description: "No such docs page.",
            content: { "text/markdown": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/llms.txt": {
      get: {
        operationId: "getLlmsTxt",
        summary: "The docs index for language models (llms.txt)",
        responses: {
          "200": {
            description: "Markdown links to every docs page.",
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/llms-full.txt": {
      get: {
        operationId: "getLlmsFullTxt",
        summary: "Every docs page in one Markdown file",
        responses: {
          "200": {
            description: "All docs pages.",
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/sitemap.xml": {
      get: {
        operationId: "getSitemap",
        summary: "Every public page with its last-modified date",
        responses: {
          "200": {
            description: "A sitemap.",
            content: { "application/xml": { schema: { type: "string" } } },
          },
        },
      },
    },
  },
};

export const Route = createFileRoute("/openapi.json")({
  server: {
    handlers: {
      GET: () =>
        new Response(JSON.stringify(OPENAPI, null, 2), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
    },
  },
});
