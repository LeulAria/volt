/**
 * Dynamic Text — rotating feature/card labels with animation.
 * Styled for VOLT dark theme. Left-aligned.
 */

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

const ROTATING_TEXTS = [
  "The better API client",
  "Build & test APIs",
  "Collections & envs",
  "Database connections",
  "Team ready",
  "REST & GraphQL",
  "Variables",
  "Environments",
  "Request history",
  "Scripts & tests",
  "Documentation",
];

export interface DynamicTextProps {
  /** When true, use hero title styling (large, bold, tracking). */
  variant?: "default" | "hero";
  /** Text alignment. */
  align?: "left" | "center";
}

export function DynamicText({ variant = "default", align = "left" }: DynamicTextProps) {
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % ROTATING_TEXTS.length);
    }, 600);
    return () => clearInterval(interval);
  }, []);

  const textVariants = {
    hidden: { y: 12, opacity: 0 },
    visible: { y: 0, opacity: 1 },
    exit: { y: -60, opacity: 0 },
  };

  const wrapperClass = "relative w-full overflow-hidden";

  const isCentered = align === "center";
  return (
    <div
      className={`flex w-full ${isCentered ? "justify-center" : "justify-start"} ${variant === "default" ? "mt-1.5" : ""}`}
      aria-label="Rotating feature highlights"
    >
      <div className={wrapperClass}>
        <AnimatePresence mode="popLayout">
          <motion.div
            key={currentIndex}
            initial={textVariants.hidden}
            animate={textVariants.visible}
            exit={textVariants.exit}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className={`absolute top-0 ${isCentered ? "left-1/2 -translate-x-1/2 text-center" : "left-0 text-left"} rounded-sm border border-zinc-300/5 bg-white/5 p-1 px-3 tracking-wide shadow-xs`}
            style={{
              fontSize: "0.8rem",
              fontWeight: 400,
            }}
            aria-live="polite"
          >
            {ROTATING_TEXTS[currentIndex]}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
