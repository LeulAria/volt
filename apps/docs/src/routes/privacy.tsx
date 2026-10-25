import { createFileRoute } from "@tanstack/react-router";
import { InfoPageView } from "@/components/infoPage";
import { sitePageLinks, sitePageMeta } from "@/lib/seo";
import { PRIVACY_PAGE } from "@/lib/sitePages";

export const Route = createFileRoute("/privacy")({
  component: () => <InfoPageView page={PRIVACY_PAGE} />,
  head: () => ({
    // TanStack Router supports `script:ld+json` in meta; types are narrower than runtime.
    meta: sitePageMeta({
      title: PRIVACY_PAGE.eyebrow,
      description: PRIVACY_PAGE.description,
      path: PRIVACY_PAGE.path,
      organization: PRIVACY_PAGE.path !== "/privacy",
    }) as Array<Record<string, unknown> & { title?: string }>,
    links: sitePageLinks(PRIVACY_PAGE.path),
  }),
});
