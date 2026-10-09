Here is the patch:

```diff
diff --git a/src/users.ts b/src/users.ts
index 3f2a1b9..8c4d2e0 100644
--- a/src/users.ts
+++ b/src/users.ts
@@ -11,9 +11,12 @@ export async function loadUser(id: string) {
-  const res = await fetch(`/api/users/${id}`);
-  const body = await res.json();
-  if (!res.ok) {
-    throw new Error(body.message);
-  }
+  const res = await fetch(`/api/users/${encodeURIComponent(id)}`);
+  if (res.status === 404) {
+    return undefined;
+  }
+  if (!res.ok) {
+    throw new Error(`Failed to load user ${id}: ${res.status}`);
+  }
+  const body = await res.json();
   return body as User;
 }
diff --git a/src/routes/users.ts b/src/routes/users.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/routes/users.ts
+++ b/src/routes/users.ts
@@ -28,7 +28,10 @@ router.get('/users/:id', async (req, res) => {
-  const user = await loadUser(req.params.id);
-  res.json(user);
+  const user = await loadUser(req.params.id);
+  if (!user) {
+    return res.status(404).json({ error: 'not found' });
+  }
+  res.json(user);
 });
```
