import { createFileRoute } from "@tanstack/react-router";
import { markdownResponse, pageMarkdown } from "@/lib/agentMarkdown";

/** /changelog as Markdown, for agents (also what `Accept: text/markdown` on /changelog returns). */
export const Route = createFileRoute("/changelog.md")({
  server: {
    handlers: {
      GET: async () =>
        markdownResponse((await pageMarkdown("/changelog")) ?? ""),
    },
  },
});
