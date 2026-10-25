import { createMiddleware, createStart } from "@tanstack/react-start";

/** Files and APIs answer for themselves, whatever the Accept header. */
const NOT_A_PAGE = /^\/(api\/|assets\/|_|llms|og\/)|\.[a-z0-9]+$/i;

/**
 * A request that prefers Markdown (`Accept: text/markdown`) gets the page as Markdown, and an unknown
 * page a 404 with a short Markdown note on where to look next. On Vercel, known pages are rewritten to
 * their .md files before they reach this (vite.config.ts); this covers the rest and local servers.
 */
const markdownForAgents = createMiddleware().server(
  async ({ request, next }) => {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    const pathname = new URL(request.url).pathname;
    if (NOT_A_PAGE.test(pathname)) return next();
    const {
      markdownResponse,
      notFoundMarkdown,
      pageMarkdown,
      prefersMarkdown,
    } = await import("./lib/agentMarkdown");
    if (!prefersMarkdown(request.headers.get("Accept"))) return next();
    const markdown = await pageMarkdown(pathname);
    return markdown
      ? markdownResponse(markdown)
      : markdownResponse(notFoundMarkdown(pathname), 404);
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [markdownForAgents],
}));
