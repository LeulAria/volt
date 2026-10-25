import { createFileRoute } from "@tanstack/react-router";
import { markdownResponse, pageMarkdown } from "@/lib/agentMarkdown";

/** / as Markdown, for agents (also what `Accept: text/markdown` on / returns). */
export const Route = createFileRoute("/index.md")({
  server: {
    handlers: {
      GET: async () => markdownResponse((await pageMarkdown("/")) ?? ""),
    },
  },
});
