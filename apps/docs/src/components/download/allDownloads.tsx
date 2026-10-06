import { ArrowDownToLine } from "lucide-react";
import { focusRing, OsIcon } from "@/components/landing/install";
import { cn } from "@/lib/cn";
import {
  CHANNEL_INFO,
  CHANNELS,
  type Channel,
  type ChannelRelease,
  findAsset,
  formatDate,
  formatSize,
  type Os,
  PLATFORMS,
} from "@/lib/releases";
import type { ReleasesState } from "@/lib/useReleases";

/** Hairline grid shared with the landing sections: 1px gaps over a tinted backdrop. */
const GRID =
  "grid grid-cols-1 gap-px border-y border-white/[0.08] border-x border-x-transparent bg-white/[0.08] bg-clip-padding max-md:border-x-white/[0.08] md:grid-cols-3";

const MONO_LABEL =
  "font-mono text-[10.5px] tracking-[0.16em] text-white/40 uppercase";

/** Stable / Beta / Nightly as three selectable cells, each with its newest version. */
export function ChannelPicker({
  state,
  channel,
  onChannel,
}: {
  state: ReleasesState;
  channel: Channel;
  onChannel: (channel: Channel) => void;
}) {
  return (
    <fieldset>
      <legend className="sr-only">Release channel</legend>
      <div className={GRID}>
        {CHANNELS.map((c) => {
          const info = CHANNEL_INFO[c];
          const release =
            state.status === "ready" ? state.releases[c] : undefined;
          const selected = c === channel;
          return (
            <label
              key={c}
              className={cn(
                "group relative flex cursor-pointer flex-col bg-[#0a0d0c] px-6 pt-7 pb-6 transition-colors has-[:focus-visible]:bg-white/[0.04] md:px-8",
                selected ? "bg-[#0d1110]" : "hover:bg-white/[0.02]",
              )}
            >
              <input
                type="radio"
                name="channel"
                value={c}
                checked={selected}
                onChange={() => onChannel(c)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  "absolute inset-x-0 -top-px h-px origin-left bg-[#ff8a5a] transition-transform duration-500",
                  selected ? "scale-x-100" : "scale-x-0",
                )}
              />
              <span className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className={cn(
                    "grid size-3.5 place-items-center rounded-full border transition-colors",
                    selected ? "border-[#ff8a5a]" : "border-white/25",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full bg-[#ff8a5a] transition-opacity",
                      selected ? "opacity-100" : "opacity-0",
                    )}
                  />
                </span>
                <span className="text-[15.5px] font-medium tracking-[-0.01em] text-white">
                  {info.label}
                </span>
                <span className="ml-auto font-mono text-[11px] text-white/45">
                  {state.status === "loading"
                    ? "…"
                    : (release?.version ?? "none yet")}
                </span>
              </span>
              <span className="mt-2 text-pretty text-[13.5px] leading-relaxed text-white/45">
                {info.blurb}
              </span>
              <span className="mt-4 flex items-center gap-2 text-[12px] text-white/35">
                <span className="text-white/60">{info.app}</span>
                {release ? (
                  <>
                    <span
                      aria-hidden
                      className="size-[3px] rounded-full bg-white/25"
                    />
                    {formatDate(release.publishedAt)}
                  </>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Every platform, arch and package for one channel. Missing builds stay listed, greyed out. */
export function AllDownloads({
  release,
  highlight,
}: {
  release: ChannelRelease | undefined;
  highlight?: Os;
}) {
  return (
    <div className={GRID}>
      {PLATFORMS.map((platform) => (
        <section
          key={platform.os}
          id={`download-${platform.os}`}
          aria-label={`${platform.label} downloads`}
          className={cn(
            "flex scroll-mt-24 flex-col bg-[#0a0d0c] px-6 pt-7 pb-8 md:px-8",
            highlight === platform.os && "bg-[#0d1110]",
          )}
        >
          <h3 className="flex items-center gap-2.5 text-[15.5px] font-medium tracking-[-0.01em] text-white">
            <OsIcon
              os={platform.os}
              className={
                platform.os === "linux" ? "size-[18px]" : "size-4 text-white/85"
              }
            />
            {platform.label}
          </h3>
          <div className="mt-6 flex flex-col gap-6">
            {platform.arches.map(({ arch, label }, archIndex) => (
              <div key={arch}>
                <div className={MONO_LABEL}>{label}</div>
                <ul className="mt-2 flex flex-col">
                  {platform.packages.map((option) => {
                    const asset = findAsset(
                      release,
                      platform.os,
                      arch,
                      option.pkg,
                    );
                    const name = (
                      <span className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-2">
                          <span
                            className={cn(
                              "text-[13.5px]",
                              asset ? "text-white/90" : "text-white/35",
                            )}
                          >
                            {option.label}
                          </span>
                          {option.recommended && archIndex === 0 ? (
                            <span
                              className={cn(
                                "rounded-full border px-1.5 py-px text-[10px] leading-4",
                                asset
                                  ? "border-[#ff8a5a]/40 text-[#ff8a5a]"
                                  : "border-white/10 text-white/30",
                              )}
                            >
                              Recommended
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-[12px] text-white/35">
                          {asset ? option.hint : "Not available in this build"}
                        </span>
                      </span>
                    );
                    return (
                      <li
                        key={option.pkg}
                        className="border-t border-white/[0.06] first:border-t-0"
                      >
                        {asset ? (
                          <a
                            href={asset.url}
                            title={asset.name}
                            className={cn(
                              "group flex items-center gap-3 rounded-[4px] py-2.5 transition-colors hover:bg-white/[0.03]",
                              focusRing,
                            )}
                          >
                            {name}
                            <span className="ml-auto shrink-0 font-mono text-[11px] text-white/40">
                              {formatSize(asset.size)}
                            </span>
                            <ArrowDownToLine className="size-3.5 shrink-0 text-white/35 transition-colors group-hover:text-white" />
                          </a>
                        ) : (
                          <div
                            aria-disabled
                            className="flex items-center gap-3 py-2.5"
                          >
                            {name}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
