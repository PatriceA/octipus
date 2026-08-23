/**
 * Request validation for the route schemas.
 *
 * The schemas are plain TypeBox, so TypeBox checks them. Two details are not
 * default behaviour and are here on purpose:
 *
 *  - Query and path parameters arrive as strings, so `Value.Convert` runs
 *    first and a `t.Number()` query field keeps working.
 *  - A failure throws rather than returning, so the caller cannot forget to
 *    look at the result. `ValidationError` is what the error hook reads to
 *    answer 422 instead of 500.
 */
import { OptionalKind, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export class ValidationError extends Error {
  constructor(
    readonly location: string,
    readonly detail: string,
  ) {
    super(`Invalid ${location}: ${detail}`);
    this.name = 'ValidationError';
  }
}

export function checkValue<T>(schema: TSchema, value: T, location: string): T {
  // `t.Optional(...)` at the root of a body schema. TypeBox reads the optional
  // modifier only as a property of an enclosing object, so at the top level an
  // absent body would otherwise be checked against the inner type and fail.
  if (value === undefined && OptionalKind in schema) return value;
  // Coercion applies to the string-typed surfaces only. A JSON body already
  // carries types, and converting it would silently accept the very mismatch
  // the schema is there to reject — `{ modelPreference: 7 }` becoming `"7"`.
  const coerce = location !== 'body';
  const converted = (coerce ? Value.Convert(schema, value) : value) as T;
  if (Value.Check(schema, converted)) return converted;
  const [first] = [...Value.Errors(schema, converted)];
  throw new ValidationError(location, first ? `${first.path || '/'} ${first.message}` : 'does not match schema');
}
