import { ArrowDownToLine, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { focusRing, OsIcon } from "@/components/landing/install";
import { cn } from "@/lib/cn";
import {
  archLabel,
  CHANNEL_INFO,
  formatSize,
  packageOf,
  platformOf,
  type ReleaseAsset,
} from "@/lib/releases";

/** What happens after the file lands, per platform. */
const NEXT_STEPS: Record<ReleaseAsset["os"], string> = {
  darwin:
    "Open the .dmg and drag Volt to Applications. Volt is signed and notarized, and it updates itself. Coming from 0.0.3 or older? Replace the old app once; your settings and chats stay.",
  win32:
    "The installer is not code-signed yet, so Windows shows Windows protected your PC: click More info, then Run anyway.",
  linux:
    "Install the .deb or .rpm with your package manager (for example sudo apt install ./the-file.deb), or unpack the .tar.gz anywhere.",
};

/**
 * The confirmation before a download starts: which build is about to download (version,
 * processor, package, size) and what to do once it lands. Download starts the file and
 * closes the dialog.
 */
export function DownloadDialog({
  asset,
  open,
  onClose,
}: {
  asset: ReleaseAsset;
  open: boolean;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() =>
        requestAnimationFrame(() => setShown(true)),
      );
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), 180);
    return () => clearTimeout(timer);
  }, [open]);

  // While open: Escape closes, the page behind does not scroll, the Download button has focus.
  useEffect(() => {
    if (!mounted) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const focus = setTimeout(() => confirm.current?.focus(), 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      clearTimeout(focus);
    };
  }, [mounted, onClose]);

  const download = useCallback(() => {
    window.location.assign(asset.url);
    onClose();
  }, [asset.url, onClose]);

  if (!mounted) return null;
  const platform = platformOf(asset.os);
  const info = CHANNEL_INFO[asset.channel];
  // On body: the hero animates its blocks with transforms, which would trap a fixed overlay.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-6">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Cancel"
        onClick={onClose}
        className={cn(
          "absolute inset-0 cursor-default bg-black/60 transition-opacity duration-200 motion-reduce:transition-none",
          shown ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="download-dialog-title"
        className={cn(
          "relative w-full max-w-[460px] rounded-t-[14px] border border-white/10 bg-[#0c1010] text-left text-white shadow-2xl outline-none transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none sm:rounded-[12px]",
          shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
        )}
      >
        <header className="flex items-start justify-between gap-4 px-6 pt-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-grid size-10 shrink-0 place-items-center rounded-[8px] border border-white/10 bg-white/[0.04]">
              <OsIcon
                os={asset.os}
                className={cn(
                  "size-5",
                  asset.os === "linux" ? "" : "text-white",
                )}
              />
            </span>
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-white/45">
                {info.app} {asset.version}
              </div>
              <h3
                id="download-dialog-title"
                className="mt-1 text-[19px] font-semibold leading-tight tracking-[-0.02em]"
              >
                Download Volt for {platform.label}
              </h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`-mt-1 -mr-2 inline-grid size-9 shrink-0 place-items-center rounded-[6px] text-white/60 transition-colors hover:bg-white/8 hover:text-white ${focusRing}`}
          >
            <X className="size-5" />
          </button>
        </header>

        <dl className="mx-6 mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-[8px] border border-white/10 px-4 py-3 text-[13px]">
          <dt className="text-white/45">Processor</dt>
          <dd className="text-white/85">{archLabel(asset.os, asset.arch)}</dd>
          <dt className="text-white/45">Package</dt>
          <dd className="text-white/85">
            {packageOf(asset.os, asset.pkg)?.label ?? asset.pkg}
          </dd>
          <dt className="text-white/45">Size</dt>
          <dd className="text-white/85">{formatSize(asset.size)}</dd>
          <dt className="text-white/45">File</dt>
          <dd className="truncate font-mono text-[12px] text-white/70">
            {asset.name}
          </dd>
        </dl>

        <p className="mx-6 mt-4 text-pretty text-[13px] leading-[1.6] text-white/55">
          {NEXT_STEPS[asset.os]}
        </p>

        <div className="mt-6 flex flex-col-reverse gap-2 border-t border-white/10 px-6 py-4 sm:flex-row sm:items-center sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className={`inline-flex h-10 items-center justify-center rounded-[6px] border border-white/20 px-4 text-[13px] font-semibold text-white transition-colors hover:border-white/35 hover:bg-white/5 max-sm:w-full ${focusRing}`}
          >
            Cancel
          </button>
          <button
            ref={confirm}
            type="button"
            onClick={download}
            className={`inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-white px-4 text-[13px] font-semibold text-black transition-opacity hover:opacity-90 max-sm:w-full ${focusRing}`}
          >
            <ArrowDownToLine className="size-4" />
            Download
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
