import { createFileRoute } from "@tanstack/react-router";
import { InfoPageView } from "@/components/infoPage";
import { sitePageLinks, sitePageMeta } from "@/lib/seo";
import { CONTACT_PAGE } from "@/lib/sitePages";

export const Route = createFileRoute("/contact")({
  component: () => <InfoPageView page={CONTACT_PAGE} />,
  head: () => ({
    // TanStack Router supports `script:ld+json` in meta; types are narrower than runtime.
    meta: sitePageMeta({
      title: CONTACT_PAGE.eyebrow,
      description: CONTACT_PAGE.description,
      path: CONTACT_PAGE.path,
      organization: CONTACT_PAGE.path !== "/privacy",
    }) as Array<Record<string, unknown> & { title?: string }>,
    links: sitePageLinks(CONTACT_PAGE.path),
  }),
});
