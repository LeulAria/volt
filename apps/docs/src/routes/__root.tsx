import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { Analytics } from "@vercel/analytics/react";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import SearchDialog from "@/components/search";
import { rootHeadLinks, rootHeadMeta } from "@/lib/seo";
import appCss from "@/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [...rootHeadMeta()],
    links: [
      ...rootHeadLinks(),
      // The site's public API for agents (MCP, Markdown pages, llms.txt).
      {
        rel: "service-desc",
        type: "application/openapi+json",
        href: "/openapi.json",
      },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex flex-col min-h-screen">
        <RootProvider search={{ SearchDialog }}>
          <Outlet />
        </RootProvider>
        {/* Vercel Web Analytics (the React entry: this is TanStack Start, not Next.js) */}
        <Analytics />
        <Scripts />
      </body>
    </html>
  );
}
