import { parseInline, resolveChangelogHref } from "@/lib/changelog";
import { gitConfig } from "@/lib/shared";

const REPO_URL = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/**
 * Inline Markdown (bold, italics, code, links) as React, for text kept as Markdown so it also reads
 * well at the page's .md address. Relative links point at the repository; site links (/download) stay.
 */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((token, index) => {
        const key = `${index}-${token.text}`;
        switch (token.kind) {
          case "strong":
            return (
              <strong key={key} className="font-semibold text-white/90">
                {token.text}
              </strong>
            );
          case "em":
            return (
              <em key={key} className="text-white/80">
                {token.text}
              </em>
            );
          case "code":
            return (
              <code
                key={key}
                className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.86em] text-white/80"
              >
                {token.text}
              </code>
            );
          case "link":
            return (
              <a
                key={key}
                href={resolveChangelogHref(token.href, REPO_URL)}
                {...(token.href.startsWith("/")
                  ? {}
                  : { target: "_blank", rel: "noreferrer" })}
                className="text-white/85 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white hover:decoration-white/70"
              >
                {token.text}
              </a>
            );
          default:
            return <span key={key}>{token.text}</span>;
        }
      })}
    </>
  );
}
