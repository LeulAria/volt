import { createFileRoute } from "@tanstack/react-router";
import { markdownResponse, pageMarkdown } from "@/lib/agentMarkdown";

/** /privacy as Markdown, for agents (also what `Accept: text/markdown` on /privacy returns). */
export const Route = createFileRoute("/privacy.md")({
  server: {
    handlers: {
      GET: async () => markdownResponse((await pageMarkdown("/privacy")) ?? ""),
    },
  },
});
