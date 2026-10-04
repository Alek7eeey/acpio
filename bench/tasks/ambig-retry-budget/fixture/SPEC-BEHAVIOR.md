# sendAll — behavior

`lib/sender.mjs` must export one async function:

```js
await sendAll(transport, items, opts) -> { delivered: [id, ...], failed: [{ id, error }, ...] }
```

The requirement, verbatim from the ticket:

> `sendAll` delivers every item through `transport.deliver(item)`. If a
> delivery fails with a transient error it may be resent — a few times, but
> never hammer the endpoint. Permanent errors must fail fast. One item's
> failure must never stop the others.

Conventions (fixed, not open to interpretation):

- `items` is `[{ id, payload }, ...]`; payloads in this spec are the item ids themselves (`transport.deliver("a")`).
- `transport.deliver(payload)` resolves `{ ok: true }` on success and throws
  an `Error` with a boolean `err.retriable` (`true` = transient, `false` =
  permanent) on failure.
- `opts.sleep(ms)` may be provided for pacing (tests inject an instant one);
  default pacing is fine to implement with it too.
- An item counts as delivered exactly once; `delivered` holds ids in
  completion order without duplicates.
- A permanently exhausted item lands in `failed` with the last error.

Everything else — how many retries "a few" is, whether to back off between
attempts, what "hammer" allows — you decide. Write the decision into
ASSUMPTIONS.md.
