// C1-style, own tests (not ADEMark's hidden tests): W3 cursor pagination and the paginate() fix.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api.ts";
import { sampleInvoices } from "../src/invoices.ts";
import type { Invoice } from "../src/invoices.ts";
import { paginate } from "../src/paginate.ts";

type PageBody = { items: { id: string }[]; nextCursor: string | null; limit: number };
const get = (path: string) => ({ method: "GET", path, headers: {} });

function walk(handle: (request: { method: string; path: string; headers: Record<string, string> }) => { status: number; body: unknown }, limit: number, between?: (page: number) => void): string[] {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const query = `limit=${limit}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const response = handle(get(`/invoices?${query}`));
    assert.equal(response.status, 200);
    const body = response.body as PageBody;
    assert.equal(body.limit, limit);
    assert.ok(body.items.length <= limit);
    ids.push(...body.items.map((item) => item.id));
    if (body.nextCursor === null) {
      return ids;
    }
    between?.(page);
    cursor = body.nextCursor;
  }
  throw new Error("no last page");
}

test("W3-cursor: the first page by default: 20 items in id order, the summary shape, a next cursor", () => {
  const invoices = sampleInvoices(57).reverse();
  const app = createApp({ invoices });
  const response = app.handle(get("/invoices"));
  assert.equal(response.status, 200);
  const body = response.body as PageBody & { items: Record<string, unknown>[] };
  assert.equal(body.limit, 20);
  assert.equal(body.items.length, 20);
  assert.equal(typeof body.nextCursor, "string");
  const sorted = sampleInvoices(57).map((invoice) => invoice.id).sort();
  assert.deepEqual(body.items.map((item) => item.id), sorted.slice(0, 20));
  assert.deepEqual(Object.keys(body.items[0]!).sort(), ["client", "currency", "due", "id", "status", "totalCents"]);
});

test("W3-cursor: following nextCursor returns every invoice once and ends with null", () => {
  const app = createApp({ invoices: sampleInvoices(57) });
  for (const limit of [1, 7, 20, 57, 100]) {
    const ids = walk(app.handle, limit);
    assert.deepEqual(ids, sampleInvoices(57).map((invoice) => invoice.id), `limit ${limit}`);
  }
});

test("W3-cursor: invoices added between requests do not repeat or drop the ones that existed", () => {
  const invoices: Invoice[] = sampleInvoices(30);
  const before = invoices.map((invoice) => invoice.id);
  const app = createApp({ invoices });
  const template = invoices[0]!;
  const ids = walk(app.handle, 7, (page) => {
    invoices.push({ ...template, id: `INV-0${String(9000 + page)}` });
    invoices.push({ ...template, id: `INV-00${String(100 + page)}` });
  });
  for (const id of before) {
    assert.equal(ids.filter((seen) => seen === id).length, 1, id);
  }
  assert.equal(new Set(ids).size, ids.length, "no id twice");
});

test("W3-cursor: limit is an integer from 1 to 100", () => {
  const app = createApp({ invoices: sampleInvoices(5) });
  for (const limit of ["0", "101", "abc", "1.5", "-3"]) {
    const response = app.handle(get(`/invoices?limit=${limit}`));
    assert.equal(response.status, 400, `limit=${limit}`);
    assert.equal((response.body as { error: string }).error, "bad_request");
  }
  assert.equal(app.handle(get("/invoices?limit=100")).status, 200);
});

test("W3-cursor: a malformed cursor is bad_cursor", () => {
  const app = createApp({ invoices: sampleInvoices(5) });
  for (const cursor of ["!!!", "not-a-cursor"]) {
    const response = app.handle(get(`/invoices?cursor=${cursor}`));
    assert.equal(response.status, 400, cursor);
    assert.equal((response.body as { error: string }).error, "bad_cursor");
  }
});

test("W3-cursor: page and pageSize are refused with use_cursor", () => {
  const app = createApp({ invoices: sampleInvoices(5) });
  for (const query of ["page=2", "pageSize=5", "page=1&pageSize=5"]) {
    const response = app.handle(get(`/invoices?${query}`));
    assert.equal(response.status, 400, query);
    assert.equal((response.body as { error: string }).error, "use_cursor");
  }
});

test("W3-cursor: paginate() keeps at most pageSize items and hasNext is false on the last page", () => {
  const all = Array.from({ length: 10 }, (_, index) => index + 1);
  const first = paginate(all, 1, 3);
  assert.deepEqual(first.items, [1, 2, 3]);
  assert.equal(first.hasNext, true);
  assert.equal(first.totalPages, 4);
  assert.deepEqual(paginate(all, 3, 3).items, [7, 8, 9]);
  const last = paginate(all, 4, 3);
  assert.deepEqual(last.items, [10]);
  assert.equal(last.hasNext, false);
  const exact = paginate(all.slice(0, 9), 3, 3);
  assert.deepEqual(exact.items, [7, 8, 9]);
  assert.equal(exact.hasNext, false);
  assert.throws(() => paginate(all, 0, 3), RangeError);
});
