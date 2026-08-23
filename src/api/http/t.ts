/**
 * The schema vocabulary the routes already use.
 *
 * Elysia's `t` is TypeBox with extra kinds bolted on. Of those, this
 * repository only ever used `t.File()` — twice, in the document-upload route,
 * whose handler already rejects a non-`Blob` field itself — so `t` here is
 * TypeBox's `Type` plus that one passthrough rather than a reimplementation of
 * Elysia's surface.
 */
import { type TSchema, Type } from '@sinclair/typebox';

const File = () => Type.Any();

export const t = { ...Type, File } as typeof Type & { File: typeof File };
export type { TSchema };
