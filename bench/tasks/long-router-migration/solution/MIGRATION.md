# Migration: legacy router → tiny-http

The legacy callback router (`lib/legacy/router.mjs`) is being retired. Migrate
everything under `app/` to the shared `lib/tiny-http.mjs` framework. **Do not
modify `lib/`** — both routers are shared infrastructure used by other
services.

## What changes

- Callback-style handlers `(req, reply)` become handlers that **return** the
  response: a bare object means `200`, `{ status, body }` overrides.
- `lib/legacy` has no middleware. The admin token check is currently
  copy-pasted into every admin handler; on tiny-http it must become **one
  `app.use(...)` middleware** guarding `/admin/*`.
- `app/server.mjs` keeps exporting `handle(req)` returning `{ status, body }`
  — callers and the test harness depend on that shape.

## Behavior contract (must hold exactly, same as today)

| request | response |
|---|---|
| GET /health | 200 `{"status":"ok"}` |
| GET /metrics | 200 `{"requests":0}` |
| POST /echo (body `"hi"`) | 200 `{"echo":"hi"}` |
| GET /users | 200, all users |
| GET /users?limit=2 | 200, first two |
| GET /users?limit=0 or limit=abc | 400 `{"error":"bad_limit"}` |
| GET /users/:id | 200 `{"user":{...}}` or 404 `{"error":"user_not_found"}` |
| GET /orders | 200, all orders |
| GET /orders?userId=u1 | 200, only that user's orders (unknown id → empty list) |
| GET /admin/stats + valid `x-admin-token` | 200 `{"users":3,"orders":3}` |
| GET /admin/stats without/wrong token | 401 `{"error":"unauthorized"}` |
| POST /admin/message + token, JSON `{"text":"hi"}` | 200 `{"queued":"hi"}` |
| POST /admin/message + token, malformed JSON | 400 `{"error":"bad_json"}` |
| anything else (unknown path or method) | 404 `{"error":"not_found"}` |

Notes:

- `/users/` (trailing empty segment) must not match `/users` or `/users/:id`.
- Query values are strings; `limit` validation is on the raw string.
- After the migration nothing under `app/` may import from `lib/legacy`.
