import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

// Plugins touch `window`, so register only in the browser; SSR just renders the markup.
if (typeof window !== "undefined") {
  gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, DrawSVGPlugin);
  gsap.defaults({ ease: "expo.out", duration: 1.1 });
}

/** Shared motion vocabulary so every section moves with the same rhythm. */
export const EASE = {
  out: "expo.out",
  inOut: "power3.inOut",
  soft: "power2.out",
} as const;

export const REDUCED = "(prefers-reduced-motion: reduce)";

export { DrawSVGPlugin, gsap, ScrollTrigger, SplitText, useGSAP };
