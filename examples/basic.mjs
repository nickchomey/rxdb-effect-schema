/**
 * Runnable example for rxdb-effect-schema.
 *
 * Run with `npm run example`. The converter has no RxDB runtime dependency;
 * this example uses the published Ajv validation wrapper because the Effect
 * validator (wrappedValidateEffectStorage) lives in an open RxDB PR. See the
 * README for the intended pairing.
 */
import { Schema } from 'effect';
import { createRxDatabase } from 'rxdb';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

import { effectSchemaToRxJsonSchema } from '../dist/index.js';

const HeroSchema = Schema.Struct({
    id: Schema.String.check(Schema.isMaxLength(100)),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    age: Schema.Finite,
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

console.log('Converted RxJsonSchema:');
console.log(JSON.stringify(rxSchema, null, 2));

const db = await createRxDatabase({
    name: 'rxdb-effect-schema-example',
    storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() })
});
const { heroes } = await db.addCollections({ heroes: { schema: rxSchema } });

const valid = {
    id: 'hero-1',
    name: 'Alice',
    age: 30,
    tags: ['admin'],
    created: '2026-01-01T00:00:00.000Z'
};
await heroes.insert(valid);
console.log('\nValid insert succeeded:', (await heroes.findOne(valid.id).exec()).name);

try {
    await heroes.insert({
        id: 'hero-2',
        name: 'Bob',
        age: 'not-a-number',
        tags: [],
        created: '2026-01-01T00:00:00.000Z'
    });
    console.log('Invalid insert was unexpectedly accepted');
} catch (err) {
    const writeError = err?.parameters?.writeError;
    const first = writeError?.validationErrors?.[0];
    console.log('\nInvalid insert rejected:');
    console.log('  status:', writeError?.status);
    console.log('  field path:', first?.instancePath);
    console.log('  keyword:', first?.keyword);
    console.log('  message:', first?.message);
}

await db.close();
