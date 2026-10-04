# STRUCTURE — target layout for the refactor

`src/mega.mjs` grew into a tangle. Split it by responsibility — behavior must
not change (CONTRACT.md and the suite stay exactly as they are):

```
src/
  errors.mjs    // ApiError only
  config.mjs    // resolveConfig only
  backoff.mjs   // the delay table + delayForAttempt only
  client.mjs    // createClient (imports the three modules above)
  index.mjs     // public entry: re-exports createClient, ApiError,
                // resolveConfig, delayForAttempt
```

Hard requirements:

- `src/mega.mjs` is **deleted**.
- Each module owns exactly one concern; no module re-exports another concern's
  code "to keep it simple".
- No `src/*.mjs` file longer than **80 lines**.
- `src/index.mjs` stays the only public entry: `consumer.mjs` keeps importing
  from `./src/index.mjs` and must not change.
- The visible suite stays green without editing `test/`.
