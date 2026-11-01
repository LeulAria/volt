import { createFileRoute } from "@tanstack/react-router";
import { markdownResponse, pageMarkdown } from "@/lib/agentMarkdown";

/** /donors as Markdown, for agents (also what `Accept: text/markdown` on /donors returns). */
export const Route = createFileRoute("/donors.md")({
  server: {
    handlers: {
      GET: async () => markdownResponse((await pageMarkdown("/donors")) ?? ""),
    },
  },
});
