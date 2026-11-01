/**
 * Markdown for agents (server only: it reads the docs collection). Every public page has a Markdown
 * version: the site's own pages at /<page>.md, docs pages at /llms.mdx/docs/<page>/content.md, and
 * any of them with `Accept: text/markdown` (vercel routes in vite.config.ts and the request
 * middleware in start.ts). Unknown pages answer 404 with a short Markdown note.
 */

import changelogSource from "virtual:changelog";
import { resolveChangelogHref } from "./changelog";
import {
  donorsMarkdown,
  downloadMarkdown,
  homeMarkdown,
  INFO_PAGES,
  infoPageMarkdown,
  SITE_REPO_URL,
} from "./sitePages";
import { getLLMText, source } from "./source";

export { notFoundMarkdown } from "./sitePages";

/** The site's pages with a Markdown file of their own (prerendered as /<name>.md). */
export const MARKDOWN_PAGES = [
  "/",
  "/download",
  "/changelog",
  "/about",
  "/contact",
  "/privacy",
  "/donors",
] as const;

/** Where a page's Markdown lives: /index.md, /download.md, or the docs' content.md. */
export function markdownPathFor(pathname: string): string {
  const path = normalizePath(pathname);
  if (path === "/") return "/index.md";
  if (path === "/docs" || path.startsWith("/docs/")) {
    return `/llms.mdx${path}/content.md`;
  }
  return `${path}.md`;
}

export function changelogMarkdown(): string {
  // Relative links in CHANGELOG.md point into the repository.
  return changelogSource.replace(
    /\]\(([^)\s]+)\)/g,
    (_, href: string) => `](${resolveChangelogHref(href, SITE_REPO_URL)})`,
  );
}

/** A page's Markdown, or undefined when there is no such page. */
export async function pageMarkdown(
  pathname: string,
): Promise<string | undefined> {
  const path = normalizePath(pathname);
  switch (path) {
    case "/":
      return homeMarkdown();
    case "/download":
      return downloadMarkdown();
    case "/changelog":
      return changelogMarkdown();
    case "/donors":
      return donorsMarkdown();
  }
  const info = INFO_PAGES.find((page) => page.path === path);
  if (info) return infoPageMarkdown(info);
  if (path === "/docs" || path.startsWith("/docs/")) {
    const slugs = path.slice("/docs".length).split("/").filter(Boolean);
    const page = source.getPage(slugs);
    return page ? getLLMText(page) : undefined;
  }
  return undefined;
}

export function markdownResponse(markdown: string, status = 200): Response {
  return new Response(markdown, {
    status,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
    },
  });
}

/** True when the request prefers Markdown to HTML (by the Accept header's order and q-values). */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let markdown = -1;
  let html = -1;
  for (const part of accept.split(",")) {
    const [type, ...params] = part.trim().toLowerCase().split(";");
    const q = Number(
      params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2) ?? 1,
    );
    if (type === "text/markdown" || type === "text/x-markdown")
      markdown = Math.max(markdown, q);
    if (type === "text/html") html = Math.max(html, q);
  }
  return markdown > 0 && markdown >= html;
}

function normalizePath(pathname: string): string {
  const path = pathname.replace(/\/+$/, "");
  return path === "" ? "/" : path;
}
