Here are several code blocks in different languages.

```typescript
interface User {
  id: string;
  name: string;
  roles: ReadonlyArray<'admin' | 'member'>;
}

export async function loadUser(id: string, signal?: AbortSignal): Promise<User | undefined> {
  const res = await fetch(`/api/users/${encodeURIComponent(id)}`, { signal });
  if (res.status === 404) {
    return undefined;
  }
  if (!res.ok) {
    throw new Error(`Failed to load user ${id}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as User;
}
```

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class Point:
    x: float
    y: float

    def dist(self, other: "Point") -> float:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5
```

```rust
fn fib(n: u64) -> u64 {
    match n {
        0 | 1 => n,
        _ => fib(n - 1) + fib(n - 2),
    }
}
```

```bash
npm ci && npm run build -- --mode production 2>&1 | tee build.log
```

```
plain fenced block without a language
    indentation is preserved
```

A very long line that should scroll horizontally instead of wrapping:

```js
const veryLongLine = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon'].map(s => s.toUpperCase()).join(' | ');
```
