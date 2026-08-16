import { appName, docsRoute, gitConfig } from "./shared";

/** Canonical site origin. Set `VITE_SITE_URL` in production (e.g. https://voltleularia.com). */
export const siteUrl =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_SITE_URL?.replace(/\/$/, "")) ||
  "https://volt.leularia.com";

export const seo = {
  /** Primary brand + positioning (≤60 chars ideal for titles) */
  brandTitle: "Volt — The agentic development workspace",
  /** Homepage / default meta description (≈150–160 chars for SERP; longer OK for og:) */
  homeDescription:
    "Volt is the agentic development workspace: editor, Git, terminal, and AI coding agents in one fast surface. Ship with agents—not tab sprawl. Public beta; macOS, Windows & Linux downloads.",
  /** Default when a docs page omits description */
  docsFallbackDescription:
    "Documentation for Volt — the native agentic IDE for developers. Workspace, canvas, terminals, Git, and AI agents in one place.",
  keywords: [
    "Volt",
    "Volt IDE",
    "agentic IDE",
    "AI coding agents",
    "AI developer workspace",
    "agentic development",
    "coding workspace",
    "Git client",
    "terminal IDE",
    "Electron IDE",
    "React IDE",
    "developer tools",
    "AI pair programming",
    "local-first IDE",
    "desktop IDE",
  ].join(", "),
  /** Social / OG image (path under `public/`) */
  defaultOgImagePath: "/hero-ide.png",
} as const;

export function absoluteUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${siteUrl}${p}`;
}

export function docsPagePath(slugs: string[]): string {
  if (slugs.length === 0) return docsRoute;
  return `${docsRoute}/${slugs.join("/")}`;
}

/** Root layout: baseline tags; child routes add page-specific title/description/canonical. */
export function rootHeadMeta(): Array<
  | { charSet: "utf-8" }
  | { name: string; content: string }
  | { property: string; content: string }
  | { title: string }
> {
  return [
    { charSet: "utf-8" },
    { name: "viewport", content: "width=device-width, initial-scale=1" },
    { title: seo.brandTitle },
    { name: "description", content: seo.homeDescription },
    { name: "keywords", content: seo.keywords },
    { name: "author", content: appName },
    { name: "robots", content: "index, follow" },
    { name: "theme-color", content: "#000000" },
    { property: "og:site_name", content: appName },
    { property: "og:type", content: "website" },
    { property: "og:locale", content: "en_US" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: seo.brandTitle },
    { name: "twitter:description", content: seo.homeDescription },
    { property: "og:title", content: seo.brandTitle },
    { property: "og:description", content: seo.homeDescription },
    { property: "og:image", content: absoluteUrl(seo.defaultOgImagePath) },
    { name: "twitter:image", content: absoluteUrl(seo.defaultOgImagePath) },
    { name: "application-name", content: appName },
  ];
}

/** Reserved for global link tags; canonical URLs are set per-route (home, docs) so `/docs/*` is not wrong. */
export function rootHeadLinks(): Array<{ rel: string; href: string }> {
  return [];
}

/** JSON-LD: WebSite (root). */
export function jsonLdWebSite() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: appName,
    url: siteUrl,
    description: seo.homeDescription,
    publisher: {
      "@type": "Organization",
      name: appName,
      url: siteUrl,
    },
  };
}

/** JSON-LD: SoftwareApplication (product). */
export function jsonLdSoftwareApplication() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: appName,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Windows, Linux",
    description: seo.homeDescription,
    url: siteUrl,
    downloadUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}/releases/latest`,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };
}

/** Meta entries for the marketing homepage (`/`). */
export function homeRouteMeta(): Array<
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string }
  | { "script:ld+json": Record<string, unknown> }
> {
  const title = "Volt — Code with AI agents that actually ship";
  const desc = seo.homeDescription;

  return [
    { title },
    { name: "description", content: desc },
    { name: "keywords", content: seo.keywords },
    { property: "og:title", content: title },
    { property: "og:description", content: desc },
    { property: "og:url", content: siteUrl },
    { property: "og:image", content: absoluteUrl(seo.defaultOgImagePath) },
    { property: "og:type", content: "website" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: desc },
    { name: "twitter:image", content: absoluteUrl(seo.defaultOgImagePath) },
    { "script:ld+json": jsonLdWebSite() },
    { "script:ld+json": jsonLdSoftwareApplication() },
  ];
}

export function homeRouteLinks(): Array<{ rel: string; href: string }> {
  return [{ rel: "canonical", href: siteUrl }];
}

export function docsPageMeta(opts: {
  pageTitle: string;
  pageDescription: string;
  slugPath: string;
}): Array<
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string }
  | { "script:ld+json": Record<string, unknown> }
> {
  const title = `${opts.pageTitle} · ${appName} Docs`;
  const desc = opts.pageDescription || seo.docsFallbackDescription;
  const url = absoluteUrl(opts.slugPath);

  return [
    { title },
    { name: "description", content: desc },
    { name: "keywords", content: seo.keywords },
    { property: "og:title", content: title },
    { property: "og:description", content: desc },
    { property: "og:url", content: url },
    { property: "og:type", content: "article" },
    { property: "og:image", content: absoluteUrl(seo.defaultOgImagePath) },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: desc },
    {
      "script:ld+json": {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: opts.pageTitle,
        description: desc,
        url,
        author: { "@type": "Organization", name: appName },
        publisher: { "@type": "Organization", name: appName, url: siteUrl },
      },
    },
  ];
}

export function docsPageLinks(slugPath: string): Array<{ rel: string; href: string }> {
  return [{ rel: "canonical", href: absoluteUrl(slugPath) }];
}
