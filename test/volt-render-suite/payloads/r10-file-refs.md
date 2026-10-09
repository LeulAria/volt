The bug is in `src/users.ts:14`, where `loadUser` reads `res.json()` before checking the status. Related code lives in src/routes/users.ts and `package.json`.

```14:18:src/users.ts
  const res = await fetch(`/api/users/${id}`);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.message);
  }
```

See the docs at https://nodejs.org/api/fetch.html and the [MDN page](https://developer.mozilla.org/en-US/docs/Web/API/Response/ok). Also check `./README.md` and `/etc/hosts`.
