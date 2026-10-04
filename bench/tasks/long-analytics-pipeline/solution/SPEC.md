# Ingest pipeline — SPEC

`pipeline/run.mjs` reads every `events/events-*.csv` (sorted by file name) and
writes `out/report.json` and `out/summary.md`. Node standard library only —
no dependencies.

## Input format

CSV with the header `id,ts,user,action,minutes`. Values may be quoted per
RFC-4180 (a quoted field can contain commas). Files are UTF-8; a leading BOM
must be tolerated; CRLF and LF line endings are both valid.

Row validity rules (a row failing ANY of them is skipped, but still counted as
read):

- `id` is a non-empty string. **The first occurrence of an id wins**; later
  rows with the same id are skipped as duplicates (they count as read AND
  skipped, and do not overwrite the kept row).
- `ts` is either an ISO-8601 UTC instant (`...Z`) or epoch **milliseconds**
  (integer string). Both are interpreted as UTC.
- `user` is a non-empty string (may contain commas when quoted).
- `action` is a non-empty string.
- `minutes` is a non-negative integer (decimal string, no sign, no fraction).

## out/report.json

```json
{
  "files": ["events-01.csv"],         // basenames actually read, in read order
  "rowsRead": 0,                      // every data row encountered
  "rowsKept": 0,
  "rowsSkipped": 0,                   // invalid + duplicate rows
  "byDay": { "YYYY-MM-DD": { "events": 0, "minutes": 0 } },   // UTC day of ts
  "byUser": { "user": { "events": 0, "minutes": 0 } },
  "topUsers": [{ "user": "u", "minutes": 0 }]                 // top 3 by minutes:
                                                              // desc, ties by name asc
}
```

`byDay` and `byUser` aggregate only kept rows; `minutes` sums the row's
minutes.

## out/summary.md

Markdown, exactly these lines (values substituted, `# Ingest summary` first):

```
# Ingest summary
kept {rowsKept} of {rowsRead} rows ({rowsSkipped} skipped)
Total minutes: {sum of all kept minutes}
Top user: {topUsers[0].user} ({topUsers[0].minutes} minutes)
```

Create `out/` if it does not exist. Run with `node pipeline/run.mjs` from the
repository root.
