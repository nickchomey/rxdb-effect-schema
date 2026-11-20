/**
 * Converts an Effect Schema into an RxJsonSchema so a collection can be
 * authored once, in Effect, and used as the RxDB collection schema.
 *
 * The conversion uses Effect's stable Standard Schema V1 JSON Schema exporter
 * (`Schema.toStandardJSONSchemaV1`) with the `draft-2020-12` target. RxDB only
 * understands a subset of JSON Schema, so a few fields are adjusted:
 * - `$schema` is removed and `$defs` are inlined, because RxDB rejects `$ref`.
 * - `type: 'object'` is ensured on the top level.
 * - RxDB specific fields (`version`, `primaryKey`, `indexes`,
 *   `additionalProperties`, `title`) are merged in from the options.
 *
 * This module has no runtime dependency on RxDB: the RxDB types below are
 * imported with `import type` and are erased during compilation.
 */
import { Schema } from 'effect';
import type { PrimaryKey, RxJsonSchema } from 'rxdb';

/**
 * Error raised when an Effect Schema cannot be represented as a finite RxDB
 * schema. The `code` field is stable so callers can branch on it without
 * matching message text.
 */
export type EffectSchemaToRxJsonSchemaErrorCode =
    | 'EFFECT_SCHEMA_RECURSIVE'
    | 'EFFECT_SCHEMA_UNRESOLVED_REF';

export class EffectSchemaToRxJsonSchemaError extends Error {
    readonly code: EffectSchemaToRxJsonSchemaErrorCode;
    readonly details: Readonly<Record<string, unknown>>;

    constructor(
        code: EffectSchemaToRxJsonSchemaErrorCode,
        message: string,
        details: Record<string, unknown> = {}
    ) {
        super(message);
        this.name = 'EffectSchemaToRxJsonSchemaError';
        this.code = code;
        this.details = details;
    }
}

export type EffectSchemaToRxJsonSchemaOptions = {
    /** RxDB schema version. Must be a non-negative integer. */
    version: number;
    /** Primary key field name, or a composite primary key object. */
    primaryKey: PrimaryKey<any>;
    /** Index definitions, see the RxDB schema documentation. */
    indexes?: (string | string[])[];
    /** Whether additional properties are allowed. Defaults to false. */
    additionalProperties?: boolean;
    /** Optional schema title. */
    title?: string;
};

type JsonObject = Record<string, any>;

/**
 * Decode a local JSON pointer fragment name (`#/$defs/<name>`). Effect uses
 * plain identifiers for definition names, but JSON pointer escaping is handled
 * here so a def name containing `/` or `~` still resolves.
 */
function decodeDefName(pointer: string): string {
    return pointer.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Inline every `$ref` that points into the document's own `$defs`.
 *
 * RxDB rejects `$ref` fields at runtime (error SC40), so all definitions must
 * be resolved before the schema is handed to RxDB. A definition that refers
 * back to itself, directly or through another definition, cannot be inlined
 * into a finite schema and raises EFFECT_SCHEMA_RECURSIVE.
 */
function inlineDefs(root: JsonObject): JsonObject {
    const defs = root.$defs as JsonObject | undefined;

    function resolve(node: any, stack: string[]): any {
        if (Array.isArray(node)) {
            return node.map(child => resolve(child, stack));
        }
        if (!node || typeof node !== 'object') {
            return node;
        }
        if (typeof node.$ref === 'string') {
            const match = /^#\/\$defs\/(.+)$/.exec(node.$ref);
            const name = match ? decodeDefName(match[1]) : undefined;
            if (!name || !defs || !Object.prototype.hasOwnProperty.call(defs, name)) {
                throw new EffectSchemaToRxJsonSchemaError(
                    'EFFECT_SCHEMA_UNRESOLVED_REF',
                    `Cannot resolve $ref "${node.$ref}": no matching entry in $defs.`,
                    { ref: node.$ref }
                );
            }
            if (stack.includes(name)) {
                throw new EffectSchemaToRxJsonSchemaError(
                    'EFFECT_SCHEMA_RECURSIVE',
                    `Cannot inline recursive $ref "${node.$ref}". RxDB does not support $ref, so recursive schemas cannot be converted.`,
                    { defName: name, ref: node.$ref }
                );
            }
            const resolved = resolve(defs[name], [...stack, name]);
            const siblings: JsonObject = { ...node };
            delete siblings.$ref;
            return Object.keys(siblings).length > 0
                ? { ...resolved, ...siblings }
                : resolved;
        }
        const out: JsonObject = {};
        Object.keys(node).forEach(key => {
            // `$defs` are resolved through `$ref` and must not leak into RxDB.
            if (key === '$defs') {
                return;
            }
            out[key] = resolve(node[key], stack);
        });
        return out;
    }

    return resolve(root, []);
}

/**
 * Convert an Effect Schema into an RxDB collection schema.
 *
 * @param schema The Effect Schema that describes one document of the collection.
 * @param options RxDB specific fields that cannot be derived from the Effect schema.
 */
export function effectSchemaToRxJsonSchema(
    schema: Schema.Schema<any>,
    options: EffectSchemaToRxJsonSchemaOptions
): RxJsonSchema<any> {
    const standard = Schema.toStandardJSONSchemaV1(schema as any);
    const generated = standard['~standard'].jsonSchema.input({
        target: 'draft-2020-12'
    }) as JsonObject;

    const withoutSchema: JsonObject = { ...generated };
    delete withoutSchema.$schema;

    const inlined = inlineDefs(withoutSchema);
    if (!inlined.type) {
        inlined.type = 'object';
    }

    const result: JsonObject = {
        ...inlined,
        primaryKey: options.primaryKey,
        version: options.version,
        additionalProperties: options.additionalProperties === undefined
            ? false
            : options.additionalProperties
    };
    if (options.indexes) {
        result.indexes = options.indexes;
    }
    if (options.title) {
        result.title = options.title;
    }
    return result as RxJsonSchema<any>;
}
