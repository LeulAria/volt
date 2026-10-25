import { createFileRoute } from "@tanstack/react-router";
import { markdownResponse, pageMarkdown } from "@/lib/agentMarkdown";

/** /download as Markdown, for agents (also what `Accept: text/markdown` on /download returns). */
export const Route = createFileRoute("/download.md")({
  server: {
    handlers: {
      GET: async () =>
        markdownResponse((await pageMarkdown("/download")) ?? ""),
    },
  },
});
