import changelogSource from "virtual:changelog";
import { createFileRoute } from "@tanstack/react-router";
import { parseChangelog } from "@/lib/changelog";
import { absoluteUrl } from "@/lib/seo";
import { DONORS_PAGE, INFO_PAGES } from "@/lib/sitePages";
import { source } from "@/lib/source";

/**
 * Every public page with a lastmod date. Prerendered at build time, so pages without a date of their
 * own (the landing, download and docs pages) carry the build's date; About, Contact and Privacy carry
 * the date their text last changed, and the changelog its newest release.
 */
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () => {
        const built = new Date().toISOString().slice(0, 10);
        const newestRelease = parseChangelog(changelogSource)[0]?.date || built;
        const entries: { path: string; lastmod: string; priority: string }[] = [
          { path: "/", lastmod: built, priority: "1.0" },
          { path: "/download", lastmod: built, priority: "0.9" },
          { path: "/changelog", lastmod: newestRelease, priority: "0.8" },
          ...INFO_PAGES.map((page) => ({
            path: page.path,
            lastmod: page.updated,
            priority: "0.5",
          })),
          {
            path: DONORS_PAGE.path,
            lastmod: DONORS_PAGE.updated,
            priority: "0.5",
          },
          ...source.getPages().map((page) => ({
            path: page.url,
            lastmod: built,
            priority: "0.7",
          })),
        ];
        const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (e) => `  <url>
    <loc>${absoluteUrl(e.path)}</loc>
    <lastmod>${e.lastmod}</lastmod>
    <priority>${e.priority}</priority>
  </url>`,
  )
  .join("\n")}
</urlset>
`;
        return new Response(body, {
          headers: { "Content-Type": "application/xml; charset=utf-8" },
        });
      },
    },
  },
});
