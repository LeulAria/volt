import { Link } from "@tanstack/react-router";
import { ArrowUpRight, BookOpenText, Check, Copy, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { focusRing, INSTALL_CURL } from "@/components/landing/install";
import { cn } from "@/lib/cn";

interface Step {
  title: string;
  body: string;
  image: string;
  width: number;
  height: number;
  alt: string;
}

interface Phase {
  label: string;
  note: string;
  steps: Step[];
}

/** The first-launch flow of an app without an Apple Developer ID, as macOS 26 shows it. Numbers match the docs and the release notes. */
const PHASES: Phase[] = [
  {
    label: "Install",
    note: "Like any Mac app.",
    steps: [
      {
        title: "Find the download",
        body: "Open the .dmg in your Downloads folder. A chip named Apple M… in Apple menu, About This Mac means you want the Apple Silicon file.",
        image: "01-download",
        width: 1400,
        height: 1003,
        alt: "The downloaded Volt disk image selected in Finder",
      },
      {
        title: "Open the disk image",
        body: "Double-click it. A window opens with Volt and an Applications shortcut.",
        image: "02-open-dmg",
        width: 990,
        height: 795,
        alt: "The Volt disk image window with the Volt app and an Applications shortcut",
      },
      {
        title: "Drag Volt onto Applications",
        body: "Then eject the disk image from the Finder sidebar.",
        image: "03-drag-to-applications",
        width: 990,
        height: 795,
        alt: "Dragging Volt onto the Applications shortcut",
      },
    ],
  },
  {
    label: "Open it",
    note: "macOS stops it the first time. That is expected.",
    steps: [
      {
        title: "Open Volt",
        body: "From Applications, Launchpad or Spotlight (⌘ Space, then type volt).",
        image: "04-open-volt",
        width: 1390,
        height: 985,
        alt: "Spotlight showing the Volt app",
      },
      {
        title: "Volt Not Opened: click Done",
        body: "macOS could not verify the app because it has no Apple Developer ID. Click Done. The ? opens Apple's help page, the quickest way to the next step.",
        image: "05-not-opened",
        width: 580,
        height: 590,
        alt: "The Volt Not Opened dialog with the question mark and Done button highlighted",
      },
    ],
  },
  {
    label: "Allow it",
    note: "Four clicks in System Settings, once.",
    steps: [
      {
        title: "Open Privacy & Security",
        body: "On Apple's page click Open Privacy & Security settings for me, or open System Settings yourself.",
        image: "06-help-link",
        width: 1400,
        height: 1057,
        alt: "Apple's help page with the Open Privacy and Security settings link highlighted",
      },
      {
        title: "Choose Privacy & Security",
        body: "In the System Settings sidebar, or search for it.",
        image: "07-privacy-and-security",
        width: 1230,
        height: 1040,
        alt: "System Settings with Privacy and Security highlighted",
      },
      {
        title: "Scroll to Security, click Open Anyway",
        body: "Next to “Volt” was blocked to protect your Mac. The button shows for about an hour after a blocked attempt, so if it is missing, open Volt again first.",
        image: "08-open-anyway",
        width: 1230,
        height: 1030,
        alt: "The Open Anyway button in the Security section",
      },
      {
        title: "Click Open Anyway again",
        body: "The blue button in this dialog is Move to Trash. Do not click it and do not press Return.",
        image: "09-confirm-open",
        width: 1230,
        height: 1030,
        alt: "The Open Volt dialog with Open Anyway highlighted",
      },
      {
        title: "Verify it is you",
        body: "Touch ID, or click Use Password… and type your Mac password.",
        image: "10-authenticate",
        width: 1230,
        height: 1030,
        alt: "The Touch ID or password prompt",
      },
    ],
  },
  {
    label: "Done",
    note: "Volt opens normally from now on.",
    steps: [
      {
        title: "Volt opens",
        body: "If macOS asks about a folder such as Documents, click Allow so Volt can open your projects.",
        image: "11-first-launch",
        width: 1400,
        height: 984,
        alt: "Volt's first window with a folder access prompt and Allow highlighted",
      },
    ],
  },
];

const DAMAGED_FIX = "xattr -dr com.apple.quarantine /Applications/Volt.app";

function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-[6px] border border-white/12 bg-white/[0.03] py-2 pr-2 pl-3">
      <span
        aria-hidden
        className="shrink-0 font-mono text-[12px] leading-[1.55] text-emerald-400/90"
      >
        &gt;_
      </span>
      <code className="min-w-0 flex-1 break-all font-mono text-[12px] leading-[1.55] text-white/80">
        {text}
      </code>
      <button
        type="button"
        aria-label={copied ? "Copied" : label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            /* clipboard unavailable */
          }
        }}
        className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[5px] border border-white/20 px-2.5 text-[11px] font-semibold text-white/85 transition-colors hover:border-white/35 hover:bg-white/5 ${focusRing}`}
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-400" strokeWidth={2.5} />
        ) : (
          <Copy className="size-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function StepCard({ step, number }: { step: Step; number: number }) {
  const src = `/install/${step.image}.jpg`;
  return (
    <li className="relative pb-9 pl-11 before:absolute before:top-9 before:bottom-1.5 before:left-[13px] before:w-px before:bg-white/10 last:pb-0 last:before:hidden">
      <span
        aria-hidden
        className="absolute top-0 left-0 grid size-7 place-items-center rounded-full border border-white/20 bg-[#101514] font-mono text-[12px] font-semibold text-white"
      >
        {number}
      </span>
      <h4 className="text-[15px] font-semibold leading-7 tracking-[-0.01em] text-white">
        {step.title}
      </h4>
      <p className="mt-1 text-pretty text-[13.5px] leading-[1.6] text-white/55">
        {step.body}
      </p>
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className={`mt-3.5 block overflow-hidden rounded-[8px] border border-white/10 bg-black/30 transition-colors hover:border-white/25 ${focusRing}`}
        title="Open full size"
      >
        <img
          src={src}
          alt={step.alt}
          width={step.width}
          height={step.height}
          loading="lazy"
          decoding="async"
          className="block h-auto w-full"
        />
      </a>
    </li>
  );
}

/** "How to install on Mac": a button that opens a drawer with the first-launch steps and screenshots. */
export function MacInstallGuide({ className }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const open = useCallback(() => {
    clearTimeout(closeTimer.current);
    setMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
  }, []);

  const close = useCallback(() => {
    setShown(false);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setMounted(false);
      opener.current?.focus();
    }, 220);
    if (window.location.hash === "#install-mac") {
      history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }, []);

  // Deep link: /download#install-mac opens the drawer.
  useEffect(() => {
    if (window.location.hash === "#install-mac") open();
    return () => clearTimeout(closeTimer.current);
  }, [open]);

  // While open: Escape closes, the page behind does not scroll, Tab stays inside.
  useEffect(() => {
    if (!mounted) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const focusTimer = setTimeout(() => panel.current?.focus(), 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      clearTimeout(focusTimer);
    };
  }, [mounted, close]);

  let number = 0;
  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        className={cn(
          "inline-flex h-12 min-w-0 items-center justify-center gap-2.5 rounded-[6px] border border-white/25 px-5 font-sans text-[14px] font-semibold text-white transition-colors duration-150 hover:border-white/40 hover:bg-white/5 sm:h-14 sm:px-6 sm:text-[15px]",
          focusRing,
          className,
        )}
      >
        <BookOpenText className="size-5 shrink-0 opacity-80" />
        <span className="truncate">How to install on Mac</span>
      </button>

      {mounted ? (
        <div className="fixed inset-0 z-[100]">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close the install guide"
            onClick={close}
            className={cn(
              "absolute inset-0 cursor-default bg-black/60 transition-opacity duration-200 motion-reduce:transition-none",
              shown ? "opacity-100" : "opacity-0",
            )}
          />
          <div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mac-install-title"
            tabIndex={-1}
            className={cn(
              "absolute inset-y-0 right-0 flex w-full max-w-[540px] flex-col border-l border-white/10 bg-[#0c1010] text-white shadow-2xl outline-none transition-transform duration-[220ms] ease-out motion-reduce:transition-none",
              shown ? "translate-x-0" : "translate-x-full",
            )}
          >
            <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
              <div className="min-w-0">
                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-white/40">
                  macOS · about a minute
                </div>
                <h3
                  id="mac-install-title"
                  className="mt-1.5 text-[22px] font-semibold leading-tight tracking-[-0.025em]"
                >
                  Install Volt on your Mac
                </h3>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className={`-mt-1 -mr-2 inline-grid size-9 shrink-0 place-items-center rounded-[6px] text-white/60 transition-colors hover:bg-white/8 hover:text-white ${focusRing}`}
              >
                <X className="size-5" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-5 pb-10">
              <p className="rounded-[8px] border border-amber-300/20 bg-amber-300/[0.06] px-4 py-3 text-pretty text-[13px] leading-[1.6] text-amber-100/80">
                Volt is not signed with an Apple Developer ID yet, so macOS asks
                you to confirm the first launch. You do the steps below once,
                and Volt opens normally from then on.
              </p>

              {PHASES.map((phase) => (
                <section key={phase.label} className="mt-8">
                  <div className="mb-4 flex items-baseline gap-3">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/80">
                      {phase.label}
                    </h3>
                    <span className="text-[12.5px] text-white/40">
                      {phase.note}
                    </span>
                  </div>
                  <ol className="relative list-none">
                    {phase.steps.map((step) => {
                      number += 1;
                      return (
                        <StepCard
                          key={step.image}
                          step={step}
                          number={number}
                        />
                      );
                    })}
                  </ol>
                </section>
              ))}

              <section className="mt-10 border-t border-white/10 pt-7">
                <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
                  Prefer no dialogs?
                </h3>
                <p className="mt-1 text-pretty text-[13.5px] leading-[1.6] text-white/55">
                  Files downloaded with curl are not quarantined, so macOS never
                  shows the warning. This installs the latest Volt, checks its
                  SHA-256 and needs no sudo:
                </p>
                <div className="mt-3">
                  <CopyLine
                    text={INSTALL_CURL}
                    label="Copy the install command"
                  />
                </div>

                <h3 className="mt-7 text-[15px] font-semibold tracking-[-0.01em]">
                  “Volt is damaged and can't be opened”
                </h3>
                <p className="mt-1 text-pretty text-[13.5px] leading-[1.6] text-white/55">
                  The app is fine. macOS shows this when the download was
                  changed on the way. Clear the flag and open it again:
                </p>
                <div className="mt-3">
                  <CopyLine text={DAMAGED_FIX} label="Copy the command" />
                </div>

                <h3 className="mt-7 text-[15px] font-semibold tracking-[-0.01em]">
                  Use Volt from the Terminal
                </h3>
                <p className="mt-1 text-pretty text-[13.5px] leading-[1.6] text-white/55">
                  In Volt press ⇧⌘P and run{" "}
                  <span className="text-white/80">
                    Shell Command: Install 'volt' command in PATH
                  </span>
                  . Then{" "}
                  <code className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-[12px] text-white/80">
                    volt .
                  </code>{" "}
                  opens the current folder.
                </p>

                <Link
                  to="/docs/$"
                  params={{ _splat: "install" }}
                  className={`mt-7 inline-flex items-center gap-1.5 rounded text-[13.5px] text-white/70 underline underline-offset-4 transition-colors hover:text-white ${focusRing}`}
                >
                  The full install guide: Windows, Linux, updating, uninstalling
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
