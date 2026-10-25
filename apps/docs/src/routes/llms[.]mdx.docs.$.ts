import { createFileRoute } from "@tanstack/react-router";
import { markdownResponse, notFoundMarkdown } from "@/lib/agentMarkdown";
import { getLLMText, source } from "@/lib/source";

export const Route = createFileRoute("/llms.mdx/docs/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const slugs = (params._splat ?? "").split("/");
        // remove the appended "content.md"
        slugs.pop();
        const page = source.getPage(slugs);
        // A 404 that still reads as Markdown: agents asking for a docs page that isn't there get pointers.
        if (!page) {
          return markdownResponse(
            notFoundMarkdown(`/docs/${slugs.join("/")}`),
            404,
          );
        }

        return markdownResponse(await getLLMText(page));
      },
    },
  },
});
