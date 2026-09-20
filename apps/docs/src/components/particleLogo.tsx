import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

type Particle = {
  ox: number;
  oy: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  seed: number;
  tx: number;
  ty: number;
  nextRetarget: number;
  wanderR: number;
  seek: boolean;
  nextSeek: number;
  sx: number;
  sy: number;
  arriveDelay: number;
  gatherMs: number;
  turn: number;
  introT: number;
  lx: number;
  ly: number;
  trailDone: boolean;
};

const BOLT: { x: number; y: number }[] = [
  { x: 283, y: 22 },
  { x: 27, y: 349 },
  { x: 181, y: 356 },
  { x: 140, y: 583 },
  { x: 391, y: 259 },
  { x: 235.5, y: 257 },
];
const BOLT_RADIUS = [0, 28, 22, 0, 28, 22];
const BOLT_CORNER = 11;
const MASK_RES = 1200;
const MASK_MARGIN = 0.05;
const MASK_HOLE_R = 0.078;

const PITCH_PX = 6.1;
const MIN_PITCH_PX = 8;
const FIT_PAD = 0.028;

/* Denser hex circles: still gapped, but enough of them that the silhouette holds at the tips. */
const DOT_FILL = 0.52;
const DOT_GAMMA = 0.62;
const COVER_MIN = 0.1;
const MIN_RADIUS = 0.7;
const TAU = Math.PI * 2;
const DOT_FILL_COLOR = "rgba(255,255,255,0.38)";
const WANDER_MIN = 2.8;
const WANDER_SPAN = 4.4;
const RETARGET_MIN_MS = 2200;
const RETARGET_SPAN_MS = 4200;
const DRIFT_SPRING = 0.0045;
const SEEK_PX = 3;
const SEEK_CHANCE = 0.32;
const SEEK_FLIP_MIN_MS = 900;
const SEEK_FLIP_SPAN_MS = 2200;
const FRICTION = 0.94;
const MAX_IDLE_SPEED = 0.35;
const REPEL = 1.15;
const HOLE = 2.0;
const SWEEP = 0.1;
const RADIUS_RATIO = 0.11;
const MAX_SPLIT_SPEED = 7;
const MAX_HOVER_SPEED = 0.95;
const MAX_MOUSE_SPEED = 8;
const STILL_PX = 0.45;
const SPIN_WAIT_MS = 900;
const SPIN_RAMP_MS = 1600;
const SPIN_RAD = 0.007;
const HOME_MAX = 16;
const INTRO_MS = 2100;
const HANDOFF_MS = 420;
const EDGE_PAD = 64;
const WAVE_DELAY = [0, 160, 380];
const WAVE_STAGGER = [110, 200, 320];
const WAVE_GATHER = [700, 980, 1280];

const GLOW_COLOR = "rgb(236, 242, 255)";
const GLOW_PAD = 0.12;
const GLOW_HALO_BLUR = 0.04;
const GLOW_HALO_ALPHA = 0.14;
const GLOW_CORE_BLUR = 0.016;
const GLOW_CORE_ALPHA = 0.055;

type Bitmap = {
  alpha: Uint8Array;
  res: number;
  hole: number;
  canvas: HTMLCanvasElement;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

let cached: Bitmap | null = null;
let tinted: HTMLCanvasElement | null = null;

function edgeLen(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function roundedPoly(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  radii: number | number[],
) {
  const n = pts.length;
  const last = pts[n - 1];
  const first = pts[0];
  ctx.beginPath();
  ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const want = typeof radii === "number" ? radii : (radii[i] ?? 0);
    const rad = Math.min(want, Math.min(edgeLen(prev, curr), edgeLen(curr, next)) * 0.42);
    if (rad <= 0.5) ctx.lineTo(curr.x, curr.y);
    else ctx.arcTo(curr.x, curr.y, next.x, next.y, rad);
  }
  ctx.closePath();
}

function boltPath(ctx: CanvasRenderingContext2D) {
  roundedPoly(ctx, BOLT, BOLT_RADIUS);
}

function renderBolt(): Bitmap | null {
  if (cached?.res === MASK_RES && cached.hole === MASK_HOLE_R) return cached;
  tinted = null;
  const off = document.createElement("canvas");
  off.width = MASK_RES;
  off.height = MASK_RES;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of BOLT) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const span = Math.max(maxX - minX, maxY - minY) + BOLT_CORNER * 2;
  const scale = (MASK_RES * (1 - MASK_MARGIN * 2)) / span;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, MASK_RES, MASK_RES);
  ctx.translate(MASK_RES / 2, MASK_RES / 2);
  ctx.scale(scale, scale);
  ctx.translate(-(minX + maxX) / 2, -(minY + maxY) / 2);

  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = BOLT_CORNER * 2;
  boltPath(ctx);
  ctx.fill();
  ctx.stroke();

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2 + span * 0.012;
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, span * MASK_HOLE_R, 0, TAU);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";

  const { data } = ctx.getImageData(0, 0, MASK_RES, MASK_RES);
  const alpha = new Uint8Array(MASK_RES * MASK_RES);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];

  let inkMinX = MASK_RES;
  let inkMinY = MASK_RES;
  let inkMaxX = -1;
  let inkMaxY = -1;
  for (let y = 0; y < MASK_RES; y++) {
    for (let x = 0; x < MASK_RES; x++) {
      if (alpha[y * MASK_RES + x] < 128) continue;
      if (x < inkMinX) inkMinX = x;
      if (x > inkMaxX) inkMaxX = x;
      if (y < inkMinY) inkMinY = y;
      if (y > inkMaxY) inkMaxY = y;
    }
  }

  cached = {
    alpha,
    res: MASK_RES,
    hole: MASK_HOLE_R,
    canvas: off,
    minX: inkMinX,
    minY: inkMinY,
    maxX: inkMaxX,
    maxY: inkMaxY,
  };
  return cached;
}

function glowSource(): HTMLCanvasElement | null {
  if (tinted) return tinted;
  const bmp = renderBolt();
  if (!bmp || bmp.maxX < 0) return null;
  const w = bmp.maxX + 1 - bmp.minX;
  const h = bmp.maxY + 1 - bmp.minY;
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bmp.canvas, -bmp.minX, -bmp.minY);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = GLOW_COLOR;
  ctx.fillRect(0, 0, w, h);
  tinted = off;
  return tinted;
}

type Fit = { mask: Uint8Array; cell: number; startX: number; startY: number };

function boltMask(cols: number): Fit {
  const mask = new Uint8Array(cols * cols);
  const empty = { mask, cell: 1, startX: 0, startY: 0 };
  const bmp = renderBolt();
  if (!bmp || bmp.maxX < 0) return empty;
  const { alpha, res, minX, minY, maxX, maxY } = bmp;

  const span = Math.max(maxX - minX, maxY - minY) + 1;
  const cell = span / (cols * (1 - FIT_PAD * 2));
  const startX = (minX + maxX + 1) / 2 - (cols / 2) * cell;
  const startY = (minY + maxY + 1) / 2 - (cols / 2) * cell;

  for (let cy = 0; cy < cols; cy++) {
    const y0 = Math.round(startY + cy * cell);
    const y1 = Math.max(y0 + 1, Math.round(startY + (cy + 1) * cell));
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.round(startX + cx * cell);
      const x1 = Math.max(x0 + 1, Math.round(startX + (cx + 1) * cell));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        if (y < 0 || y >= res) continue;
        const row = y * res;
        for (let x = x0; x < x1; x++) {
          if (x < 0 || x >= res) continue;
          sum += alpha[row + x];
          n++;
        }
      }
      mask[cy * cols + cx] = n ? Math.round(sum / n) : 0;
    }
  }
  return { mask, cell, startX, startY };
}

function spawnOffscreen(w: number, h: number) {
  const edge = Math.floor(Math.random() * 8);
  const alongX = Math.random() * w;
  const alongY = Math.random() * h;
  const pad = EDGE_PAD + Math.random() * 72;
  switch (edge) {
    case 0:
      return { x: alongX, y: -pad };
    case 1:
      return { x: w + pad, y: alongY };
    case 2:
      return { x: alongX, y: h + pad };
    case 3:
      return { x: -pad, y: alongY };
    case 4:
      return { x: -pad, y: -pad };
    case 5:
      return { x: w + pad, y: -pad };
    case 6:
      return { x: w + pad, y: h + pad };
    default:
      return { x: -pad, y: h + pad };
  }
}

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function hash01(n: number) {
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
}

function sampleMask(mask: Uint8Array, cols: number, u: number, v: number) {
  const x = Math.max(0, Math.min(cols - 1, u * (cols - 1)));
  const y = Math.max(0, Math.min(cols - 1, v * (cols - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(cols - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = mask[y0 * cols + x0];
  const b = mask[y0 * cols + x1];
  const c = mask[y1 * cols + x0];
  const d = mask[y1 * cols + x1];
  return ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) / 255;
}

export function ParticleLogo({ className }: { className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let particles: Particle[] = [];
    let glow: HTMLCanvasElement | null = null;
    let pitch = 6;
    let raf = 0;
    let running = true;
    let dpr = 1;
    let cssW = 0;
    let cssH = 0;
    let slotW = 0;
    let slotH = 0;
    let midX = 0;
    let midY = 0;

    const mouse = {
      x: 0,
      y: 0,
      px: 0,
      py: 0,
      active: false,
      overLogo: false,
    };
    let stillSince = 0;
    let assembled = reduceMotion;
    let introStart = 0;
    let introPainted = false;
    let pageCanvas = !reduceMotion;
    let wrapTop = 0;
    const shell = (wrap.closest(".home-shell") as HTMLElement | null) ?? wrap;
    const trail = document.createElement("canvas");
    trail.setAttribute("aria-hidden", "true");
    trail.className = "pointer-events-none absolute inset-0 z-[1]";
    shell.appendChild(trail);
    const tctx = trail.getContext("2d");

    function slotPad() {
      return Math.round(Math.min(slotW, slotH) * GLOW_PAD);
    }

    function syncTrailSize() {
      if (!tctx) return;
      const w = Math.max(1, shell.clientWidth);
      const h = Math.max(1, shell.clientHeight);
      const tw = Math.round(w * dpr);
      const th = Math.round(h * dpr);
      if (trail.width === tw && trail.height === th) return;
      const prev = document.createElement("canvas");
      prev.width = trail.width;
      prev.height = trail.height;
      prev.getContext("2d")?.drawImage(trail, 0, 0);
      trail.width = tw;
      trail.height = th;
      trail.style.width = `${w}px`;
      trail.style.height = `${h}px`;
      if (prev.width && prev.height) tctx.drawImage(prev, 0, 0, tw, th);
    }

    function trailPoint(x: number, y: number) {
      const sr = shell.getBoundingClientRect();
      if (pageCanvas) return { x: (x - sr.left) * dpr, y: (y - sr.top) * dpr };
      const wr = wrap.getBoundingClientRect();
      const pad = slotPad();
      return { x: (wr.left - sr.left - pad + x) * dpr, y: (wr.top - sr.top - pad + y) * dpr };
    }

    function strokeSegment(x0: number, y0: number, x1: number, y1: number) {
      if (!tctx) return;
      const a = trailPoint(x0, y0);
      const b = trailPoint(x1, y1);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (dist < 0.45) return;
      const sp = Math.min(1, dist / (22 * dpr));
      tctx.beginPath();
      tctx.moveTo(a.x, a.y);
      tctx.lineTo(b.x, b.y);
      tctx.strokeStyle = `rgba(255,255,255,${0.022 + 0.032 * sp})`;
      tctx.lineWidth = Math.max(0.5, dpr * 0.48);
      tctx.lineCap = "round";
      tctx.lineJoin = "round";
      tctx.stroke();
    }

    function keepsTrail(p: Particle) {
      return hash01(p.seed + 99.1) <= 0.22;
    }

    function strokeTrail(p: Particle) {
      if (!tctx || !keepsTrail(p) || p.trailDone || p.introT <= 0) {
        p.lx = p.x;
        p.ly = p.y;
        return;
      }
      strokeSegment(p.lx, p.ly, p.x, p.y);
      p.lx = p.x;
      p.ly = p.y;
    }

    function applyPageCanvas() {
      cssW = window.innerWidth;
      cssH = window.innerHeight;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.position = "fixed";
      canvas.style.left = "0";
      canvas.style.top = "0";
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.style.zIndex = "30";
    }

    function applySlotCanvas() {
      const pad = slotPad();
      const cw = slotW + pad * 2;
      const ch = slotH + pad * 2;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.position = "absolute";
      canvas.style.left = `${-pad}px`;
      canvas.style.top = `${-pad}px`;
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
      canvas.style.zIndex = "";
    }

    function pinToSlot() {
      if (!pageCanvas) return;
      const rect = wrap.getBoundingClientRect();
      const pad = slotPad();
      const originX = rect.left - pad;
      const originY = rect.top - pad;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x -= originX;
        p.y -= originY;
        p.ox -= originX;
        p.oy -= originY;
        p.tx -= originX;
        p.ty -= originY;
        p.sx -= originX;
        p.sy -= originY;
      }
      midX -= originX;
      midY -= originY;
      pageCanvas = false;
      applySlotCanvas();
    }

    function onScroll() {
      if (!pageCanvas) return;
      const top = wrap.getBoundingClientRect().top;
      const dy = top - wrapTop;
      wrapTop = top;
      if (!dy) return;
      midY += dy;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.oy += dy;
        p.ty += dy;
        p.sy += dy;
      }
    }

    function resize() {
      const rect = wrap.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (w < 8 || h < 8) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      slotW = w;
      slotH = h;
      wrapTop = rect.top;
      syncTrailSize();
      if (pageCanvas) {
        applyPageCanvas();
        midX = rect.left + w * 0.5;
        midY = rect.top + h * 0.5;
      } else {
        applySlotCanvas();
        const pad = slotPad();
        midX = pad + w * 0.5;
        midY = pad + h * 0.5;
      }
      buildParticles();
    }

    function buildParticles() {
      if (particles.length > 0 && !assembled) return;
      const fieldPx = Math.round(Math.min(slotW, slotH) * dpr);
      pitch = Math.max(MIN_PITCH_PX, Math.round(PITCH_PX * dpr));
      const rowPitch = pitch * 0.866; /* hex: sin(60°) */
      const cols = Math.max(24, Math.floor(fieldPx / pitch));
      const rows = Math.max(24, Math.floor(fieldPx / rowPitch));
      const gridW = cols * pitch;
      const gridH = rows * rowPitch;
      const pad = Math.round(Math.min(slotW, slotH) * GLOW_PAD);
      const localW = Math.round((slotW + pad * 2) * dpr);
      const localH = Math.round((slotH + pad * 2) * dpr);
      const oxPx = (localW - gridW) / 2;
      const oyPx = (localH - gridH) / 2;
      const maxR = (pitch * DOT_FILL) / 2;
      const wrapRect = wrap.getBoundingClientRect();
      const originX = pageCanvas ? wrapRect.left - pad : 0;
      const originY = pageCanvas ? wrapRect.top - pad : 0;

      const { mask } = boltMask(cols);
      const next: Particle[] = [];
      const scatter = !assembled && !reduceMotion;
      if (scatter && !introStart) introStart = performance.now();
      for (let y = 0; y < rows; y++) {
        const odd = y & 1;
        for (let x = 0; x < cols; x++) {
          const fx = x + (odd ? 0.5 : 0);
          if (fx >= cols - 0.05) continue;
          const coverage = sampleMask(mask, cols, fx / cols, y / rows);
          if (coverage < COVER_MIN) continue;
          const px = originX + (oxPx + fx * pitch + pitch / 2) / dpr;
          const py = originY + (oyPx + y * rowPitch + rowPitch / 2) / dpr;
          const seed = x * 12.9898 + y * 78.233;
          const wanderR = WANDER_MIN + hash01(seed) * WANDER_SPAN;
          const angle = hash01(seed + 2.17) * TAU;
          const dist = hash01(seed + 5.91) * wanderR;
          const tx = px + Math.cos(angle) * dist;
          const ty = py + Math.sin(angle) * dist;
          const start = scatter ? spawnOffscreen(cssW, cssH) : { x: px, y: py };
          const r = Math.max(MIN_RADIUS, maxR * Math.pow(coverage, DOT_GAMMA));
          const detail = 1 - r / maxR;
          const pick = hash01(seed + 41.2);
          const wave = pick < 0.16 ? 0 : detail > 0.52 || pick > 0.78 ? 2 : 1;
          const arriveDelay = WAVE_DELAY[wave] + hash01(seed + 7.1) * WAVE_STAGGER[wave];
          const gatherMs = WAVE_GATHER[wave] * (0.78 + hash01(seed + 3.4) * 0.5);
          const turn = hash01(seed + 19.4) < 0.5 ? -1 : 1;
          const inx = midX - start.x;
          const iny = midY - start.y;
          const ind = Math.hypot(inx, iny) || 1;
          const launch = 4.2 + hash01(seed + 28.1) * 8.5;
          const drift = (1.4 + hash01(seed + 11.6) * 3.2) * turn;
          next.push({
            ox: px,
            oy: py,
            x: scatter ? start.x : tx,
            y: scatter ? start.y : ty,
            sx: start.x,
            sy: start.y,
            vx: scatter ? (inx / ind) * launch + (-iny / ind) * drift : 0,
            vy: scatter ? (iny / ind) * launch + (inx / ind) * drift : 0,
            r,
            seed,
            tx,
            ty,
            nextRetarget: hash01(seed + 9.4) * RETARGET_SPAN_MS,
            wanderR,
            seek: hash01(seed + 13.7) < SEEK_CHANCE,
            nextSeek: hash01(seed + 17.2) * SEEK_FLIP_SPAN_MS,
            arriveDelay,
            gatherMs,
            turn,
            introT: 0,
            lx: scatter ? start.x : tx,
            ly: scatter ? start.y : ty,
            trailDone: false,
          });
        }
      }

      particles = next;
      glow = null;
      paintIdle();
    }

    function buildGlow() {
      glow = null;
      const src = glowSource();
      if (!src || particles.length === 0) return;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (p.ox < minX) minX = p.ox;
        if (p.oy < minY) minY = p.oy;
        if (p.ox > maxX) maxX = p.ox;
        if (p.oy > maxY) maxY = p.oy;
      }

      const layer = document.createElement("canvas");
      layer.width = canvas.width;
      layer.height = canvas.height;
      const g = layer.getContext("2d");
      if (!g) return;

      const dx = minX * dpr;
      const dy = minY * dpr;
      const dw = Math.max(1, (maxX - minX) * dpr);
      const dh = Math.max(1, (maxY - minY) * dpr);
      const unit = Math.max(dw, dh);

      g.globalAlpha = GLOW_HALO_ALPHA;
      g.filter = `blur(${unit * GLOW_HALO_BLUR}px)`;
      g.drawImage(src, dx, dy, dw, dh);
      g.globalAlpha = GLOW_CORE_ALPHA;
      g.filter = `blur(${unit * GLOW_CORE_BLUR}px)`;
      g.drawImage(src, dx, dy, dw, dh);
      glow = layer;
    }

    function onPointerMove(e: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.active = true;
      const box = wrap.getBoundingClientRect();
      mouse.overLogo =
        e.clientX >= box.left &&
        e.clientX <= box.right &&
        e.clientY >= box.top &&
        e.clientY <= box.bottom;
    }

    function paintIdle() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const dots = new Path2D();
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const cx = p.x * dpr;
        const cy = p.y * dpr;
        dots.moveTo(cx + p.r, cy);
        dots.arc(cx, cy, p.r, 0, TAU);
      }
      ctx.fillStyle = DOT_FILL_COLOR;
      ctx.fill(dots);
    }

    function paintIntro(blend: number) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      introPainted = true;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (p.introT <= 0 && blend <= 0) continue;
        const fade = smoothstep(0.02, 0.28, Math.max(p.introT, blend));
        const introA = 0.1 + 0.3 * fade;
        const introR = p.r * (0.35 + 0.65 * smoothstep(0.08, 0.7, Math.max(p.introT, 0.2)));
        const a = introA + (0.38 - introA) * blend;
        const rad = introR + (p.r - introR) * blend;
        ctx.beginPath();
        ctx.arc(p.x * dpr, p.y * dpr, Math.max(0.4, rad), 0, TAU);
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.fill();
      }
    }

    function step() {
      if (!running) return;
      raf = requestAnimationFrame(step);

      const now = performance.now();
      const mvx = Math.max(-MAX_MOUSE_SPEED, Math.min(MAX_MOUSE_SPEED, mouse.x - mouse.px));
      const mvy = Math.max(-MAX_MOUSE_SPEED, Math.min(MAX_MOUSE_SPEED, mouse.y - mouse.py));
      mouse.px = mouse.x;
      mouse.py = mouse.y;
      const holeR = Math.min(slotW, slotH) * RADIUS_RATIO;
      const holeR2 = holeR * holeR;
      const still = mouse.overLogo && Math.hypot(mvx, mvy) < STILL_PX;
      if (still) {
        if (!stillSince) stillSince = now;
      } else {
        stillSince = 0;
      }
      const spin = stillSince
        ? Math.min(1, Math.max(0, (now - stillSince - SPIN_WAIT_MS) / SPIN_RAMP_MS))
        : 0;

      if (!reduceMotion && !assembled) {
        const elapsed = now - introStart;
        const blend = smoothstep(INTRO_MS, INTRO_MS + HANDOFF_MS, elapsed);
        if (elapsed >= INTRO_MS + HANDOFF_MS) {
          assembled = true;
          for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            p.vx *= 0.4;
            p.vy *= 0.4;
            p.introT = 1;
            p.trailDone = true;
          }
          pinToSlot();
          paintIdle();
        } else {
          const swirlR = Math.min(slotW, slotH) * 0.28;
          for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            const life = elapsed - p.arriveDelay;
            if (life < 0) {
              p.introT = 0;
              continue;
            }
            const u = Math.max(0, Math.min(1, life / p.gatherMs));
            p.introT = Math.max(u, blend);
            const condense = smoothstep(0.12, 0.62, u);
            const settle = smoothstep(0.5, 1, u);
            const midDx = midX - p.x;
            const midDy = midY - p.y;
            const midD = Math.hypot(midDx, midDy) || 1;
            const ang = p.seed + life * 0.0022 * p.turn;
            const cloud = swirlR * (1 - condense) * (1 - blend);
            const tgtX = (midX + Math.cos(ang) * cloud) * (1 - condense) + p.tx * condense;
            const tgtY = (midY + Math.sin(ang) * cloud) * (1 - condense) + p.ty * condense;
            const pull = 0.02 + condense * 0.05 + settle * 0.06 + blend * 0.08;
            p.vx += (tgtX - p.x) * pull;
            p.vy += (tgtY - p.y) * pull;
            const curl = (1 - condense) * (1 - blend) * 0.07 * p.turn;
            p.vx += (-midDy / midD) * curl * Math.min(midD, 240);
            p.vy += (midDx / midD) * curl * Math.min(midD, 240);
            const turb = (1 - condense) * (1 - blend) * 0.42;
            p.vx += (hash01(p.seed + life * 0.033) - 0.5) * turb;
            p.vy += (hash01(p.seed + 8.7 + life * 0.03) - 0.5) * turb;
            p.vx *= 0.96 - settle * 0.05 - blend * 0.04;
            p.vy *= 0.96 - settle * 0.05 - blend * 0.04;
            const maxSp = 18 - condense * 10 - blend * 4;
            const sp = Math.hypot(p.vx, p.vy);
            if (sp > maxSp) {
              const k = maxSp / sp;
              p.vx *= k;
              p.vy *= k;
            }
            p.x += p.vx;
            p.y += p.vy;
            if (blend > 0) {
              p.x += (p.tx - p.x) * (0.08 + blend * 0.16);
              p.y += (p.ty - p.y) * (0.08 + blend * 0.16);
            }
            strokeTrail(p);
          }
          paintIntro(blend);
        }
        return;
      }

      if (!reduceMotion) {
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          if (now >= p.nextRetarget) {
            const angle = Math.random() * TAU;
            const dist = Math.random() * p.wanderR;
            p.tx = p.ox + Math.cos(angle) * dist;
            p.ty = p.oy + Math.sin(angle) * dist;
            p.nextRetarget = now + RETARGET_MIN_MS + Math.random() * RETARGET_SPAN_MS;
          }
          if (now >= p.nextSeek) {
            p.seek = Math.random() < SEEK_CHANCE;
            p.nextSeek = now + SEEK_FLIP_MIN_MS + Math.random() * SEEK_FLIP_SPAN_MS;
          }
          let tx = p.tx;
          let ty = p.ty;
          if (mouse.active && p.seek) {
            const dx = mouse.x - p.ox;
            const dy = mouse.y - p.oy;
            const dist = Math.hypot(dx, dy) || 1;
            tx += (dx / dist) * SEEK_PX;
            ty += (dy / dist) * SEEK_PX;
          }
          p.vx += (tx - p.x) * DRIFT_SPRING;
          p.vy += (ty - p.y) * DRIFT_SPRING;

          let splitting = false;
          if (mouse.overLogo) {
            const dx = p.x - mouse.x;
            const dy = p.y - mouse.y;
            const d2 = dx * dx + dy * dy;
            const dist = Math.sqrt(d2) || 0.0001;
            if (d2 < holeR2) {
              const falloff = 1 - dist / holeR;
              const t2 = falloff * falloff;
              p.vx += (dx / dist) * t2 * REPEL;
              p.vy += (dy / dist) * t2 * REPEL;
              p.x += (dx / dist) * t2 * HOLE;
              p.y += (dy / dist) * t2 * HOLE;
              p.vx += mvx * falloff * SWEEP;
              p.vy += mvy * falloff * SWEEP;
              splitting = true;
            }
          }

          p.vx *= FRICTION;
          p.vy *= FRICTION;
          const maxSp = splitting ? MAX_SPLIT_SPEED : mouse.overLogo ? MAX_HOVER_SPEED : MAX_IDLE_SPEED;
          const sp = Math.hypot(p.vx, p.vy);
          if (sp > maxSp) {
            const k = maxSp / sp;
            p.vx *= k;
            p.vy *= k;
          }
          p.x += p.vx;
          p.y += p.vy;
          if (spin > 0 && mouse.overLogo) {
            const dx = p.x - mouse.x;
            const dy = p.y - mouse.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < holeR2) {
              const ang = SPIN_RAD * spin;
              const c = Math.cos(ang);
              const s = Math.sin(ang);
              const nx = mouse.x + dx * c - dy * s;
              const ny = mouse.y + dx * s + dy * c;
              if (Math.hypot(nx - p.ox, ny - p.oy) <= HOME_MAX) {
                p.x = nx;
                p.y = ny;
              }
            }
          }
          if (mouse.overLogo) {
            const homeDx = p.x - p.ox;
            const homeDy = p.y - p.oy;
            const homeD = Math.hypot(homeDx, homeDy);
            if (homeD > HOME_MAX) {
              const k = HOME_MAX / homeD;
              p.x = p.ox + homeDx * k;
              p.y = p.oy + homeDy * k;
            }
          }
        }
      }

      paintIdle();
    }

    resize();
    raf = requestAnimationFrame(step);

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", onScroll);
      trail.remove();
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className={cn(
        "relative aspect-square overflow-visible",
        "mx-auto size-[min(70vw,220px)] sm:size-[min(48vw,260px)]",
        "md:mx-0 md:size-auto md:h-full md:max-h-[min(92vw,82vh,720px)] md:w-auto md:max-w-[min(92vw,720px)]",
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none fixed inset-0 z-30 touch-none"
        aria-label="Volt"
        role="img"
      />
    </div>
  );
}
