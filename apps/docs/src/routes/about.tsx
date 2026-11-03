import { createFileRoute } from "@tanstack/react-router";
import { InfoPageView } from "@/components/infoPage";
import { sitePageLinks, sitePageMeta } from "@/lib/seo";
import { ABOUT_PAGE } from "@/lib/sitePages";

export const Route = createFileRoute("/about")({
  component: () => <InfoPageView page={ABOUT_PAGE} />,
  head: () => ({
    // TanStack Router supports `script:ld+json` in meta; types are narrower than runtime.
    meta: sitePageMeta({
      title: ABOUT_PAGE.eyebrow,
      description: ABOUT_PAGE.description,
      path: ABOUT_PAGE.path,
      organization: ABOUT_PAGE.path !== "/privacy",
    }) as Array<Record<string, unknown> & { title?: string }>,
    links: sitePageLinks(ABOUT_PAGE.path),
  }),
});
