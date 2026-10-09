JSON:

```json
{
  "service": "orders",
  "version": "2.4.1",
  "replicas": 3,
  "healthy": true,
  "limits": { "cpu": "500m", "memory": "512Mi" },
  "endpoints": [
    { "path": "/orders", "methods": ["GET", "POST"] },
    { "path": "/orders/:id", "methods": ["GET", "PATCH", "DELETE"] }
  ],
  "owner": null
}
```

YAML:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
  labels: { app: orders, tier: backend }
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: orders
          image: ghcr.io/acme/orders:2.4.1
          ports: [{ containerPort: 8080 }]
```

Terminal output:

```console
$ npm test

> orders@2.4.1 test
> vitest run

 ✓ src/orders.test.ts (12 tests) 41ms
 ✗ src/billing.test.ts (3 tests | 1 failed) 18ms
   × charges the right amount
     → expected 4200 to be 4199

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 14 passed (15)
```

A stack trace:

```text
TypeError: Cannot read properties of undefined (reading 'id')
    at loadUser (src/users.ts:14:22)
    at async handler (src/routes/users.ts:31:18)
    at async Server.<anonymous> (node_modules/express/lib/router/index.js:284:7)
```
