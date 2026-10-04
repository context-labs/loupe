import { object } from './util.js';
/**
 * The draft derived schemas target. It is the spec's first-class target and
 * the daemon's validator accepts it beside draft-07, which hand-written raw
 * schemas may still use.
 */
export const JSON_SCHEMA_TARGET = 'draft-2020-12';
export function isStandardSchema(schema) {
    if (!object(schema))
        return false;
    const props = schema['~standard'];
    return object(props) && typeof props.validate === 'function' && object(props.jsonSchema) && typeof props.jsonSchema.input === 'function';
}
/**
 * Derive the wire JSON Schema for a tool input or output. Raw JSON Schema
 * passes through compacted (undefined members dropped). A library that cannot
 * produce the target is a definition-time error: the document's bytes are its
 * revision, so there is no silent fallback to another draft.
 */
export function toJsonSchema(schema, io, subject) {
    if (isStandardSchema(schema)) {
        let derived;
        try {
            derived = schema['~standard'].jsonSchema[io]({ target: JSON_SCHEMA_TARGET });
        }
        catch (error) {
            throw new TypeError(`${subject}: ${schema['~standard'].vendor} schema cannot produce ${JSON_SCHEMA_TARGET} JSON Schema`, { cause: error });
        }
        if (!object(derived))
            throw new TypeError(`${subject}: ${schema['~standard'].vendor} schema produced no JSON Schema object`);
        return JSON.parse(JSON.stringify(derived));
    }
    if (!object(schema))
        throw new TypeError(`${subject}: schema must be a Standard JSON Schema or a JSON Schema object`);
    return JSON.parse(JSON.stringify(schema));
}
/** Whether a JSON Schema describes an object, which keyword arguments require. A schema without a type is left to the daemon. */
export function describesObject(schema) {
    const type = schema.type;
    if (type === undefined)
        return true;
    return type === 'object' || (Array.isArray(type) && type.includes('object'));
}
/** Run a Standard Schema's own validation. Raw JSON Schema has none and passes the value through. */
export async function validateWith(schema, value) {
    if (!isStandardSchema(schema))
        return { value };
    return schema['~standard'].validate(value);
}
/** One bounded line for an error message. */
export function formatIssues(issues, limit = 5) {
    const lines = issues.slice(0, limit).map(issue => {
        const path = (issue.path ?? []).map(segment => String(typeof segment === 'object' ? segment.key : segment)).join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
    });
    if (issues.length > limit)
        lines.push(`and ${issues.length - limit} more`);
    return lines.join('; ');
}
//# sourceMappingURL=schema.js.map