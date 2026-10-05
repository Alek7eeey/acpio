# Changelog

## Unreleased

### Added

- webhook signing with HMAC (#153)

### Fixed

- webhook retries used seconds instead of ms (#155)
- stale cursor after the first page (#156)

## v1.4.0 - 2026-09-28

### Added

- --format json for the export command (#140)

### Changed

- **BREAKING:** drop node 18, engines now require node >= 20 (#144)

### Fixed

- retry storm when the provider answers 429 (#138)
- export crashed on empty result sets (#141)
- timezone drift in the nightly rollup (#149)

### Performance

- batched inserts cut the nightly sync by 60% (#147)

### Docs

- rewrite the quickstart (#151)

## v1.3.0 - 2026-08-30
