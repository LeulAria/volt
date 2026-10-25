import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";

const SILENT_WARNINGS = new Set([
  "MODULE_LEVEL_DIRECTIVE",
  // Nitro's defaults
  "EVAL",
  "CIRCULAR_DEPENDENCY",
  "THIS_IS_UNDEFINED",
  "EMPTY_BUNDLE",
]);

/**
 * `virtual:changelog`: the repository's CHANGELOG.md as a string, for /changelog. A plain
 * `?raw` import would go through the MDX plugin, which claims every .md file.
 */
function changelogSource(): Plugin {
  const id = "virtual:changelog";
  const file = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));
  return {
    name: "volt-changelog",
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return undefined;
      this.addWatchFile(file);
      return `export default ${JSON.stringify(readFileSync(file, "utf8"))};`;
    },
  };
}

/**
 * `Accept: text/markdown` on a page serves its Markdown file (an agent asking for `/` gets
 * `/index.md`). Unknown pages fall through to the server, whose middleware (src/start.ts) answers a
 * Markdown 404. Every page varies by Accept, so caches keep the HTML and Markdown apart.
 */
const WANTS_MARKDOWN = [
  { type: "header" as const, key: "accept", value: ".*text/markdown.*" },
];
const MARKDOWN_ROUTES = [
  { src: "^/$", has: WANTS_MARKDOWN, dest: "/index.md" },
  {
    src: "^/(download|changelog|about|contact|privacy)/?$",
    has: WANTS_MARKDOWN,
    dest: "/$1.md",
  },
  { src: "^/docs/?$", has: WANTS_MARKDOWN, dest: "/llms.mdx/docs/content.md" },
  {
    src: "^/docs/(.+?)/?$",
    has: WANTS_MARKDOWN,
    dest: "/llms.mdx/docs/$1/content.md",
  },
  {
    src: "^/(?!api/|assets/|_)[^.]*$",
    headers: { Vary: "Accept" },
    continue: true,
  },
];

export default defineConfig({
  server: {
    port: 3000,
  },
  plugins: [
    changelogSource(),
    mdx(await import("./source.config")),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
        prerender: {
          enabled: true,
          crawlLinks: true,
        },
      },

      pages: [
        {
          path: "/docs",
        },
        {
          path: "/download",
        },
        {
          path: "/changelog",
        },
        {
          path: "/api/search",
        },
        {
          path: "llms-full.txt",
        },
        {
          path: "llms.txt",
        },
        { path: "/about" },
        { path: "/contact" },
        { path: "/privacy" },
        // Markdown versions of the site's pages, for agents (src/lib/agentMarkdown.ts)
        { path: "/index.md" },
        { path: "/download.md" },
        { path: "/changelog.md" },
        { path: "/about.md" },
        { path: "/contact.md" },
        { path: "/privacy.md" },
        { path: "/sitemap.xml" },
        { path: "/openapi.json" },
      ],
    }),
    react(),
    // please see https://tanstack.com/start/latest/docs/framework/react/guide/hosting#nitro for guides on hosting
    // Bundle tslib. Node resolves its "import" condition to modules/index.js, which Nitro's
    // tracer does not copy, so prerender crashes with ERR_MODULE_NOT_FOUND.
    nitro({
      noExternals: ["tslib"],
      // Vercel serves prerendered pages before any function runs, so content negotiation happens in its
      // router: these routes come before Nitro's own (defu puts them first) and its filesystem phase.
      vercel: { config: { version: 3, routes: MARKDOWN_ROUTES } },
      rolldownConfig: {
        // The server bundle pulls in framer-motion, Radix, and next-themes, which all start with
        // `"use client"`. That directive means nothing on the server, so rolldown's notice about
        // dropping it is noise. This replaces Nitro's handler, so its own ignore list is kept.
        onwarn(warning, warn) {
          if (SILENT_WARNINGS.has(warning.code ?? "")) return;
          warn(warning);
        },
      },
    }),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: {
      tslib: "tslib/tslib.es6.js",
    },
  },
});
