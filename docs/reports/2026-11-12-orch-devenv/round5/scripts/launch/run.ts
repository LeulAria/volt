// Round 5, launch (copied from round 4's coldstart/run.ts). ADEMark method, unofficial: A1 (cold, no `purge`) and A2
// (relaunch) on minified builds of Volt: "before" (9bbb8818c60, ~/.volt-r5/min/base) and "after" builds of e5/launch, with the instruments of round 3's run.ts (ADEMark's native helper
// for the quiet gate and process lists, winwait for the first window, DOM echo over CDP for Ready). Differences from an
// official run are the same as round 3's (see round3/scripts/ademark/run.ts): no purge, CDP keys, CDP on the timed
// launch, own macOS account, isolated HOME and profile per arm.
//
// Each row also carries a breakdown from the app's own perf marks (main process marks handed to the window, and the
// renderer's marks), on the same wall clock as t0, so the time can be split into main start, window, workbench load
// and workbench to composer.
//
// Usage: bun run.ts --app cold-before|cold-after --tests A1,A2 --reps 1 --start N --out <dir>
//        bun run.ts --app <id> --launch | --quit | --kill | --main-pid | --attributed
import { spawn, spawnSync } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nowNs } from "/tmp/ademark/bench/core/clock.ts";

const R4 = `${process.env.HOME_REAL ?? "/Users/leularia"}/.volt-r5/launch`;
const NATIVE = process.env.ADEMARK_NATIVE ?? "/tmp/ademark/bench/native/bin/ademark-native";
const WINWAIT = process.env.ADE_WINWAIT ?? `/Users/leularia/.volt-r4/coldstart/winwait`;
const REPLAY_URL = process.env.ADE_REPLAY_URL ?? "http://127.0.0.1:18994";
const CDP_PORT = Number(process.env.ADE_CDP_PORT ?? 9974);
const PROBE = "ademarkqz";
const HOMES = `${R4}/h`;
const ARENA = `/Users/leularia/.volt-r4/coldstart/arena`;

interface App { id: string; bundle: string; home: string; ud: string; dev?: string }
// Every arm is a directory under ~/.volt-r5/launch/apps/<bundle>/VOLT.app with its own HOME and profile. "-long" arms
// share the bundle of their base arm. Any other name is accepted as an exploration arm of the same layout.
const arm = (id: string, name: string, bundle = name): App => ({ id, bundle: `${R4}/apps/${bundle}/VOLT.app`, home: `${HOMES}/${name}`, ud: `${R4}/ud/${name}` });
const armFor = (id: string): App => { const m = /^(.*)-long$/.exec(id); return m ? arm(id, id, m[1]) : arm(id, id); };
const APPS: Record<string, App> = new Proxy({} as Record<string, App>, { get: (_t, k: string) => (/^[a-z0-9-]+$/.test(k) ? armFor(k) : undefined), ownKeys: () => [] });

const KEEP = process.env.ADE_KEEP_RENDERING ? ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] : [];
function env(home: string, dev?: boolean): string[] {
  const vars: Record<string, string> = {
    ...(dev ? { NODE_ENV: "development", VSCODE_DEV: "1", VSCODE_CLI: "1", VSCODE_SKIP_PRELAUNCH: "1", VOLT_AGENT_SERVER_LAUNCHD: "0" } : {}),
    // Seeding only: a launchd agent server does not get the app's environment, so its sandbox does not grant the replay
    // server's loopback port (ANTHROPIC_BASE_URL) and seed turns hang. Timed launches keep the shipped launchd server.
    ...(process.env.ADE_SERVER_DETACHED ? { VOLT_AGENT_SERVER_LAUNCHD: "0" } : {}),
    HOME: home,
    PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    ANTHROPIC_BASE_URL: REPLAY_URL,
    ANTHROPIC_API_KEY: "sk-ant-replay-0000",
    DISABLE_AUTOUPDATER: "1",
  };
  return Object.entries(vars).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}
function launchArgv(app: App): string[] {
  return ["open", "-n", "-a", app.bundle, ...env(app.home, !!app.dev), "--args", ...(app.dev ? [app.dev, "--disable-extension=vscode.vscode-api-tests"] : []), "--use-mock-keychain",
    "--user-data-dir", app.ud, "--extensions-dir", `${app.home}/.volt/extensions`, `--remote-debugging-port=${CDP_PORT}`, ...KEEP,
    ...(process.env.ADE_OPEN ? [process.env.ADE_OPEN] : []), ...(process.env.ADE_EXTRA ? process.env.ADE_EXTRA.split(" ") : [])];
}
// The focused composer's text: the real one (Monaco), or the window snapshot's text area that stands in for it from the
// first frame until the workbench takes over (it keeps the keys and hands them to the real composer). ADEMark reads
// Ready from the pixels of the composer region, where both draw the typed text.
const COMPOSER_TEXT = `(()=>{const a=document.activeElement; const ed=a?.closest?.('.volt-agent-composer .monaco-editor');
  return {real: ed ? (ed.querySelector('.view-lines')?.textContent ?? '') : null, snap: a?.id === 'volt-window-snapshot-input' ? a.value : null}})()`;

function voltLabel(ud: string): string {
  return `com.volt.agent-server.${new Bun.CryptoHasher("sha256").update(ud).digest("hex").slice(0, 12)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;
function native(args: string[]): any {
  const r = spawnSync([NATIVE, ...args]);
  const out = r.stdout.toString().trim();
  try { return JSON.parse(out); } catch { return { error: "parse", out, err: r.stderr.toString() }; }
}
function uptime(): string { return spawnSync(["uptime"]).stdout.toString().trim(); }
interface Proc { pid: number; ppid: number; path: string; name: string; responsible_pid: number | null }
function procs(): Proc[] { return native(["procs"]) as Proc[]; }
const strip = (p: string) => (p.startsWith("/private/") ? p.slice(8) : p);

/** Every process the arm is responsible for: bundle path, isolated HOME, responsible pid, parent chain. */
function attributed(app: App, list = procs()): Proc[] {
  const roots = new Set<number>();
  const byPid = new Map(list.map((p) => [p.pid, p]));
  for (const p of list) {
    const path = strip(p.path ?? "");
    if (path.startsWith(strip(app.bundle)) || path.startsWith(strip(app.home))) roots.add(p.pid);
  }
  const ok = (p: Proc, depth = 0): boolean => {
    if (roots.has(p.pid)) return true;
    if (p.responsible_pid && p.responsible_pid !== p.pid && roots.has(p.responsible_pid)) return true;
    const parent = byPid.get(p.ppid);
    return !!parent && parent.pid > 1 && depth < 30 && ok(parent, depth + 1);
  };
  return list.filter((p) => p.pid > 1 && ok(p));
}
function isAgentServer(pid: number): boolean {
  return /volt-agent-server-main|bootstrap-fork|ELECTRON_RUN_AS_NODE|agentServer/.test(spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString());
}
function mainPid(app: App): number | null {
  const want = join(app.bundle, "Contents/MacOS/Electron");
  const list = procs().filter((p) => strip(p.path ?? "") === strip(want));
  const top = list.filter((p) => p.ppid === 1);
  const cands = (top.length ? top : list).filter((p) => !isAgentServer(p.pid));
  return cands.length ? Math.min(...cands.map((p) => p.pid)) : null;
}
async function killAll(app: App): Promise<void> {
  const bootout = () => {
    const label = voltLabel(app.ud);
    spawnSync(["launchctl", "bootout", `gui/${process.getuid!()}/${label}`]);
    for (const home of [app.home, "/Users/leularia"]) {
      const plist = `${home}/Library/LaunchAgents/${label}.plist`;
      if (existsSync(plist)) spawnSync(["rm", "-f", plist]);
    }
  };
  bootout();
  for (let round = 0; round < 3; round++) {
    if (round === 1) bootout();
    const pids = attributed(app).map((p) => p.pid).filter((p) => p !== process.pid);
    if (!pids.length) break;
    spawnSync(["kill", round < 2 ? "-TERM" : "-KILL", ...pids.map(String)]);
    await sleep(round < 2 ? 1500 : 500);
  }
  bootout();
}

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (m: any) => void>();
  static async connect(deadlineMs = 60_000): Promise<Cdp> {
    const end = Date.now() + deadlineMs;
    while (Date.now() < end) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(500) })).json() as any[];
        const idx = targets.findIndex((x) => x.type === "page" && /workbench(-dev)?\.html/.test(x.url));
        if (idx >= 0) {
          const c = new Cdp();
          c.ws = new WebSocket(targets[idx].webSocketDebuggerUrl);
          await new Promise((r, j) => { c.ws.addEventListener("open", r, { once: true }); c.ws.addEventListener("error", j, { once: true }); setTimeout(() => j(new Error("CDP open timeout")), 5000); });
          c.ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (m.id) { c.pending.get(m.id)?.(m); c.pending.delete(m.id); } });
          return c;
        }
      } catch { /* not up yet */ }
      await sleep(15);
    }
    throw new Error("CDP target not found");
  }
  send(method: string, params: any = {}, timeoutMs = 30_000): Promise<any> {
    return new Promise((r) => {
      const i = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(i); r({ error: "timeout" }); }, timeoutMs);
      this.pending.set(i, (m) => { clearTimeout(timer); r(m); });
      try { this.ws.send(JSON.stringify({ id: i, method, params })); } catch { clearTimeout(timer); this.pending.delete(i); r({ error: "closed" }); }
    });
  }
  async eval<T = any>(expr: string): Promise<T | undefined> {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    return r.result?.result?.value as T | undefined;
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

function hasProbePair(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase().replace(/[^a-z]/g, "");
  const ring = PROBE + PROBE;
  for (let i = 0; i < PROBE.length; i++) if (t.includes(ring.slice(i, i + 2))) return true;
  return false;
}
async function cdpKey(cdp: Cdp, key: string, code: string, vk: number, modifiers = 0, text?: string) {
  await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
}

/**
 * ADEMark's echo timer, DOM edition (round 3): a probe key every 50 ms +-20 %, Ready = first poll whose focused composer
 * (real, or the window snapshot's stand-in) holds a probe pair; it keeps polling until the real composer holds one too.
 */
async function domEcho(t0: bigint, timeoutMs: number): Promise<{ readyMs: number | null; readyFrom: string | null; readyRealMs: number | null; typed: number; cdp: Cdp | null }> {
  let cdp: Cdp | null = null;
  let done = false; let typed = 0; let i = 0;
  const typer = (async () => {
    while (!done) {
      if (cdp) {
        const ch = PROBE[i % PROBE.length]!;
        await cdpKey(cdp, ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0), 0, ch).catch(() => { });
        typed++; i++;
      }
      await sleep(50 * (0.8 + Math.random() * 0.4));
    }
  })();
  let readyMs: number | null = null; let readyFrom: string | null = null; let readyRealMs: number | null = null;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!cdp) { try { cdp = await Cdp.connect(200); } catch { /* */ } }
    if (cdp) {
      const a = nowNs();
      let c: { real: string | null; snap: string | null } | undefined;
      try { c = await cdp.eval(COMPOSER_TEXT); } catch { c = undefined; }
      const b = nowNs();
      const at = ms(t0, (a + b) / 2n);
      if (readyMs === null && (hasProbePair(c?.real) || hasProbePair(c?.snap))) { readyMs = at; readyFrom = hasProbePair(c?.real) ? "composer" : "snapshot"; }
      if (hasProbePair(c?.real)) { readyRealMs = at; break; }
    }
    await sleep(4);
  }
  done = true;
  await typer;
  return { readyMs, readyFrom, readyRealMs, typed, cdp };
}

/** The app's own marks, relative to t0 (wall clock ms): main marks handed to the window, then the renderer's. */
const MARKS = `(()=>{const c=globalThis.vscode?.context?.configuration?.(); const main={}; for(const m of (c?.perfMarks??[])) main[m.name]=m.startTime;
  const r={}; for(const m of performance.getEntriesByType('mark')) r[m.name]=Math.round(performance.timeOrigin+m.startTime);
  return {main, r, cached: c?.isCodeCaching ?? null}})()`;
function breakdown(m: any, t0Wall: number) {
  if (!m) return null;
  // Every mark, ms after t0 ("main:" marks are the main process's, as handed to the window; the rest the renderer's).
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.main ?? {})) if (typeof v === "number" && k !== "code/timeOrigin") out[`main:${k.replace(/^code\//, "")}`] = Math.round(v - t0Wall);
  for (const [k, v] of Object.entries(m.r ?? {})) if (typeof v === "number") out[k.replace(/^code\//, "")] = Math.round(v - t0Wall);
  return out;
}

async function quitApp(app: App): Promise<string> {
  const pid = mainPid(app);
  if (!pid) return "not running";
  try {
    const c = await Cdp.connect(3000);
    await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81, modifiers: 4 }, 2000);
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81, modifiers: 4 }, 2000);
    c.close();
  } catch { /* */ }
  for (let i = 0; i < 90; i++) { if (!mainPid(app)) return "cdp cmd+q"; await sleep(500); }
  spawnSync(["kill", "-TERM", String(pid)]);
  for (let i = 0; i < 20; i++) { if (!mainPid(app)) return "cdp cmd+q (then SIGTERM after 45 s)"; await sleep(500); }
  return "still running";
}

let OUT = "";
let GATE: { load1: number; waited_s: number; ok: boolean } | undefined;
function row(r: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), uptime: uptime(), ...r, load_gate: GATE });
  console.log(line);
  appendFileSync(join(OUT, "rows.jsonl"), line + "\n");
}
async function quiet() { return native(["idle", "--cpu-cores", process.env.ADE_QUIET_CORES ?? "3", "--quiet-ms", "1000", "--cap-s", "20"]); }

/** A1 (quit, then kill every attributed process and the agent server's launch agent) and A2 (quit only). */
async function launchTest(app: App, test: "A1" | "A2", rep: number) {
  const quitHow = mainPid(app) ? await quitApp(app) : "";
  if (test === "A1") await killAll(app);
  // A2 needs the agent server alive (it is in a real relaunch); record whether it is.
  const serverAlive = attributed(app).some((p) => isAgentServer(p.pid));
  const gate = await quiet();
  const win = spawn([WINWAIT, "--prefix", app.bundle, "--timeout-s", "60"], { stdout: "pipe" });
  await sleep(50);
  const t0 = nowNs(); const t0Wall = Date.now();
  spawnSync(launchArgv(app));
  const r = await domEcho(t0, 60_000);
  const w = JSON.parse((await new Response(win.stdout).text()).trim() || "{}");
  const windowMs = w.t_ns ? ms(t0, BigInt(w.t_ns)) : null;
  let marks: any = null;
  if (r.cdp) {
    marks = await r.cdp.eval(MARKS);
    // Clear the composer so the next launch restores an empty one.
    await cdpKey(r.cdp, "a", "KeyA", 65, 4); await cdpKey(r.cdp, "Backspace", "Backspace", 8);
    await sleep(300);
    r.cdp.close();
  }
  row({ app: app.id, test, rep, window_ms: windowMs, ready_ms: r.readyMs, ready_from: r.readyFrom, ready_real_ms: r.readyRealMs, method: "dom-echo, cdp keys", typed: r.typed, quit: quitHow,
    server_alive_before: serverAlive, gate_quiet: gate.quiet, gate_cores: gate.cores_last, marks: breakdown(marks, t0Wall), code_caching: marks?.cached ?? null });
}

async function loadGate(): Promise<{ load1: number; waited_s: number; ok: boolean }> {
  const limit = Number(process.env.ADE_LOAD_MAX ?? 14);
  const maxWait = Number(process.env.ADE_LOAD_WAIT_S ?? 1800);
  const t = Date.now();
  for (;;) {
    const load1 = Number(/load averages?: ([\d.]+)/.exec(uptime())?.[1] ?? 99);
    const waited = Math.round((Date.now() - t) / 1000);
    if (load1 <= limit) return { load1, waited_s: waited, ok: true };
    if (waited >= maxWait) return { load1, waited_s: waited, ok: false };
    await sleep(10_000);
  }
}

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const app = APPS[arg("--app")];
if (!app) { console.error(`--app one of ${Object.keys(APPS).join(", ")}`); process.exit(2); }
OUT = arg("--out", `${R4}/out/${app.id}`);
mkdirSync(OUT, { recursive: true });
if (argv.includes("--kill")) { await killAll(app); console.log("killed"); process.exit(0); }
if (argv.includes("--quit")) { console.log(await quitApp(app)); process.exit(0); }
if (argv.includes("--launch")) { spawnSync(launchArgv(app)); console.log("launched"); process.exit(0); }
if (argv.includes("--main-pid")) { console.log(mainPid(app)); process.exit(0); }
if (argv.includes("--attributed")) { console.log(attributed(app).map((p) => `${p.pid} ${p.ppid} ${p.path}`).join("\n")); process.exit(0); }

const tests = arg("--tests", "A1,A2").split(",");
const reps = Number(arg("--reps", "1"));
const start = Number(arg("--start", "1"));
for (let rep = start; rep < start + reps; rep++) {
  for (const t of tests) {
    GATE = await loadGate();
    if (!GATE.ok && process.env.ADE_LOAD_SKIP !== "0") { row({ app: app.id, test: t, rep, skipped: "load" }); continue; }
    try { await launchTest(app, t as "A1" | "A2", rep); } catch (e) { row({ app: app.id, test: t, rep, error: String(e) }); }
  }
}
void readFileSync; void ARENA;
