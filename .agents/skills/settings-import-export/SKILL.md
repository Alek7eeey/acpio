---
name: settings-import-export
description: Add or change an app setting — keep the settings file (Export/Import) in sync, and keep credentials out of it.
---

# A setting travels through the settings file

Every setting of this app is meant to move between installs: **Export** and
**Import** in the Settings header (`apps/web/src/pages/SettingsPage.tsx`) call
`GET /api/settings/export` / `POST /api/settings/import` (`apps/server/src/routes.ts`),
which are `buildSettingsFile()` and `importSettingsFile()`
(`apps/server/src/services/settings.ts`).

That path is silent on both ends: the export writes whatever the settings
object holds, the import keeps only the keys it recognises. A setting that is
not wired into it is simply absent from the file — no error, no warning, and
the receiving machine never gets it.

**So a setting is not done until Export carries it and Import applies it.**
When you add a setting or change what one holds, walk this list and touch every
place the existing ones use.

## Where a new setting has to appear

1. **`AppSettings` + `DEFAULT_SETTINGS`** — `packages/shared/src/index.ts`.
   Import whitelists its keys from `DEFAULT_SETTINGS` (`SETTING_KEYS` in
   `settings.ts`): a key missing there is dropped on import.
2. **`settingsSchema`** — `apps/server/src/routes.ts` (the zod object above
   `PUT /api/settings`). Zod strips unknown keys, so a setting missing here is
   never saved from the UI either.
3. **Merge / healing** — `mergeSettings` (`services/settings.ts`) or a
   normalizer in `packages/shared/src/appSettingsMerge.ts`, so a value that
   arrives from an older file is repaired instead of stored as sent.
4. **`afterSettingsWrite`** — `apps/server/src/routes.ts`. Drop caches and
   restart live sessions here, not in the PUT handler: both write paths go
   through it, "so an import reaches as far as a Save". A new switch that a
   running chat reads needs its branch there.
5. **The control itself** — the section/leaf in
   `apps/web/src/lib/settingsNav.ts` (`SettingsPage.tsx` renders it), with the
   label and hint in `apps/web/src/lib/i18n-messages/{en,ru}.json` **and**
   `packages/i18n/src/messages/{en,ru}.ts`.

## Credentials never travel

The file goes from one person (or machine) to another, so it describes what a
thing **is** and never what it pays with. An import must leave the local wallet
untouched.

- A new top-level secret → add it to `SECRET_SETTING_KEYS`
  (`services/settings.ts`); `stripSecrets` deletes it in both directions, so a
  hand-edited file cannot overwrite the local one any more than an export can
  leak it.
- A new list of rows that carries a secret per row (the payment of an endpoint,
  a token on a server) → strip it in `stripSecrets` **and** give the local row's
  value back in `withLocalSecrets`, keyed by the row id. A row the local install
  does not know arrives without one — that is the importing user's to fill.
- One user's own text (drafts and the like) → delete it in `stripSecrets`, the
  way `composerDrafts` is deleted. It is not a setting anyone inherits.
- What a plugin contributes (`pluginProviders`, `pluginSkills`) stays out: the
  export reads `readStoredSettings()`, never `getSettings()`. Do not "fix" that.

`SETTINGS_FILE_KIND` / `SETTINGS_FILE_VERSION` change only when the shape of
the file itself changes; a new key does not need a version bump.

## Verifying the round trip

Do not stop at "the field is in the form". Check the file:

1. Set the new value, export, read the JSON. The value is under `settings`; no
   API key, token, header or env of the install is in it.
2. Import that file back (another install, or this one after clearing the
   value). The value lands, `applied` in the response names the key, the toast
   counts it, and anything that must restart/cache-drop did.
3. Hand-edit an exported file to carry a credential (`apiKey`, `token`,
   `headers`, `env`, a top-level key) and import it. The local credential
   survives unchanged.
