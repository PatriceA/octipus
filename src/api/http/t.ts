/**
 * The schema vocabulary the routes already use.
 *
 * Elysia's `t` is TypeBox with extra kinds bolted on. Of those, this
 * repository only ever used `t.File()`, so `t` here is TypeBox's `Type` plus
 * that one addition rather than a reimplementation of Elysia's surface.
 */
import { Kind, type TSchema, Type, TypeRegistry } from '@sinclair/typebox';

const FILE_KIND = 'OctipusFile';

/**
 * An uploaded field. Registered as a real TypeBox kind rather than aliased to
 * `Any`, because `Any` also matches `undefined` — which turned "upload with no
 * files" from a 422 into a 200 that uploaded nothing.
 */
if (!TypeRegistry.Has(FILE_KIND)) {
  TypeRegistry.Set(FILE_KIND, (_schema, value) => value instanceof Blob);
}

const File = () => Type.Unsafe<Blob>({ [Kind]: FILE_KIND });

export const t = { ...Type, File } as typeof Type & { File: typeof File };
export type { TSchema };
