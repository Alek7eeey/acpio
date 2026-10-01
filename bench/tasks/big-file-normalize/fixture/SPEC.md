# Email format spec

Every record in `users.ndjson` (NDJSON: one JSON object per line) must have its
`email` fully lowercase and of the form `user<id>@example.<tld>`, where `<id>`
matches the record's own `id` field and `<tld>` is one of `com`, `net`, `org`.

The `id` and `name` fields are correct and must not change. The line count is
correct and must not change.
