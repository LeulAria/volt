import { Link } from "@tanstack/react-router";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  Info,
  Menu,
  ScrollText,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { gitConfig } from "@/lib/shared";
import { formatStars } from "@/lib/useGithubStars";
import { useHydrated } from "@/lib/useHydrated";
import { DISCORD_URL, DiscordIcon, focusRing, GithubMarkIcon } from "./install";

/** Below md, where the header drops its text links. */
const NARROW = "(max-width: 767.98px)";

const ROW = `group flex items-center gap-3 rounded-[12px] px-2.5 py-2 transition-colors duration-150 hover:bg-white/[0.05] active:bg-white/[0.07] ${focusRing}`;

/**
 * The header's menu on narrow screens: a button that drops a sheet from the top with the pages the
 * header hides (Download, Changelog, Install guide, About) and the community links, each led by an icon.
 */
export function SiteMenu({
  hero,
  version,
  stars,
}: {
  /** The header's opening-sequence mark (`data-hero`), when it has one. */
  hero: { "data-hero"?: string };
  version: string | undefined;
  stars: number | null;
}) {
  const [open, setOpen] = useState(false);
  const hydrated = useHydrated();
  const sheetId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const close = () => setOpen(false);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      closeRef.current?.focus({ preventScroll: true });
      const root = document.documentElement;
      const overflow = root.style.overflow;
      root.style.overflow = "hidden";
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setOpen(false);
      };
      const narrow = window.matchMedia(NARROW);
      const onWide = () => {
        if (!narrow.matches) setOpen(false);
      };
      document.addEventListener("keydown", onKey);
      narrow.addEventListener("change", onWide);
      return () => {
        root.style.overflow = overflow;
        document.removeEventListener("keydown", onKey);
        narrow.removeEventListener("change", onWide);
      };
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      buttonRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  return (
    <>
      <button
        {...hero}
        ref={buttonRef}
        type="button"
        aria-label="Menu"
        aria-expanded={open}
        aria-controls={sheetId}
        onClick={() => setOpen((value) => !value)}
        className={`inline-grid size-6 place-items-center rounded-full border border-white/15 bg-white/[0.06] text-white/75 backdrop-blur-xl transition-colors duration-150 hover:border-white/25 hover:bg-white/10 hover:text-white md:hidden ${focusRing}`}
      >
        <Menu className="size-3.5" />
      </button>
      {hydrated
        ? createPortal(
            <div
              className={cn(
                "fixed inset-0 z-[100] md:hidden",
                !open && "pointer-events-none",
              )}
              inert={!open}
            >
              <div
                aria-hidden
                onClick={close}
                className={cn(
                  "absolute inset-0 bg-black/60 transition-opacity duration-300",
                  open ? "opacity-100" : "opacity-0",
                )}
              />
              <div
                id={sheetId}
                role="dialog"
                aria-modal="true"
                aria-label="Menu"
                className={cn(
                  "absolute inset-x-0 top-0 max-h-dvh overflow-y-auto overscroll-contain rounded-b-[22px] border-b border-white/10 bg-[#0d1110] font-sans text-white antialiased shadow-[0_28px_70px_rgba(0,0,0,0.6)] transition-[transform,opacity] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                  open
                    ? "translate-y-0 opacity-100"
                    : "-translate-y-[calc(100%+24px)] opacity-0",
                )}
              >
                <div className="flex items-center justify-between px-4 pt-4 sm:px-6 sm:pt-5">
                  <Link
                    to="/"
                    onClick={close}
                    aria-label="Volt home"
                    className={`inline-flex items-center rounded-md ${focusRing}`}
                  >
                    <img
                      src="/volt-icon-256.png"
                      alt=""
                      width={256}
                      height={256}
                      className="size-7"
                    />
                  </Link>
                  <button
                    ref={closeRef}
                    type="button"
                    aria-label="Close menu"
                    onClick={close}
                    className={`inline-grid size-8 place-items-center rounded-full text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white ${focusRing}`}
                  >
                    <X className="size-[18px]" />
                  </button>
                </div>

                <nav aria-label="Site" className="px-2 pt-4 pb-2 sm:px-4">
                  <ul className="flex flex-col gap-0.5">
                    <li>
                      <Link to="/download" onClick={close} className={ROW}>
                        <MenuRow
                          icon={<ArrowDownToLine />}
                          label="Download"
                          hint="macOS, Windows and Linux"
                        />
                      </Link>
                    </li>
                    <li>
                      <Link to="/changelog" onClick={close} className={ROW}>
                        <MenuRow
                          icon={<ScrollText />}
                          label="Changelog"
                          hint="What's new in each release"
                        />
                      </Link>
                    </li>
                    <li>
                      <Link
                        to="/docs/$"
                        params={{ _splat: "install" }}
                        onClick={close}
                        className={ROW}
                      >
                        <MenuRow
                          icon={<BookOpen />}
                          label="Install guide"
                          hint="Set up Volt step by step"
                        />
                      </Link>
                    </li>
                    <li>
                      <Link to="/about" onClick={close} className={ROW}>
                        <MenuRow
                          icon={<Info />}
                          label="About"
                          hint="Who builds Volt, and why"
                        />
                      </Link>
                    </li>
                  </ul>

                  <div className="mx-2.5 my-3 h-px bg-white/[0.08]" />

                  <ul className="flex flex-col gap-0.5">
                    <li>
                      <a
                        href={DISCORD_URL}
                        target="_blank"
                        rel="noreferrer"
                        onClick={close}
                        className={ROW}
                      >
                        <MenuRow
                          icon={<DiscordIcon />}
                          label="Discord"
                          hint="Talk to the team and other users"
                          external
                        />
                      </a>
                    </li>
                    <li>
                      <a
                        href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={close}
                        className={ROW}
                      >
                        <MenuRow
                          icon={<GithubMarkIcon />}
                          label="GitHub"
                          hint={
                            stars === null
                              ? "Source, issues and releases"
                              : `${formatStars(stars)} ${stars === 1 ? "star" : "stars"} · source and issues`
                          }
                          external
                        />
                      </a>
                    </li>
                  </ul>
                </nav>

                <div className="flex items-center gap-2 border-t border-white/[0.06] px-6 py-3.5 text-[12.5px] text-white/40 sm:px-8">
                  <span className="size-1.5 rounded-full bg-emerald-400/80" />
                  Public beta
                  {version ? (
                    <span className="font-mono text-[11.5px] text-white/35">
                      v{version}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function MenuRow({
  icon,
  label,
  hint,
  external = false,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  external?: boolean;
}) {
  const Trailing = external ? ArrowUpRight : ChevronRight;
  return (
    <>
      <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-white/10 bg-white/[0.04] text-white/70 transition-colors duration-150 group-hover:border-white/15 group-hover:text-white [&>*]:size-[17px]">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[15px] font-medium leading-5 text-white/90">
          {label}
        </span>
        <span className="truncate text-[12.5px] leading-[18px] text-white/40">
          {hint}
        </span>
      </span>
      <Trailing className="ml-auto size-4 shrink-0 text-white/25 transition-[color,transform] duration-150 group-hover:translate-x-0.5 group-hover:text-white/60" />
    </>
  );
}
