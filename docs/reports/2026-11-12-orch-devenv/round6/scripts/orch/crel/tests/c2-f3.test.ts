// C2-F3, own test: list summaries have dueOn equal to the correct due date, and due with the same value.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api.ts";
import { dueDate } from "../src/dates.ts";
import { sampleInvoices } from "../src/invoices.ts";

test("C2-F3: GET /invoices summaries have dueOn and the deprecated alias due with the same value", () => {
  const invoices = sampleInvoices(12, 7);
  const instance = createApp({ invoices } as never);
  const r = instance.handle({ method: "GET", path: "/invoices", headers: {} });
  assert.equal(r.status, 200);
  const items = (r.body as { items: Array<Record<string, unknown>> }).items;
  assert.ok(items.length > 0);
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  for (const item of items) {
    const invoice = byId.get(String(item.id));
    assert.ok(invoice, `unknown invoice ${item.id}`);
    assert.equal(item.dueOn, dueDate(invoice), `dueOn of ${item.id}`);
    assert.equal(item.due, item.dueOn, `due alias of ${item.id}`);
  }
});
