import { cn } from "@/lib/cn";
import { COLUMN } from "./geometry";
import { focusRing } from "./install";

/** Where each backdrop photo is, and what Google Maps searches for to show it. */
export const PLACES = {
  axum: { name: "Axum", query: "Obelisk of Axum, Axum, Ethiopia" },
  lalibela: {
    name: "Lalibela",
    query: "Church of Saint George, Lalibela, Ethiopia",
  },
  gondar: { name: "Gondar", query: "Fasil Ghebbi, Gondar, Ethiopia" },
  harar: { name: "Harar", query: "Harar Jugol, Harar, Ethiopia" },
} as const;

type Place = (typeof PLACES)[keyof typeof PLACES];

/**
 * A map pin standing over the photo's place name. It opens the place in Google Maps (the app,
 * on phones that have it).
 */
export function PhotoPlace({
  place,
  compact = false,
  className,
}: {
  place: Place;
  /** Just the pin and the name, without the country line under it. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <a
      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.query)}`}
      target="_blank"
      rel="noreferrer"
      title="Open in Google Maps"
      aria-label={`${place.name}, Ethiopia, in Google Maps`}
      className={cn(
        "group pointer-events-auto flex flex-col items-center rounded-[10px] px-3 pt-1 pb-1.5",
        focusRing,
        className,
      )}
    >
      {/* 28px pin over a 32px box: its tip lands on the middle of the ground ellipse */}
      <span aria-hidden className="relative flex h-8 w-9 justify-center">
        {/* the ground under the tip: a ring spreading slowly from it, and the pin's shadow */}
        <span className="place-pulse absolute bottom-0 h-2.5 w-6 rounded-[50%] border border-[#ff8a5a]/80" />
        <span className="absolute bottom-0.5 h-1.5 w-3.5 rounded-[50%] bg-black/70 blur-[2px] transition-transform duration-300 group-hover:scale-75" />
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          fill="none"
          stroke="#ffffff"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="relative size-7 drop-shadow-[0_2px_6px_rgba(0,0,0,0.7)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-1"
        >
          <path d="M17.6569 16.6569C16.7202 17.5935 14.7616 19.5521 13.4138 20.8999C12.6327 21.681 11.3677 21.6814 10.5866 20.9003C9.26234 19.576 7.34159 17.6553 6.34315 16.6569C3.21895 13.5327 3.21895 8.46734 6.34315 5.34315C9.46734 2.21895 14.5327 2.21895 17.6569 5.34315C20.781 8.46734 20.781 13.5327 17.6569 16.6569Z" />
          <path d="M15 11C15 12.6569 13.6569 14 12 14C10.3431 14 9 12.6569 9 11C9 9.34315 10.3431 8 12 8C13.6569 8 15 9.34315 15 11Z" />
        </svg>
      </span>
      <span className="mt-1.5 text-[13px] font-semibold leading-none tracking-[-0.01em] text-white [text-shadow:0_1px_10px_rgba(0,0,0,0.7)]">
        {place.name}
      </span>
      {compact ? null : (
        <span className="mt-1 text-[9.5px] font-medium uppercase leading-none tracking-[0.2em] text-white/60 transition-colors [text-shadow:0_1px_8px_rgba(0,0,0,0.8)] group-hover:text-white/85">
          Ethiopia
        </span>
      )}
    </a>
  );
}

/**
 * The pin at the bottom right of a photo, on the column's edge. Goes last in the photo's
 * `relative` wrapper, so it sits above the content and comes after it in the tab order.
 */
export function PagePlace({
  place,
  intro = false,
  className,
}: {
  place: Place;
  /** Rises in with the home hero's opening sequence (`data-hero="rest"`). */
  intro?: boolean;
  /** For the layer: hide it somewhere, or lift it with `bottom-*`. */
  className?: string;
}) {
  return (
    <div
      data-hero={intro ? "rest" : undefined}
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-10",
        className,
      )}
    >
      <div className={cn(COLUMN, "flex justify-end pb-5")}>
        <PhotoPlace place={place} />
      </div>
    </div>
  );
}
