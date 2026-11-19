// C1-style, own tests (not ADEMark's hidden tests): W2 timezone drift. Each zone runs in its own process.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dates = fileURLToPath(new URL("../src/dates.ts", import.meta.url));

const PROBE = `
const d = await import(${JSON.stringify(dates)});
const out = {
  due: d.dueDate({ issued: "2026-03-01", netDays: 30 }),
  dueLeap: d.dueDate({ issued: "2024-02-15", netDays: 14 }),
  springForward: d.addDays("2026-03-08", 1),
  fallBack: d.addDays("2026-11-01", 1),
  yearEnd: d.addDays("2026-12-31", 1),
  back: d.addDays("2026-03-01", -1),
  zero: d.addDays("2026-06-15", 0),
  roundTrip: d.formatDay(d.parseDay("2026-03-01")),
  overdue2: d.daysOverdue({ issued: "2026-03-01", netDays: 30 }, "2026-04-02"),
  overdueDst: d.daysOverdue({ issued: "2026-03-01", netDays: 0 }, "2026-03-10"),
  notYet: d.daysOverdue({ issued: "2026-03-01", netDays: 30 }, "2026-03-20"),
  onDue: d.isOverdue({ issued: "2026-03-01", netDays: 30 }, "2026-03-31"),
  dayAfter: d.isOverdue({ issued: "2026-03-01", netDays: 30 }, "2026-04-01"),
  invalid: (() => { try { d.parseDay("not-a-day"); return "no throw"; } catch (e) { return e instanceof RangeError ? "RangeError" : String(e); } })(),
};
console.log(JSON.stringify(out));
`;

const EXPECTED = {
  due: "2026-03-31",
  dueLeap: "2024-02-29",
  springForward: "2026-03-09",
  fallBack: "2026-11-02",
  yearEnd: "2027-01-01",
  back: "2026-02-28",
  zero: "2026-06-15",
  roundTrip: "2026-03-01",
  overdue2: 2,
  overdueDst: 9,
  notYet: 0,
  onDue: false,
  dayAfter: true,
  invalid: "RangeError",
};

for (const zone of ["America/Los_Angeles", "UTC", "Asia/Tokyo", "Pacific/Kiritimati", "America/St_Johns"]) {
  test(`W2-dates: the same results in ${zone}`, () => {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", PROBE], { env: { ...process.env, TZ: zone }, encoding: "utf8" });
    assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)!), EXPECTED);
  });
}

test("W2-dates: the repository has tests for Los Angeles, UTC and Tokyo", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const text = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.startsWith("hidden-")).map((name) => readFileSync(dir + name, "utf8")).join("\n");
  for (const zone of ["America/Los_Angeles", "UTC", "Asia/Tokyo"]) {
    assert.ok(text.includes(zone), `no test names ${zone}`);
  }
});
