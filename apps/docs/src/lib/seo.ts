import { appName, docsContentRoute, docsRoute, gitConfig } from "./shared";
import { SITE_DISCORD_URL as DISCORD_URL } from "./sitePages";

/** Canonical site origin (og:image, canonical links, sitemap). `VITE_SITE_URL` overrides it. */
export const siteUrl =
  (typeof import.meta !== "undefined" &&
    import.meta.env?.VITE_SITE_URL?.replace(/\/$/, "")) ||
  "https://getvolt.dev";

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
  defaultOgImagePath: "/og-volt-ipad.jpg",
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
    { property: "og:image:width", content: "868" },
    { property: "og:image:height", content: "868" },
    { name: "twitter:image", content: absoluteUrl(seo.defaultOgImagePath) },
    { name: "application-name", content: appName },
  ];
}

/** Reserved for global link tags; canonical URLs are set per-route (home, docs) so `/docs/*` is not wrong. */
export function rootHeadLinks(): Array<{
  rel: string;
  href: string;
  type?: string;
  sizes?: string;
}> {
  return [
    { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32.png" },
    { rel: "icon", type: "image/png", sizes: "64x64", href: "/favicon-64.png" },
    {
      rel: "apple-touch-icon",
      sizes: "180x180",
      href: "/apple-touch-icon.png",
    },
  ];
}

const ORGANIZATION_ID = `${siteUrl}/#organization`;
const REPO_URL = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/**
 * Where the organization is, for schema.org's PostalAddress. Left empty until the maintainers publish
 * one; the Organization below includes it only when it is set.
 */
const ORGANIZATION_ADDRESS:
  | {
      streetAddress?: string;
      addressLocality?: string;
      addressRegion?: string;
      postalCode?: string;
      addressCountry: string;
    }
  | undefined = undefined;

/** JSON-LD: Organization, who runs the site and how to reach them (the Contact page's channels). */
export function jsonLdOrganization() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: appName,
    legalName: "Volt ADK",
    url: siteUrl,
    logo: absoluteUrl("/volt-icon-256.png"),
    description: seo.homeDescription,
    sameAs: [REPO_URL, DISCORD_URL],
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer support",
        url: `${REPO_URL}/issues/new/choose`,
        availableLanguage: ["English"],
      },
      {
        "@type": "ContactPoint",
        contactType: "technical support",
        url: DISCORD_URL,
        availableLanguage: ["English"],
      },
      {
        "@type": "ContactPoint",
        contactType: "security",
        url: `${REPO_URL}/security/advisories/new`,
        availableLanguage: ["English"],
      },
    ],
    ...(ORGANIZATION_ADDRESS
      ? { address: { "@type": "PostalAddress", ...ORGANIZATION_ADDRESS } }
      : {}),
  };
}

/** JSON-LD: WebSite (root). */
export function jsonLdWebSite() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: appName,
    url: siteUrl,
    description: seo.homeDescription,
    publisher: { "@id": ORGANIZATION_ID },
  };
}

type HeadMeta = Array<
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string }
  | { "script:ld+json": Record<string, unknown> }
>;
type HeadLink = { rel: string; href: string; type?: string; title?: string };

/** `<link rel="alternate" type="text/markdown">`: the page as Markdown, for agents. */
export function markdownAlternate(href: string): HeadLink {
  return { rel: "alternate", type: "text/markdown", href, title: "Markdown" };
}

/** Meta for the site's plain pages (About, Contact, Privacy). */
export function sitePageMeta(opts: {
  title: string;
  description: string;
  path: string;
  organization?: boolean;
}): HeadMeta {
  const title = `${opts.title} — ${appName}`;
  const url = absoluteUrl(opts.path);
  return [
    { title },
    { name: "description", content: opts.description },
    { property: "og:title", content: title },
    { property: "og:description", content: opts.description },
    { property: "og:url", content: url },
    { property: "og:image", content: absoluteUrl(seo.defaultOgImagePath) },
    { property: "og:type", content: "website" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: opts.description },
    ...(opts.organization ? [{ "script:ld+json": jsonLdOrganization() }] : []),
  ];
}

export function sitePageLinks(path: string): HeadLink[] {
  return [
    { rel: "canonical", href: absoluteUrl(path) },
    markdownAlternate(`${path}.md`),
  ];
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
    downloadUrl: absoluteUrl("/download"),
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
    { property: "og:image:width", content: "868" },
    { property: "og:image:height", content: "868" },
    { property: "og:type", content: "website" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: desc },
    { name: "twitter:image", content: absoluteUrl(seo.defaultOgImagePath) },
    { "script:ld+json": jsonLdOrganization() },
    { "script:ld+json": jsonLdWebSite() },
    { "script:ld+json": jsonLdSoftwareApplication() },
  ];
}

export function homeRouteLinks(): HeadLink[] {
  return [{ rel: "canonical", href: siteUrl }, markdownAlternate("/index.md")];
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
    { property: "og:image:width", content: "868" },
    { property: "og:image:height", content: "868" },
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
        publisher: {
          "@type": "Organization",
          "@id": ORGANIZATION_ID,
          name: appName,
          url: siteUrl,
        },
      },
    },
  ];
}

export function docsPageLinks(slugPath: string): HeadLink[] {
  // /docs/install → /llms.mdx/docs/install/content.md (the llms.mdx route), /docs → /llms.mdx/docs/content.md
  const markdown = `${docsContentRoute}${slugPath.slice(docsRoute.length)}/content.md`;
  return [
    { rel: "canonical", href: absoluteUrl(slugPath) },
    markdownAlternate(markdown),
  ];
}

/** Meta entries for `/download`. */
export function downloadRouteMeta(): Array<
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string }
> {
  const title = `Download ${appName} — macOS, Windows & Linux`;
  const desc =
    "Download Volt for macOS (Apple Silicon and Intel), Windows, and Linux. Stable, Beta, and Nightly builds install side by side.";
  const url = absoluteUrl("/download");
  return [
    { title },
    { name: "description", content: desc },
    { property: "og:title", content: title },
    { property: "og:description", content: desc },
    { property: "og:url", content: url },
    { property: "og:image", content: absoluteUrl(seo.defaultOgImagePath) },
    { property: "og:image:width", content: "868" },
    { property: "og:image:height", content: "868" },
    { property: "og:type", content: "website" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: desc },
  ];
}

export function downloadRouteLinks(): HeadLink[] {
  return sitePageLinks("/download");
}

/** Meta entries for `/changelog`. */
export function changelogRouteMeta(): Array<
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string }
> {
  const title = `Changelog — ${appName}`;
  const desc =
    "What changed in each Volt release: new features, changes, and fixes, newest first.";
  const url = absoluteUrl("/changelog");
  return [
    { title },
    { name: "description", content: desc },
    { property: "og:title", content: title },
    { property: "og:description", content: desc },
    { property: "og:url", content: url },
    { property: "og:image", content: absoluteUrl(seo.defaultOgImagePath) },
    { property: "og:image:width", content: "868" },
    { property: "og:image:height", content: "868" },
    { property: "og:type", content: "website" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: desc },
  ];
}

export function changelogRouteLinks(): HeadLink[] {
  return sitePageLinks("/changelog");
}
