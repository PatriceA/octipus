import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { postAndQueue } from '@/core/gateway/room-handlers';
import { runRoomCommand } from '@/core/rooms/commands';
import { getRoomMode, rateUnpromptedPost, setRoomMode } from '@/core/rooms/listen';
import {
  addRoomMember,
  createRoom,
  listRoomMembers,
  listRoomMessages,
  listRooms,
  markRoomRead,
  mentionsOctipus,
  removeRoomMember,
  requireRoom,
  setRoomMuted,
  updateRoom,
} from '@/core/rooms/service';
import { addSpaceMemory, listSpaceMemory, retractSpaceMemory } from '@/core/spaces/memory';
import { requireScope } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';
import { SpaceError } from '@/security/space-access';
import { handle } from './spaces';

/**
 * Rooms and space memory (docs/plans/coworking-spec.md §6.5, §6.7).
 *
 * | Method      | Path                                         | Who |
 * |-------------|----------------------------------------------|-----|
 * | GET         | /api/spaces/:id/rooms                        | member: rooms I can enter, with unread counts |
 * | POST        | /api/spaces/:id/rooms                        | editor+: `{title, visibility, memberIds?}` |
 * | GET         | /api/spaces/:id/rooms/:roomId/messages       | room access; paged (`before` / `after` / `limit`), with authors |
 * | POST        | /api/spaces/:id/rooms/:roomId/messages       | `can(role,'comment')`; the REST fallback of `room.post` |
 * | PATCH       | /api/spaces/:id/rooms/:roomId                | room creator or space owner: title, visibility |
 * | GET/PUT     | /api/spaces/:id/rooms/:roomId/mode           | room access / room creator or space owner (§9.3) |
 * | PUT         | /api/spaces/:id/rooms/:roomId/messages/:messageId/feedback | room access: 👍 / 👎 on an unprompted post |
 * | GET         | /api/spaces/:id/rooms/:roomId/members        | room access |
 * | POST/DELETE | /api/spaces/:id/rooms/:roomId/members/:userId| private rooms: room creator or space owner |
 * | PATCH       | /api/spaces/:id/rooms/:roomId/me             | room access: my mute and read position |
 * | GET         | /api/spaces/:id/memory                       | member |
 * | POST/DELETE | /api/spaces/:id/memory[/:entryId]            | `write` |
 *
 * Every room id a caller may not enter — a stranger's, a missing one, or a
 * room of another space — is a 404 (I3). Errors are `SpaceError`s, mapped
 * as on the spaces routes.
 */

const idParams = t.Object({ id: t.String() });
const roomParams = t.Object({ id: t.String(), roomId: t.String() });
const memberParams = t.Object({ id: t.String(), roomId: t.String(), userId: t.String() });

export const roomRoutes = new Elysia({ prefix: '/spaces' })
  .use(apiContext)

  .get('/:id/rooms', (ctx) => handle(ctx, async (actor) => ({ rooms: await listRooms(actor, ctx.params.id) })), {
    params: idParams,
    detail: { tags: ['rooms'] },
  })

  .post(
    '/:id/rooms',
    (ctx) => handle(ctx, async (actor) => {
      const room = await createRoom(actor, ctx.params.id, ctx.body);
      ctx.set.status = 201;
      return room;
    }),
    {
      params: idParams,
      body: t.Object({
        title: t.String({ minLength: 1, maxLength: 120 }),
        visibility: t.Union([t.Literal('space'), t.Literal('private')]),
        memberIds: t.Optional(t.Array(t.String(), { maxItems: 200 })),
      }, { additionalProperties: false }),
      detail: { tags: ['rooms'] },
    },
  )

  .get(
    '/:id/rooms/:roomId/messages',
    (ctx) => handle(ctx, (actor) => listRoomMessages(actor, ctx.params.id, ctx.params.roomId, {
      before: ctx.query.before,
      after: ctx.query.after,
      limit: ctx.query.limit ? Number(ctx.query.limit) : undefined,
    })),
    {
      params: roomParams,
      query: t.Object({
        before: t.Optional(t.String()),
        after: t.Optional(t.String()),
        limit: t.Optional(t.String({ pattern: '^[0-9]{1,3}$' })),
      }),
      detail: { tags: ['rooms'] },
    },
  )

  .post(
    '/:id/rooms/:roomId/messages',
    (ctx) => handle(ctx, async (actor) => {
      const content = ctx.body.content.trim();
      // WS6: a post that asks the agent drives it (tools, spend) like a chat
      // message, so an API token needs `api:chat` for it, as on /api/chat.
      if (!content.startsWith('/') && (ctx.body.addressed === true || mentionsOctipus(content)) && !requireScope(ctx.principal, API_SCOPES.CHAT)) {
        ctx.set.status = 403;
        return { error: `API token missing required scope "${API_SCOPES.CHAT}"`, code: 'missing_scope' };
      }
      if (content.startsWith('/')) {
        // A command: answered to the poster, never stored (as on the socket).
        await requireRoom(actor, ctx.params.id, ctx.params.roomId);
        return { commandResult: await runRoomCommand(ctx.params.roomId, actor.userId, content) };
      }
      const outcome = await postAndQueue(actor.userId, ctx.params.roomId, ctx.body, { workspaceId: ctx.params.id });
      ctx.set.status = 201;
      return outcome;
    }),
    {
      params: roomParams,
      body: t.Object({
        content: t.String({ minLength: 1, maxLength: 100_000 }),
        addressed: t.Optional(t.Boolean()),
        clientId: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
      }, { additionalProperties: false }),
      detail: { tags: ['rooms'] },
    },
  )

  .patch('/:id/rooms/:roomId', (ctx) => handle(ctx, (actor) => updateRoom(actor, ctx.params.id, ctx.params.roomId, ctx.body)), {
    params: roomParams,
    body: t.Object({
      title: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
      visibility: t.Optional(t.Union([t.Literal('space'), t.Literal('private')])),
    }, { additionalProperties: false }),
    detail: { tags: ['rooms'] },
  })

  // Room modes (§9.3): any member reads; the room's creator or a space owner changes.
  .get('/:id/rooms/:roomId/mode', (ctx) => handle(ctx, (actor) => getRoomMode(actor, ctx.params.id, ctx.params.roomId)), {
    params: roomParams,
    detail: { tags: ['rooms'] },
  })

  .put('/:id/rooms/:roomId/mode', (ctx) => handle(ctx, (actor) => setRoomMode(actor, ctx.params.id, ctx.params.roomId, ctx.body)), {
    params: roomParams,
    body: t.Object({
      mode: t.Optional(t.Union([t.Literal('mention'), t.Literal('listen'), t.Literal('proactive')])),
      quietHoursStart: t.Optional(t.Union([t.Integer({ minimum: 0, maximum: 23 }), t.Null()])),
      quietHoursEnd: t.Optional(t.Union([t.Integer({ minimum: 0, maximum: 23 }), t.Null()])),
      timezone: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
      maxUnpromptedPerDay: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
      minMinutesBetween: t.Optional(t.Integer({ minimum: 0, maximum: 1440 })),
    }, { additionalProperties: false }),
    detail: { tags: ['rooms'] },
  })

  // A member's 👍 / 👎 on one of the agent's unprompted posts; `value: null` withdraws it.
  .put('/:id/rooms/:roomId/messages/:messageId/feedback', (ctx) => handle(ctx, async (actor) => ({
    feedback: await rateUnpromptedPost(actor, ctx.params.id, ctx.params.roomId, ctx.params.messageId, ctx.body.value),
  })), {
    params: t.Object({ id: t.String(), roomId: t.String(), messageId: t.String() }),
    body: t.Object({ value: t.Union([t.Literal(1), t.Literal(-1), t.Null()]) }, { additionalProperties: false }),
    detail: { tags: ['rooms'] },
  })

  .get('/:id/rooms/:roomId/members', (ctx) => handle(ctx, async (actor) => ({
    members: await listRoomMembers(actor, ctx.params.id, ctx.params.roomId),
  })), {
    params: roomParams,
    detail: { tags: ['rooms'] },
  })

  .post('/:id/rooms/:roomId/members/:userId', (ctx) => handle(ctx, (actor) => addRoomMember(actor, ctx.params.id, ctx.params.roomId, ctx.params.userId)), {
    params: memberParams,
    detail: { tags: ['rooms'] },
  })

  .delete('/:id/rooms/:roomId/members/:userId', (ctx) => handle(ctx, async (actor) => {
    const result = await removeRoomMember(actor, ctx.params.id, ctx.params.roomId, ctx.params.userId);
    if (!result.removed) throw new SpaceError('not_found', 'Member not found');
    return result;
  }), {
    params: memberParams,
    detail: { tags: ['rooms'] },
  })

  .patch('/:id/rooms/:roomId/me', (ctx) => handle(ctx, async (actor) => {
    if (ctx.body.muted === undefined && ctx.body.lastReadMessageId === undefined) {
      throw new SpaceError('invalid_input', 'Nothing to change');
    }
    if (ctx.body.muted !== undefined) await setRoomMuted(actor, ctx.params.id, ctx.params.roomId, ctx.body.muted);
    if (ctx.body.lastReadMessageId !== undefined) {
      await markRoomRead(actor, ctx.params.roomId, ctx.body.lastReadMessageId, { workspaceId: ctx.params.id });
    }
    return { ok: true };
  }), {
    params: roomParams,
    body: t.Object({
      muted: t.Optional(t.Boolean()),
      lastReadMessageId: t.Optional(t.String()),
    }, { additionalProperties: false }),
    detail: { tags: ['rooms'] },
  })

  .get('/:id/memory', (ctx) => handle(ctx, async (actor) => ({ entries: await listSpaceMemory(actor, ctx.params.id) })), {
    params: idParams,
    detail: { tags: ['rooms'] },
  })

  .post('/:id/memory', (ctx) => handle(ctx, async (actor) => {
    const entry = await addSpaceMemory(actor, ctx.params.id, ctx.body.body);
    ctx.set.status = 201;
    return entry;
  }), {
    params: idParams,
    body: t.Object({ body: t.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
    detail: { tags: ['rooms'] },
  })

  .delete('/:id/memory/:entryId', (ctx) => handle(ctx, async (actor) => {
    await retractSpaceMemory(actor, ctx.params.id, ctx.params.entryId);
    return { ok: true };
  }), {
    params: t.Object({ id: t.String(), entryId: t.String() }),
    detail: { tags: ['rooms'] },
  });
