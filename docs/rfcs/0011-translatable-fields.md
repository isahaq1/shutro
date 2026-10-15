# RFC 0011 — Translatable fields

- **Status:** Accepted (2026-10-15)
- **Scope:** `@shutro/i18n` (pure rules), `@shutro/core` (`translate: true` fields, reads, writes, search)
- **Related:** 0001 §7.3 (`translate` attribute), 0003 (`env.lang`, `withLang`), 0004 §7.4 (cache keys), 0005 §7.4 (translation projection)
- **Resolves:** "translation storage details: i18n RFC" (0001 §12)

## 1. Summary

A `char` / `text` / `html` field declared `translate: true` is stored as one JSONB column mapping language codes to
text (`{"en_US": "Laptop", "bn_BD": "ল্যাপটপ"}`). Reads return the text for `env.lang`, falling back to the
**source language** (`createShutro({ sourceLang })`, default `en_US`), then to any translation. Writes in a language
set that language (and the source when the record has none yet); a map sets several at once. Filters and sorts on the
field use the same resolution in SQL (`COALESCE(col->>lang, col->>source)`), so what you search is what you see.
The cache holds the whole map once per record: `withLang` environments share it and never refetch.

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | Product names, UoM names, payment terms, tax names and report labels are shown in the user's language. |
| R2  | A record with no translation in the user's language still shows something (the source text), never `null` or a key. |
| R3  | Searching "ল্যাপটপ" in a Bengali session finds the product; sorting by name sorts by the displayed name. |
| R4  | Writing a translation does not touch the other languages; bulk imports can set many languages in one write. |
| R5  | No extra table or join on every read; no refetch when the language changes within a transaction. |
| R6  | Modules and the type generator see a translatable field as a string field with a richer write type. |

## 3. How Odoo does it

Odoo ≤ 15 kept translations in `ir_translation` (one row per field, record and language), joined on every read and
written through a separate API. Odoo 16 moved to **JSONB columns** (`{"en_US": ..., "fr_FR": ...}`) with `->>lang`
projection and a fallback to `en_US`, and `write()` in a language updates that key. That design is adopted here, with
the source language made explicit and configurable instead of hard-coded `en_US`.

## 4. Prior art

| | |
| - | - |
| Django-modeltranslation | One column per language (`name_en`, `name_fr`): schema changes per language. |
| Prisma / Drizzle | Nothing; applications use JSON columns by hand. |
| Rails Mobility | Pluggable backends incl. a JSONB one; fallbacks configurable. The JSONB backend is what Odoo 16 and this RFC use. |

## 5. Options

- **A — Side table** (Odoo ≤ 15): joins on every read, a second write path, cache keyed per language. Rejected.
- **B — JSONB column** (chosen): one column, one cache entry, resolution in memory on read and in SQL for filters.
- **C — Column per language**: migrations per language. Rejected.

## 6. Decision

Option B, with the rules in `@shutro/i18n` as pure functions (`resolveTranslation`, `mergeTranslation`) that core
applies and applications can reuse for their own JSON.

## 7. Detailed design

### 7.1 Declaration and schema

`f.char({ translate: true })`, `f.text({ translate: true })`, `f.html({ translate: true })`: column type `jsonb`.
`required` applies to the map (a record needs a text in some language), not to every language.

### 7.2 Reads

`record.name` is `resolveTranslation(map, env.lang, sourceLang)`: `map[lang]`, else `map[source]`, else the first
translation by sorted language code, else `null`. `record.translations('name')` returns the whole map.

### 7.3 Writes

`write({ name: 'ল্যাপটপ' })` in `bn_BD` merges `{ bn_BD }` into the map and fills `en_US` when the record has no
source text yet. `write({ name: { fr_FR: 'Portable', de_DE: 'Laptop' } })` sets those languages. Malformed maps (keys
that aren't language codes, non-string values) are a `ValidationError`. The same applies to `create()`, computed
assignments and onchange drafts.

### 7.4 Search and order

Domain conditions and `order` entries on a translated field compile to `COALESCE(col->>$lang, col->>$source)`, so
`{ name: { ilike: 'ল্যাপ%' } }` matches in a Bengali session and `order: ['name']` sorts by the displayed name.
Searching for text that exists only in a third language is not matched (the SQL fallback is one level deep; the
in-memory read goes further). `pg_trgm` indexes on translated fields need expression indexes and come with the
full domain compiler.

### 7.5 Cache

The map is cached under the field key (not per language, unlike RFC 0004 §7.4's sketch): `withLang` environments
share the cache, and a write in one language is visible to readers of every language immediately.

### 7.6 Types

`F.Char<{ translate: true }>` and the builders give the field the write type `string | Translations`
(`TextWrite<O>`); the read type stays `string`. `TranslatedKeys<S, M>` lists the translatable fields of a model.

## 8. Type-level guarantees

`write({ name: { bn_BD: 'x' } })` is accepted only for translatable fields; `record.translations(key)` only takes
translatable keys.

## 9. Runtime metadata

`describe()` reports `translate: true` and `pgType: 'jsonb'`.

## 10. Interactions

- **0005:** the projection rule in §7.4 ("translated columns are selected as COALESCE") is replaced by selecting the
  JSONB and resolving in memory; filters and sorts use COALESCE as specified.
- **Security:** field-level rules apply to the field, not per language.
- **Audit:** tracking a translated field records the map diff.

## 11. Resolved questions

1. **Per-language cache keys (0004 §7.4)?** No: caching the map is simpler and never refetches.
2. **Hard-coded `en_US` fallback (0005 §7.4)?** Replaced by `sourceLang` on `createShutro`.

## 12. Deferred

- UI term catalogs (translating labels, selection values, messages): a later i18n step.
- `tsvector` / trigram indexes on translated fields.
- Per-language `required` and a "needs translation" report.
