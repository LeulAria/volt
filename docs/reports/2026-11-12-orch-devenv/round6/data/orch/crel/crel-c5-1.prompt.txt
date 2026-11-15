In the Ledger repository, replace page-number pagination with cursor pagination. Work alone in this thread and do not start other agents. Read AGENTS.md first.

GET /invoices currently uses page numbers and repeats one invoice between pages.
- The request becomes GET /invoices?limit=<n>&cursor=<c>. limit is an integer from 1 to 100, default 20. Any other limit returns 400 { "error": "bad_request" }.
- Items are ordered by id, ascending, and keep the current summary shape.
- The response body is { "items": [...], "nextCursor": string | null, "limit": n }. nextCursor is null on the last page.
- The cursor is an opaque string. A malformed cursor returns 400 { "error": "bad_cursor" }.
- The page and pageSize parameters return 400 { "error": "use_cursor" }.
- Keep paginate() exported from src/paginate.ts and fix it: a page has at most pageSize items, and hasNext is false on the last page.

Do not change or delete existing files in test/. Run npm test before you finish.
