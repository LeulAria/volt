import { createFileRoute } from "@tanstack/react-router";
import { markdownResponse, pageMarkdown } from "@/lib/agentMarkdown";

/** /about as Markdown, for agents (also what `Accept: text/markdown` on /about returns). */
export const Route = createFileRoute("/about.md")({
  server: {
    handlers: {
      GET: async () => markdownResponse((await pageMarkdown("/about")) ?? ""),
    },
  },
});
