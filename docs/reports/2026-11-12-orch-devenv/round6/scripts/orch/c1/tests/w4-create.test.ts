// C1-style, own tests (not ADEMark's hidden tests): W4 POST /invoices (creation and validation).
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api.ts";
import { sampleInvoices } from "../src/invoices.ts";

const VALID = {
  client: "Initech",
  issued: "2026-03-01",
  netDays: 30,
  currency: "EUR",
  items: [{ description: "Audit", quantity: 2, unitPriceCents: 12_500, taxRate: 0.21 }],
};

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", path: "/invoices", headers: { "content-type": "application/json", ...headers }, body });

test("W4-create: a valid body creates the next invoice: 201, location, draft by default", () => {
  const app = createApp({ invoices: sampleInvoices(57) });
  const response = app.handle(post(VALID) as never);
  assert.equal(response.status, 201);
  const invoice = response.body as Record<string, unknown>;
  assert.equal(invoice.id, "INV-01058");
  assert.equal(response.headers.location, "/invoices/INV-01058");
  assert.equal(invoice.status, "draft");
  assert.equal(invoice.client, "Initech");
  assert.deepEqual(invoice.items, VALID.items);
  const fetched = app.handle({ method: "GET", path: "/invoices/INV-01058", headers: {} } as never);
  assert.equal(fetched.status, 200);
  assert.equal((fetched.body as { id: string }).id, "INV-01058");
  const second = app.handle(post({ ...VALID, status: "sent" }) as never);
  assert.equal((second.body as { id: string }).id, "INV-01059");
  assert.equal((second.body as { status: string }).status, "sent");
});

test("W4-create: the id follows the highest existing id, not the count", () => {
  const invoices = sampleInvoices(3);
  invoices[1] = { ...invoices[1]!, id: "INV-04100" };
  const app = createApp({ invoices });
  assert.equal((app.handle(post(VALID) as never).body as { id: string }).id, "INV-04101");
});

test("W4-create: an invalid body is 400 invalid_invoice with a message", () => {
  const app = createApp({ invoices: sampleInvoices(3) });
  const bad: unknown[] = [
    undefined,
    null,
    [],
    "text",
    { ...VALID, client: "" },
    { ...VALID, client: 3 },
    { ...VALID, issued: "2026-3-1" },
    { ...VALID, issued: undefined },
    { ...VALID, netDays: -1 },
    { ...VALID, netDays: 1.5 },
    { ...VALID, currency: "GBP" },
    { ...VALID, items: [] },
    { ...VALID, items: [{ ...VALID.items[0], quantity: 0 }] },
    { ...VALID, items: [{ ...VALID.items[0], quantity: 1.5 }] },
    { ...VALID, items: [{ ...VALID.items[0], unitPriceCents: -1 }] },
    { ...VALID, items: [{ ...VALID.items[0], taxRate: 1.5 }] },
    { ...VALID, items: [{ ...VALID.items[0], taxRate: -0.1 }] },
    { ...VALID, status: "archived" },
  ];
  for (const body of bad) {
    const response = app.handle(post(body) as never);
    assert.equal(response.status, 400, JSON.stringify(body));
    const error = response.body as { error: string; message: unknown };
    assert.equal(error.error, "invalid_invoice");
    assert.equal(typeof error.message, "string");
  }
  assert.equal((app.handle(post(VALID) as never).body as { id: string }).id, "INV-01004", "nothing was created by the bad ones");
});

test("W4-create: other methods still 405, GET still works", () => {
  const app = createApp({ invoices: sampleInvoices(3) });
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    assert.equal(app.handle({ method, path: "/invoices", headers: {} } as never).status, 405, method);
  }
  assert.equal(app.handle({ method: "GET", path: "/invoices/INV-01001", headers: {} } as never).status, 200);
});
