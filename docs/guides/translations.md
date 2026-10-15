# Translatable fields

[RFC 0011](../rfcs/0011-translatable-fields.md). A text field with `translate: true` stores a map of language → text
in one JSONB column; you read and write it like a string in the environment's language.

```ts
export const ProductTemplate = defineModel('product.template', {
  order: ['name'],
  fields: {
    name: f.char({ required: true, translate: true }),
    description: f.text({ translate: true }),
  },
});

const shutro = createShutro({ driver, registry, sourceLang: 'en_US' });   // the fallback language (default en_US)
```

```ts
await shutro.run({ user, company, lang: 'en_US' }, async (env) => {
  const laptop = (await env.model('product.template').create([{ name: 'Laptop' }])).first();
  laptop.name;                                      // 'Laptop'

  const bn = env.withLang('bn_BD');                 // same transaction, same cache
  await bn.model('product.template').browse([laptop.id]).load().then((p) => p.write({ name: 'ল্যাপটপ' }));
  laptop.name;                                      // 'Laptop'  (en_US)
  (await bn.model('product.template').browse([laptop.id]).load()).first().name;   // 'ল্যাপটপ'
  env.withLang('fr_FR')...name;                     // 'Laptop'  (no fr_FR text: falls back to the source language)

  laptop.translations('name');                      // { en_US: 'Laptop', bn_BD: 'ল্যাপটপ' }
  await laptop.write({ name: { fr_FR: 'Portable', de_DE: 'Laptop' } });   // several languages at once
});
```

Rules:

- **Read**: the environment language, else the source language, else the first translation, else `null`.
- **Write** a string: sets the environment language, and the source language too when the record has no source
  text yet (so readers of other languages see the new text). Write a map: sets exactly those languages. Malformed
  maps are a `ValidationError`.
- **Search and order** on a translated field use `COALESCE(col->>lang, col->>source)` in SQL, so
  `{ name: { ilike: 'ল্যাপ%' } }` matches in a Bengali session and `order: ['name']` sorts by what users see.
- **Cache**: one map per record, shared by every `withLang` environment of the transaction.
- **Types**: the read type is `string`; the write type is `string | Translations`; `record.translations(key)` takes
  translatable keys only.

`@shutro/i18n` exports the pure rules (`resolveTranslation`, `mergeTranslation`, `isTranslations`) for your own JSON.
