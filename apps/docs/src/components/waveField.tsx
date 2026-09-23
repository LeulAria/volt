import { useEffect, useRef } from "react";

/** Half-height of each column, in dots, traced from the reference waveform. */
const WAVE = [
  6, 10, 4, 10, 6, 6, 6, 5, 6, 7, 4, 6, 5, 8, 4, 4, 7, 10, 4, 4, 4, 8, 7, 6, 2, 5, 6, 8, 7, 4, 8, 4, 4,
  2, 6, 10, 10, 16, 17, 19, 5, 6, 6, 5, 9, 5, 10, 6, 4, 10, 8, 15, 7, 8, 17, 16, 9, 14, 12, 3, 6, 3, 10,
  9, 13, 19, 6, 10, 10, 17, 9, 12, 7, 7, 7, 4, 8, 4, 10, 6, 4, 8, 8, 5, 6, 2, 16, 16, 5, 5, 7, 9, 21, 11,
  16, 2, 19, 11, 4, 6, 4, 5, 10, 5, 6, 6, 4, 4, 3, 4, 6, 6, 6, 6,
];

/** Dotted waveform from the reference, drawn as background only. */
export function WaveField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let running = true;
    const pitch = 8;
    const speed = 28;
    let last = 0;
    let scroll = 0;
    let sized = "";
    const cols: { x: number; rows: number }[] = [];

    function layout() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      const key = `${w}x${h}x${dpr}`;
      if (key === sized && cols.length > 0) return;
      sized = key;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      cols.length = 0;
      const count = Math.ceil(w / pitch) + 2;
      for (let i = 0; i < count; i++) {
        cols.push({ x: i * pitch, rows: WAVE[i % WAVE.length] });
      }
    }

    function draw(now: number) {
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      const dpr = canvas.width / w;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cy = h * 0.46;
      const radius = 1.55;
      const span = Math.max(pitch, cols.length * pitch);
      if (!reduce && dt > 0) scroll = (scroll + speed * dt) % span;
      const dots = new Path2D();

      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        const x = ((col.x + scroll) % span + span) % span;
        if (x > w + pitch) continue;
        for (let i = 0; i < col.rows; i++) {
          const y = i * pitch;
          dots.moveTo(x + radius, cy - y);
          dots.arc(x, cy - y, radius, 0, Math.PI * 2);
          if (i === 0) continue;
          dots.moveTo(x + radius, cy + y);
          dots.arc(x, cy + y, radius, 0, Math.PI * 2);
        }
      }

      ctx.fillStyle = "rgb(255, 98, 40)";
      ctx.fill(dots);
    }

    function frame(now: number) {
      if (!running) return;
      draw(now);
      if (!reduce) raf = requestAnimationFrame(frame);
    }

    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(canvas);
    raf = requestAnimationFrame(frame);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute inset-0 z-[1] h-full w-full opacity-[0.12] md:opacity-20"
      aria-hidden
    />
  );
}
