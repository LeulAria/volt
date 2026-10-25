import { createFileRoute } from "@tanstack/react-router";
import { markdownResponse, pageMarkdown } from "@/lib/agentMarkdown";

/** /contact as Markdown, for agents (also what `Accept: text/markdown` on /contact returns). */
export const Route = createFileRoute("/contact.md")({
  server: {
    handlers: {
      GET: async () => markdownResponse((await pageMarkdown("/contact")) ?? ""),
    },
  },
});
