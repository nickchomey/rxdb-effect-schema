import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Schema } from 'effect';
import {
    createRxDatabase,
    randomToken
} from 'rxdb';
import { checkSchema } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

import {
    effectSchemaToRxJsonSchema,
    EffectSchemaToRxJsonSchemaError
} from '../src/index.js';

/**
 * These tests cover the Effect-schema-first authoring path: define the
 * collection as an Effect Schema, convert it into an RxJsonSchema and let
 * RxDB validate documents against the resulting schema.
 */
describe('effectSchemaToRxJsonSchema()', () => {
    const Id = Schema.String.check(Schema.isMaxLength(100));
    const HeroSchema = Schema.Struct({
        id: Id,
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
        age: Schema.Finite,
        nickname: Schema.optional(Schema.String),
        tags: Schema.Array(Schema.String),
        created: Schema.Date
    });

    function convert(schema: any = HeroSchema) {
        return effectSchemaToRxJsonSchema(schema, {
            version: 0,
            primaryKey: 'id',
            indexes: ['name'],
            title: 'Hero'
        });
    }

    it('converts the Effect schema and passes RxDB dev-mode schema checks', () => {
        const rxSchema: any = convert();

        assert.strictEqual(rxSchema.type, 'object');
        assert.strictEqual(rxSchema.version, 0);
        assert.strictEqual(rxSchema.primaryKey, 'id');
        assert.strictEqual(rxSchema.additionalProperties, false);
        assert.strictEqual(rxSchema.title, 'Hero');
        assert.deepStrictEqual(rxSchema.indexes, ['name']);

        // No JSON Schema fields that RxDB cannot process.
        assert.ok(!Object.prototype.hasOwnProperty.call(rxSchema, '$schema'));
        assert.ok(!Object.prototype.hasOwnProperty.call(rxSchema, '$defs'));
        assert.ok(!Object.prototype.hasOwnProperty.call(rxSchema, '$ref'));

        // A string primary key needs maxLength for RxDB.
        assert.strictEqual(rxSchema.properties.id.type, 'string');
        assert.strictEqual(rxSchema.properties.id.maxLength, 100);

        // Schema.Finite maps to a plain number, not the anyOf that Schema.Number emits.
        assert.deepStrictEqual(rxSchema.properties.age, { type: 'number' });

        // Schema.Date has no format annotation in the importer output.
        assert.deepStrictEqual(rxSchema.properties.created, { type: 'string' });

        // Optional properties are absent from required and allow null.
        assert.ok(rxSchema.required.includes('id'));
        assert.ok(rxSchema.required.includes('name'));
        assert.ok(rxSchema.required.includes('age'));
        assert.ok(rxSchema.required.includes('tags'));
        assert.ok(!rxSchema.required.includes('nickname'));
        assert.deepStrictEqual(rxSchema.properties.nickname.anyOf, [
            { type: 'string' },
            { type: 'null' }
        ]);

        assert.deepStrictEqual(rxSchema.properties.tags, {
            type: 'array',
            items: { type: 'string' }
        });

        // RxDB's own schema validation must accept the converted schema.
        checkSchema(structuredClone(rxSchema));
    });

    it('writes a valid document and reports the failing field path for an invalid one', async () => {
        // The Effect validator lives in an open RxDB PR and is not published,
        // so today's runnable example uses the Ajv wrapper on the same schema.
        const storage = wrappedValidateAjvStorage({ storage: getRxStorageMemory() });
        const db = await createRxDatabase({
            name: randomToken(10),
            storage
        });
        const collections = await db.addCollections({
            heroes: {
                schema: convert()
            }
        });
        const collection: any = collections.heroes;

        const validDoc = {
            id: randomToken(12),
            name: 'Alice',
            age: 30,
            tags: ['admin'],
            created: '2026-01-01T00:00:00.000Z'
        };
        await collection.insert(validDoc);
        const found = await collection.findOne(validDoc.id).exec();
        assert.strictEqual((found as any).name, 'Alice');

        let thrown: any;
        try {
            await collection.insert({
                id: randomToken(12),
                name: 'Bob',
                age: 'not-a-number',
                tags: [],
                created: '2026-01-01T00:00:00.000Z'
            });
        } catch (err) {
            thrown = err;
        }
        assert.ok(thrown, 'the invalid write must be rejected');

        // The Ajv wrapper reports the validation error under
        // parameters.writeError. Its entries use Ajv's ErrorObject shape:
        // `instancePath` points at the field rather than a `field` property.
        const writeError = thrown.parameters && thrown.parameters.writeError;
        assert.strictEqual(writeError.status, 422);
        const validationError = writeError.validationErrors[0];
        assert.strictEqual(validationError.instancePath, '/age');
        assert.strictEqual(validationError.keyword, 'type');
        assert.match(validationError.message, /number/);

        await db.close();
    });

    it('accepts a composite primary key option', () => {
        const Composite = Schema.Struct({
            id: Id,
            category: Schema.String.check(Schema.isMaxLength(50)),
            name: Schema.String
        });
        const primaryKey = {
            key: 'id',
            fields: ['category', 'name'],
            separator: '|'
        };
        const rxSchema: any = effectSchemaToRxJsonSchema(Composite, {
            version: 0,
            primaryKey
        });
        assert.deepStrictEqual(rxSchema.primaryKey, primaryKey);
        checkSchema(structuredClone(rxSchema));
    });

    it('inlines non-recursive $defs produced by annotated schemas', () => {
        const Address = Schema.Struct({
            city: Schema.String
        }).pipe(Schema.annotate({ identifier: 'Address' }));
        const Person = Schema.Struct({
            id: Id,
            address: Address
        });

        const rxSchema: any = effectSchemaToRxJsonSchema(Person, {
            version: 0,
            primaryKey: 'id'
        });

        assert.ok(!Object.prototype.hasOwnProperty.call(rxSchema, '$defs'));
        assert.ok(!Object.prototype.hasOwnProperty.call(rxSchema, '$ref'));
        assert.ok(!Object.prototype.hasOwnProperty.call(rxSchema.properties.address, '$ref'));
        assert.strictEqual(rxSchema.properties.address.type, 'object');
        assert.strictEqual(rxSchema.properties.address.properties.city.type, 'string');
        checkSchema(structuredClone(rxSchema));
    });

    it('throws EFFECT_SCHEMA_RECURSIVE for a recursive schema that cannot be inlined', () => {
        const Recursive: any = Schema.suspend(() => Schema.Struct({
            id: Id,
            next: Schema.optional(Recursive)
        }));
        assert.throws(
            () => effectSchemaToRxJsonSchema(Recursive, {
                version: 0,
                primaryKey: 'id'
            }),
            (err: any) =>
                err instanceof EffectSchemaToRxJsonSchemaError &&
                err.code === 'EFFECT_SCHEMA_RECURSIVE',
            'recursive schemas must raise EFFECT_SCHEMA_RECURSIVE'
        );
    });
});
