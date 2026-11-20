# rxdb-effect-schema

Author an RxDB collection schema once, as an Effect Schema, and convert it into an `RxJsonSchema`.

This package is the **authoring companion** to the RxDB `validate-effect` plugin. The split is deliberate:

- **RxDB's core `validate-effect` plugin** is the *validator*. It imports the `RxJsonSchema` emitted by this converter into Effect and validates every write against that imported JSON schema at runtime, through `wrappedValidateEffectStorage()` from `rxdb/plugins/validate-effect`.
- **This package** is the *converter*. It turns an Effect Schema into the JSON schema passed to `addCollections()`, so you do not maintain two definitions of the same document shape.

The converter has **no runtime dependency on RxDB**. The `RxJsonSchema` and `PrimaryKey` types it uses are imported with `import type` and are erased at compile time. `effect` is the only runtime import.

## Install

The package is distributed from its GitHub repository; there is no npm release yet. Install it directly from GitHub:

```sh
npm install github:nickchomey/rxdb-effect-schema effect
```

The import name stays `rxdb-effect-schema`, for example `import { effectSchemaToRxJsonSchema } from 'rxdb-effect-schema'`.

Peer dependencies:

- `effect` `>=4.1.4 <5`. The tests run against the minimum supported version, Effect **4.1.4**; the latest 4.x at the time of writing is **4.1.5**.
- `rxdb` `>=17 <18` (the current major).

## Convert a schema

```ts
import { Schema } from 'effect';
import { effectSchemaToRxJsonSchema } from 'rxdb-effect-schema';

const HeroSchema = Schema.Struct({
    id: Schema.String.check(Schema.isMaxLength(100)),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    age: Schema.Finite,
    nickname: Schema.optional(Schema.String),
    tags: Schema.Array(Schema.String),
    created: Schema.Date
});

const rxSchema = effectSchemaToRxJsonSchema(HeroSchema, {
    version: 0,
    primaryKey: 'id',
    indexes: ['name'],
    additionalProperties: false,
    title: 'Hero'
});
```

The options are:

- `version`: the RxDB schema version. Must be a non-negative integer.
- `primaryKey`: a field name, or a composite primary key object with `key`, `fields` and `separator`.
- `indexes`: optional index definitions, in the format RxDB expects.
- `additionalProperties`: defaults to `false`, matching RxDB's own default.
- `title`: optional schema title.

The generated schema has no `$schema`, always has `type: 'object'`, inlines every `$defs` entry, and passes RxDB's dev-mode `checkSchema()`.

A string primary key needs a `maxLength` check in the Effect Schema, because RxDB requires `maxLength` on every primary key field.

## Pairing with RxDB

The schema above is what you hand to RxDB. The intended validator pairing is the `validate-effect` plugin:

```ts
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateEffectStorage } from 'rxdb/plugins/validate-effect';

const db = await createRxDatabase({
    name: 'heroes',
    storage: wrappedValidateEffectStorage({
        storage: getRxStorageMemory()
    })
});

const collections = await db.addCollections({
    heroes: { schema: rxSchema }
});

await collections.heroes.insert({
    id: 'hero-1',
    name: 'Alice',
    age: 30,
    tags: ['admin'],
    created: '2026-01-01T00:00:00.000Z'
});
```

`wrappedValidateEffectStorage()` requires an RxDB version that carries the `validate-effect` plugin. That plugin is in an open RxDB PR and is not in the published `rxdb` package yet, so the runnable example in [`examples/basic.mjs`](examples/basic.mjs) uses `wrappedValidateAjvStorage()` on the same converted schema instead. Keep the Effect Schema as the single source of truth; the validator wrapper can be swapped once the Effect plugin ships.

## Mappings that matter

Effect and RxDB do not map one to one for every type. These are the cases that affect an authored collection:

- Use `Schema.Finite` for numeric fields. Plain `Schema.Number` includes `Infinity`, `-Infinity` and `NaN`, so the exporter emits an `anyOf` with number and string members. `Schema.Finite` exports cleanly as `{ "type": "number" }`.
- `Schema.Date` exports as `{ "type": "string" }` with **no** `format` annotation. Store ISO 8601 date strings and add your own format check if you need one.
- `Schema.optional(...)` emits an `anyOf` that also allows `null`, and the property is left out of `required`. For example, an optional `nickname` becomes `"anyOf": [{ "type": "string" }, { "type": "null" }]`.
- `additionalProperties` comes from the options and defaults to `false`.

## Limits

- **No recursive schemas.** Effect uses `$defs` and `$ref` for named schemas (for example `Schema.annotate({ identifier })` or `Schema.Class`). The converter inlines those definitions because RxDB rejects `$ref` fields. A schema built with `Schema.suspend()` that refers back to itself cannot be inlined into a finite schema, so conversion throws `EffectSchemaToRxJsonSchemaError` with code `EFFECT_SCHEMA_RECURSIVE`. An unresolved `$ref` throws with code `EFFECT_SCHEMA_UNRESOLVED_REF`.
- **Refinements may be lost.** Anything the Standard Schema JSON Schema exporter cannot represent as standard JSON Schema is absent from the resulting `RxJsonSchema`. The `validate-effect` plugin imports that JSON schema, so it will not enforce those checks either. Keep such checks in application code, or use a schema the exporter can represent.

## Development

```sh
npm install
npx tsc --noEmit   # type check
npm test           # Vitest, 5 tests
npm run build      # emit dist/
npm run example    # build, then run examples/basic.mjs
```
