# Spaces across installs — implementation spec

Status: **spec, ready to build** (one PR). Builds the S7 contract of
[coworking-spec.md §11](coworking-spec.md) and the "Across installs" design of
[coworking.md](coworking.md). It replaces, for spaces, the peer transport
of [workroom-and-swarm-federation.md](workroom-and-swarm-federation.md)
Part 2. That document's pooled inference and delegation stay out of scope.
This spec reuses its identity and handshake ideas, and corrects the parts
that no longer match the code (§1.4).

**Goal.** Anna runs Octipus on install B. Ben owns a space on install A. Ben
sends Anna an invite link. Anna pastes it into **her own** Octipus. The space
then appears in her sidebar with a "hosted by A" badge. She reads and posts
in its rooms, co-edits its live notes, works its tasks, and can bring **her
own agent**: it thinks on her models, at her cost, and acts in the space only
through space operations. Nothing of the space is stored on B. Ben (or an
admin of A) can revoke her, or all of B, at once.

## Contents

1. What exists
2. Decisions
3. Security invariants
4. F1: instance identity and config
5. F2: the peer link
6. F3: joining
7. F4: the host side
8. F5: the visitor side
9. F6: the visitor's agent
10. F7: admin, audit, revocation
11. Tests
12. Docs, config, migrations, slicing
13. Open questions (deferred)

---

## 1. What exists

### 1.1 The remote member on the host (built, S7 contract)

- `users.kind = 'remote'`, `remote_instance_id`, `remote_user_ref`, a
  `~name@<fingerprint>` username, no email and no password. A CHECK enforces
  all of this (`users_kind_chk`), and `(remote_instance_id, remote_user_ref)`
  is unique (migration `0135_guests_remote.sql`, `src/db/schema/users.ts`).
- Local usernames may not start with `~` (`src/security/user-kinds.ts`).
  `remoteDisplayName` exists but nothing calls it.
- Every sign-in path refuses a remote row:
  - `SessionManager.create` and session validation (`security/auth/session.ts`)
  - API tokens, passkeys and impersonation
  - SAML JIT and SCIM
  - the ws-ticket (`api/server.ts`)
  - admin PATCH
- **No code creates a remote row.**

### 1.2 Every space door refuses remote rows on purpose

`getMembership` joins `users` on `kind = 'local'` (`src/core/spaces/service.ts`).
Because of that, `roomAccess`, `requireRoom`, `handleRoomMessage`, the doc
hub, `space.subscribe`, the content repos, `listen.ts` and `funding.ts` all
answer 404 for a remote row. Federation adds **one** deliberate second door
(§7.1); everything else stays closed.

### 1.3 What the host side can reuse

| Visitor need | Existing code | Keyed on |
|---|---|---|
| room stream | `roomSubscribe` (gateway `room.subscribe`, `room-handlers.ts`), `hub.publishToResource('room:<id>')`, catch-up by `afterMessageId` | the connection's `userId` |
| post | `postAndQueue` → `postRoomMessage` (`rooms/service.ts`), mentions, `room.post` rate bucket | actor `userId` |
| read pages | `listRoomMessages` (≤200 per page) | actor |
| ask the host agent | `handleRoomMessage` → `enqueueRoomTurn` → `runRoomTurn` (`'room' \| 'listen'` only) | requester `userId` |
| live notes | `DocumentHub.join/update/awareness/leave` (`docs/hub.ts`), text-only updates, rate limits, awareness user overwritten | `connectionId`, `userId` |
| note proposals | `proposeNoteEdit` (`docs/edit-proposals.ts`), needs `run_agent_write`, pending per `(note_id, session_id)` | NoteScope |
| tasks | `contentRepos(principal).tasks`, `task.changed` on `space:<id>` | shared Principal |
| notes and files read | `SpaceNoteRepo`, `WorkspaceFS.forSpace` | shared Principal |
| revocation | `onMembershipChanged` (`spaces/membership.ts`): bumps the membership version, stops agents, prunes room sockets, doc hub and leases | `userId` |

Each gateway connection carries one user (`ConnectionContext.userId`). Room,
doc and presence handlers, the doc hub's peer table and the rate buckets all
assume this. That fixes the design: **one virtual gateway connection per
visitor** on the host, whose `send` forwards over the peer link (§7.2). The
handlers above then run unchanged.

### 1.4 Plan text that no longer matches the code

- **Gateway auth method.** `workroom-and-swarm-federation.md` §2.4 extends the
  gateway with `method:'hmac'`, `setHmacValidator` and a numeric trust level.
  None of these exist: HMAC adapters and `system` trust were removed
  (`protocol.ts` header), and `TrustLevel` is `'user' | 'agent'`. This spec
  uses its **own** endpoint (§5.1), not a gateway auth method.
- **The visitor's principal.** The plan docs give three different answers:
  `peer:<id>` service principals, `kind='service'`, and a local `users` row.
  This spec uses the built one: a `users` row with `kind='remote'`. The peer
  itself is not a principal; it is the link's authenticated identity (§5.3).
- **Stale paths.** `src/core/orchestrator/{hooks,input-guard}.ts` are now
  `src/core/agent/{hooks,input-guard}.ts`.
- **Missing building blocks:**
  - no Ed25519 helper
  - no guarded WebSocket dialer
  - no LAN variant of the SSRF guard (`validateExternalUrl` rejects every
    private range)

  An unrelated bug also turned up: the Telnyx "ed25519" check runs HMAC keyed
  with the public key (`voice/telephony/telnyx.ts`). It is fixed here, since
  F1 adds a real verifier.

---

## 2. Decisions

| # | Decision |
|---|---|
| F-D1 | **One host per space**, live access, no sync and no mirror. If the host is offline, so is the space. |
| F-D2 | **Instance identity is an Ed25519 keypair** made on first start. The private key is a vault system secret; `instance_id` is `base32(sha256(spki))[:26]`. The fingerprint is shown in a 4×4 grouping. |
| F-D3 | **Its own endpoint.** `GET /federation` upgrades to a WebSocket on the host's public URL. It is separate from `/gateway`: peer frames never reach user handlers directly, and a user socket never reaches peer handlers. |
| F-D4 | **Mutual authentication with signatures over nonces, TLS required by default.** Plain `ws://` is allowed only to an address inside `federation.lanCidrs`, and both sides log a warning. Both directions sign. The visitor pins the host fingerprint from the invite (TOFU is not used: the invite carries the fingerprint). |
| F-D5 | **The invite is the authority on the host.** A space owner's invite is enough to admit a member from another install. The host's admins decide whether federation is on (`federation.mode`) and can block an instance. Pairing does not need an admin on either side. On the visitor side, joining is the user's own action, allowed when B's `federation.mode` allows outbound links. |
| F-D6 | **A visitor is a `users` row with `kind='remote'`**, created when the invite is redeemed and bound to the redeeming instance. The link may act only for members it created (`remote_instance_id` = the link's verified fingerprint). A remote row is never created from any other message. |
| F-D7 | **One link per instance pair** carries every visitor of B on A. Each frame names the visitor (`as`). The host maps each visitor to a virtual connection (§7.2). |
| F-D8 | **Visitors use space operations only**: watch, read, post, doc sync, note proposals, task ops, space-memory read, file read. Visitors cannot write files in this PR; they read files and propose note edits. File proposals are deferred to §13. |
| F-D9 | **Host agent turns started by a visitor** (`@octipus` in a room) run as `trigger:'remote'`. `fundingFor` pays for them with the sponsor in `unattended` and `sponsored` spaces; in an `own` space they are refused ("this space does not run its agent for visitors"). Approvals: a tool that would ASK the requester is **denied** for a remote requester, and the room shows "needs a host member to run". |
| F-D10 | **The visitor's own agent** posts as the visitor's remote row with `metadata.agent = true`, shown as "Anna's agent (B)". Turn-taking is enforced on the host: an agent post must answer a human post that addressed it within 10 minutes, and each room has a cap on agent posts per hour (`federation.agentPostsPerHour`, default 20). |
| F-D11 | **Nothing of the space is stored on B** apart from a pointer row per joined space (`remote_spaces`: host URL, host fingerprint, space id, name, my role, my remote ref). It holds no content. The visitor's agent gets room content fenced per turn, and its session has `audience: 'remote-space'`, which turns off memory extraction, learning, knowledge indexing and profile facts. |
| F-D12 | **Revocation is immediate.** A membership change sends `space.revoked` and drops the visitor's virtual connection. An instance block closes the link and revokes every membership of that instance. A link heartbeat (15 s, 3 misses) bounds how long a dead link takes to detect. |
| F-D13 | **Single process** (D16 of the coworking spec): links, virtual connections and the doc hub live in memory. |
| F-D14 | **Version.** `hello` carries `protocol: 1` and the app version. A peer on another protocol major is refused with a clear close reason. Frames are parsed strictly, and unknown frame types are answered with `error: unsupported`. |

---

## 3. Security invariants

| # | Invariant |
|---|---|
| FI1 | A frame is acted on only after the link's mutual handshake succeeded, and only for a visitor bound to that link's verified fingerprint with a live membership. Any other `as` gets a uniform `not_found`. |
| FI2 | The host checks every space operation exactly as it would for a local member with the same role and guest scope: the same functions, reached through the virtual connection or an actor `{ userId: <remote row> }`. Remote members have no path the local roles do not have. |
| FI3 | A visitor never causes a host tool run, except through the host's sponsored agent (F-D9) under the requester's role, with ASK denied. |
| FI4 | Content from a peer is untrusted. Posts go through `guardInput` and are fenced as member content (as today). Their size is capped by the frame cap. Yjs updates go through the hub's text-only and size checks. |
| FI5 | Only space content leaves the host, through the operations listed; for a visitor-triggered turn the host agent's audience is `federated`, so personal data of host members and `secret` labels do not leave in replies. |
| FI6 | Every outbound dial (B → A) passes the guarded dialer: a public address, or an address inside `federation.lanCidrs`; pinned to the resolved IP; no redirects; checked again on every reconnect. |
| FI7 | Replay: handshake nonces are single-use (kept in `kv_store` with a TTL), and timestamps must fall within ±60 s. After the handshake, the TLS (or LAN) stream carries frames, and each frame's `id` is checked to be unique within the link. |
| FI8 | B stores no space content. A test greps B's tables after a full visitor flow. |
| FI9 | Revocation (membership, instance block or `federation.mode = off`) closes live access within one round trip. No later frame from that visitor succeeds. |
| FI10 | Audit on both ends: joins, leaves, revocations, blocks and host-agent turns started by visitors carry `instance_id` and the member handle. |

---

## 4. F1 — Instance identity and config

### 4.1 Identity (`src/core/federation/identity.ts`)

- `getInstanceIdentity()`: on first call it generates an Ed25519 keypair
  (`crypto.generateKeyPairSync('ed25519')`). It stores the PKCS8 PEM as the
  vault system secret `federation.identity`. The public key is kept as
  SPKI DER in base64. It returns `{ instanceId, publicKey, sign(bytes),
  fingerprintDisplay }`.
- `verifyInstanceSignature(publicKeyB64, bytes, sigB64)`: `crypto.verify(null, …)`.
- `instanceIdOf(publicKeyB64)`: `base32(sha256(spki)).slice(0, 26)`, lowercase.
- Rotation is not part of this PR (§13).

### 4.2 Config (`federation.*`, the usual five places)

| Key | Env | Default | Meaning |
|---|---|---|---|
| `federation.mode` | `FEDERATION_MODE` | `off` | `off`, `visit` (this install may join spaces elsewhere), `host` (others may join spaces here), `both` |
| `federation.lanCidrs` | `FEDERATION_LAN_CIDRS` | `[]` | private ranges a link may dial, or accept, over plain `ws://` |
| `federation.heartbeatSeconds` | `FEDERATION_HEARTBEAT_SECONDS` | `15` | link ping interval; 3 missed pings close the link |
| `federation.maxVisitorsPerInstance` | `FEDERATION_MAX_VISITORS_PER_INSTANCE` | `50` | remote members one instance may hold here |
| `federation.agentPostsPerHour` | `FEDERATION_AGENT_POSTS_PER_HOUR` | `20` | visitor-agent posts per room per hour |

The host needs `PUBLIC_URL` / `oauth.publicUrl`. With `mode ∈ {host, both}`
and no public URL, startup logs an error and invites carry no federation
part (§6.1).

### 4.3 The Telnyx fix

`voice/telephony/telnyx.ts` verifies its webhook with
`verifyInstanceSignature`'s primitive (`crypto.verify(null, …)` with Telnyx's
public key), replacing the HMAC.

---

## 5. F2 — The peer link

### 5.1 Endpoint and dialer

- **Host.** `GET /federation` upgrades to a WebSocket (it is mounted beside
  `/gateway` in `server.ts`, and is public in `auth-guard.ts`). With `mode`
  not `host` or `both`, it answers 404. A pre-handshake budget per IP is
  reused from the gateway (`maxPreAuth`). The handshake must finish within
  5 s.
- **Visitor.** `src/core/federation/dialer.ts` has `dialPeer(url,
  expectedInstanceId)`. It parses the URL; `wss:` is required unless the
  resolved address is inside `federation.lanCidrs`. It resolves the host
  once and checks the address: public, or inside `lanCidrs`; never loopback,
  link-local or a metadata address. It connects to that IP with SNI and Host
  set to the name, using `ws` with `lookup` pinned and `followRedirects:
  false`. This guarded dialer is new and is shared with nothing else.
- **Who dials.** B always dials A (the visitor's install connects to the
  host). A never dials B, so B needs no public URL.

### 5.2 Frames

Every frame is JSON, at most `gateway.maxFrameBytes`, with the shape
`{ v: 1, id: string(≤64), type: string, as?: string(≤128), body: object }`.
Requests get `{ type: 'result', re: id, ok, body | error }`. Events from the
host are `{ type: 'event', as, body: <gateway message> }`. Unknown types get
`error: 'unsupported'`. A duplicate `id` within a link gets `error:
'duplicate'`.

### 5.3 Handshake

1. The host sends `hello { protocol: 1, instanceId: A, publicKey: A_pub,
   nonce: nA, ts, appVersion }`.
2. B checks that `instanceIdOf(A_pub) === expected` (from the invite or the
   `remote_spaces` row) and that `protocol` matches. It replies `hello
   { protocol: 1, instanceId: B, publicKey: B_pub, nonce: nB, ts, appVersion,
   sig: sign_B("octipus-fed-1|host-challenge|" + nA + "|" + A + "|" + ts) }`.
3. The host checks:
   - `instanceIdOf(B_pub) === B`
   - the signature and the ±60 s window
   - `nA` was its own nonce, never used before (kv TTL 120 s)
   - B is not blocked (`federation_instances.status`)

   It replies `welcome { sig: sign_A("octipus-fed-1|visitor-challenge|" + nB
   + "|" + B + "|" + ts) }`.
4. B verifies the signature against the pinned `A_pub`.
5. Either side closes on failure with code 4401 and a reason. After the
   handshake, the host upserts `federation_instances(instance_id, public_key,
   first_seen, last_seen, status)`. A key change for a known `instance_id` is
   impossible, since the id is derived from the key.

A link may carry frames only for members bound to B (FI1). Until B redeems
an invite it has none, so the only request a fresh link can send is
`space.join` (§6.2).

### 5.4 Heartbeat, limits, close

- `ping`/`pong` every `heartbeatSeconds`. Three misses close the link. B
  reconnects with backoff (1, 2, 4 … 60 s, with jitter) while any
  `remote_spaces` row for A exists and a local user has it open (§8.2), or
  an agent turn needs it.
- Rate limits on the host:
  - per link: 60 frames/s
  - per visitor: the gateway's per-connection buckets, which the virtual
    connection inherits
  - `space.join`: 10/min per instance
- Close codes:
  - 4401 auth
  - 4403 blocked or federation off
  - 4409 protocol version
  - 4429 rate
  - 4000 normal

### 5.5 Files

`src/core/federation/`:

- `identity.ts`
- `dialer.ts`
- `link.ts`: the frame codec, request/response correlation and heartbeat,
  shared by both sides
- `host-server.ts`: the endpoint and handshake, and dispatch to `host-ops.ts`
- `host-ops.ts`: §7
- `virtual-connection.ts`: §7.2
- `visitor-client.ts`: the link pool on B, one per host
- `visitor-ops.ts`: §8
- `protocol.ts`: zod schemas for every frame

---

## 6. F3 — Joining

### 6.1 Invite links carry the host

When the host has `mode ∈ {host, both}` and a public URL, `POST
/api/spaces/:id/invites` returns, beside `url`, a `federatedUrl`:
`<publicUrl>/join/<token>#octipus=<instanceId>`. The fragment never reaches a
server. The `/join` page shows "Have your own Octipus? Join from it". That
button copies the link and explains: paste it into your Octipus under
**Spaces → Join a space on another install**. Guest invites (scoped rooms
and folders) federate too; the scope applies to the remote row.

### 6.2 Redemption (visitor B → host A)

1. On B, the user pastes the link. `POST /api/remote-spaces/join { link }`
   (needs `mode ∈ {visit, both}`). B parses the host origin, the token and
   the `#octipus=` fingerprint (it refuses a link without one). It dials and
   handshakes with the pinned fingerprint.
2. B sends `space.join { token, user: { ref: <B user id>, name:
   <B username> } }`.
3. In one transaction, the host:
   - previews the invite (it must be live)
   - checks the instance's visitor count against `maxVisitorsPerInstance`
   - upserts the remote `users` row: `kind='remote'`, `remote_instance_id =
     B`, `remote_user_ref = ref`, username `~<sanitized name>@<B[:8]>`, with a
     numeric suffix on collision
   - calls `acceptInviteInTx(tx, { userId: remoteRow.id }, token)`
   - audits `space_joined_remote` (instance and handle)

   It replies `{ space: { id, name, role, scope }, member: { handle } }`. An
   invite that cannot be redeemed gets the same `invite_invalid` as on the
   web.
4. B stores the pointer row `remote_spaces(user_id, host_instance_id,
   host_public_key, host_url, space_id, space_name, role, member_handle,
   joined_at)`, unique on `(user_id, host_instance_id, space_id)`. Name and
   role are refreshed on every `space.info`.

`acceptInviteInTx` and `onMembershipGranted` run unchanged. The new piece is
the remote-row upsert, `upsertRemoteMember(tx, instanceId, ref, name)` in
`src/core/federation/remote-members.ts`. It is the only writer of `kind =
'remote'` rows. A test greps for any other insert into `users` with
`kind: 'remote'`.

### 6.3 Leaving

`DELETE /api/remote-spaces/:id` on B sends `space.leave`. The host removes the
membership through the existing member-removal path (`onMembershipChanged`)
and B deletes the pointer. A host that cannot be reached still loses the
pointer on B; the host prunes the member the next time the link opens
(`space.leave` is queued in memory only, best effort, and the host owner can
remove the member too).

---

## 7. F4 — The host side

### 7.1 The remote door

`getMembership(userId, workspaceId, opts?: { remoteInstanceId?: string })`:
without `opts`, behaviour is unchanged (local only). With `opts`, it also
accepts a row with `kind = 'remote'` **and** `remote_instance_id =
opts.remoteInstanceId`. It is called only from the federation host code,
where the instance id comes from the verified link. Every function on the
virtual-connection path that reads membership passes the instance id through
a request-scoped `AsyncLocalStorage` (`federationContext`). It is set only by
`host-ops.ts`, so local code paths never see a remote member. The same
context lets `roomAccess`, `requireRoom`, the doc hub's membership callback,
`space.subscribe` and `contentRepos` accept the row. A test proves that each
of them still refuses a remote row outside the context.

A remote member also fails, always:

- the sign-in paths (unchanged)
- `listen.ts`: a remote row never triggers a listen turn
- channel bindings, orgs and workspace transfer
- `funding.ts` sponsor naming: a remote row is never a sponsor
- any route under `/api` (no session can exist)

### 7.2 Virtual connections

`ConnectionManager.registerVirtual({ userId, instanceId, send })` returns a
`connectionId`. It creates a `GatewayConnection` without a real socket: its
`ws.send` serializes the outgoing gateway message into an `event` frame `{
as: handle }` on the link, and `ws.close` drops it. The context has
`clientType: 'peer'` (added to `ClientType`), `trustLevel: 'user'`, `ip:
'peer:<instanceId>'` and `resources` empty. It does not count toward
`maxPerUser`, and has its own cap: one per visitor per link.

The host creates a visitor's virtual connection on the first frame that
names them and drops it when:

- the link closes
- the visitor is revoked
- 10 minutes pass with no frame and no watched resource

Gateway frames from the visitor (`room.subscribe`, `room.post`, `doc.join`,
`doc.update`, `doc.awareness`, `doc.leave`, `space.subscribe`,
`room.typing`, `room.read`) go through **`GatewayHub.routeMessage`** for that
connection, inside `federationContext`, with an **allowlist** of message
types:

- `room.*` except moderation
- `doc.*`
- `space.subscribe` / `space.unsubscribe`
- `file.leases` read
- `ping`

Every other type (`chat.*`, `session.*`, `subscribe` for artifacts, approvals,
commands) gets `error: forbidden`. Nothing else is reachable.

### 7.3 REST-shaped operations

The host serves these as request frames, calling the same service functions
as the matching routes, with the remote actor inside `federationContext`:

| Frame | Calls | Checks |
|---|---|---|
| `space.info` | `getSpace` | member |
| `space.members` | `listMembers` | member; guests see their rooms' members |
| `space.rooms` | `listRooms` | membership, private rooms, guest scope |
| `room.page` | `listRoomMessages` | `roomAccess`; ≤200 per page |
| `note.list` / `note.read` | `contentRepos(principal).notes` | role and scope |
| `note.propose` | `proposeNoteEdit` | `run_agent_write` (editor); session key `remote:<rowId>` (one pending per note per visitor), lock key `remote:<rowId>` |
| `task.list` / `task.read` / `task.op` | `contentRepos(principal).tasks` (`create` as a proposal only: `status: 'proposed'`; `claim`, `comment`, `report` as for a local member of that role) | role, guest rooms |
| `file.list` / `file.read` | `WorkspaceFS.forSpace` with the remote access | role, guest folders; ≤1 MiB per read |
| `memory.list` | space memory read | member, not guest |

`principal` is built by `remotePrincipal(row, membership)`. It is a shared
Principal like `agentPrincipal`, with `workspaceKind: 'shared'`, the role
and the scope, and `remote: true`. `contentRepos` accepts it only inside
`federationContext`.

### 7.4 Posting, mentions, display

- **Posts** go through `postRoomMessage` unchanged (actor is the remote row).
  The body passes `guardInput` (FI4). An agent post carries `agent: true` and
  is stored with `messages.metadata.agent = true`; it is subject to F-D10.
  The host refuses it unless:
  - an unanswered human post addressed the visitor's agent in the last 10
    minutes (by `@<handle>` or a reply), and
  - the room's agent posts in the last hour are under
    `federation.agentPostsPerHour`

  Otherwise it answers `error: 'agent_turn_refused'`.
- **Display.** `displayNames` (`session-history.ts`) and the web use
  `remoteDisplayName`: `anna@B…` for a person, and "anna's agent (B…)" for an
  agent post. The room transcript (`room-context.ts`) labels them the same
  way, fenced as member content.
- **Mentions.** `MENTION_RE` accepts `@~name@fp8` and `@name@fp8`, which
  resolve to the remote row. A mention of a remote member is not written to
  local notifications. It is forwarded as an `event` `{ type:
  'room.mention', roomId, messageId }` to the visitor's link, if open, and
  dropped otherwise (B shows unread from `room.page` on next open).

### 7.5 Host agent turns started by visitors

`handleRoomMessage` accepts a remote requester inside `federationContext`
with `trigger: 'remote'`, which is added to `runRoomTurn`'s triggers.
`fundingFor('remote', …)` already returns sponsor for `unattended` and
`sponsored` spaces, and refuses `own` spaces. The turn runs with the
requester's role. An ASK for a remote requester is denied by
`approvalTarget`, and the room shows the existing "needs approval" strip
text, "a host member must run this". Its flow-guard audience is `federated`
(a new audience label on `sessionAudience`, which counts as wider than a
local room): personal reads of host members are refused, and `secret` labels
never go out. Cost lands in `cost_log` with `funding: 'sponsor'` and
`metadata.remoteInstance`.

### 7.6 Revocation and blocking

- `onMembershipChanged(userId, …)` gets one more step: if the row is remote,
  send `space.revoked { spaceId }` on its link (if open) and drop its
  virtual connection. The existing steps (prune room sockets, doc hub, file
  leases, stop agents) already cover the virtual connection, because it is
  an ordinary connection.
- **Block an instance:** `POST /api/admin/federation/instances/:id/block`
  sets `federation_instances.status = 'blocked'`, closes the link with 4403,
  removes every membership of that instance's remote rows (each through
  `onMembershipChanged`), and audits. `unblock` restores the status only;
  memberships stay removed.
- **`federation.mode`** changes take effect for new links. Turning `host`
  off closes every inbound link (a settings-change hook).

---

## 8. F5 — The visitor side

### 8.1 Data

Migration `0137_federation.sql` adds:

- `federation_instances` (host side): `instance_id` PK, `public_key`, `status
  active|blocked`, `first_seen`, `last_seen`, `blocked_by`, `blocked_at`
- `remote_spaces` (visitor side): as in §6.2, FK `user_id` → users with
  cascade

The schema goes in `src/db/schema/federation.ts`.

### 8.2 Link pool and proxy (`visitor-client.ts`, `visitor-ops.ts`)

- One link per host instance, opened on demand, shared by all of B's users
  who joined spaces there. Each frame's `as` is the `member_handle` stored
  for that user, and B sends only the handle of the user it serves.
- **REST on B** (each call checks that the `remote_spaces` row is the
  caller's):
  - `GET /api/remote-spaces` lists the pointer rows.
  - `GET /api/remote-spaces/:id` refreshes them with `space.info`.
  - `GET /api/remote-spaces/:id/rooms` (and `members`, `notes`, `notes/:noteId`,
    `tasks`, `files`, `files/*`, `rooms/:roomId/messages`) forward the
    matching frame and return its body unchanged.
  - `POST …/rooms/:roomId/messages`, `POST …/notes/:noteId/proposals` and
    `POST …/tasks/:taskId/ops` forward.
- **Gateway on B.** A user's web socket sends `remote.frame { remoteSpaceId,
  frame }`, where `frame` is one allowlisted gateway message
  (`room.subscribe`, `room.post`, `doc.*` …). B checks that the pointer row
  is the caller's and forwards it as `as: handle`. Host events for that
  handle come back as `remote.event { remoteSpaceId, event }` to the
  caller's connections only. B keeps the subscriptions in memory, keyed by
  connection, and drops them on close.
- Nothing from these responses is written to B's database. Logs on B record
  frame types, sizes and ids only, never bodies.

### 8.3 Web

- `ActiveWorkspace` gains `kind: 'remote'` (`web/lib/workspace-context.tsx`).
  The workspace picker lists remote spaces under "on other installs", each
  with a "hosted by `<fingerprint short>`" badge.
- **Spaces → Join a space on another install**: a paste box that posts to
  `/api/remote-spaces/join` and shows the host fingerprint before
  confirming.
- **The rooms, notes, tasks and files views** take a data source: the
  existing hooks for local spaces, and `remote` hooks that call the
  `/api/remote-spaces/...` routes and wrap gateway frames in `remote.frame`.
  The UI components are reused unchanged; actions the role does not allow
  are hidden, as for local members.
- **The live note editor** sends Yjs frames through `remote.frame`. Its state
  lives in the browser only (as today).
- **Leaving** shows the revoke note: "what your agent already read stays in
  its session history".

---

## 9. F6 — The visitor's own agent

- **The remote room panel** has "ask my agent" (the side-panel pattern,
  `session.context.linkedRoomId`). On B it creates a personal session with
  `context.remoteRoom = { remoteSpaceId, roomId }` and `audience:
  'remote-space'`.
- **Per turn**, `spaceTurnContext` fetches the last
  `rooms.transcriptWindowChars` of the room with `room.page` over the link.
  It fences the transcript (random tag, as `linkedRoomTranscript` does),
  marks the session `suspicious`, and stores nothing.
- **The `remote-space` audience** turns off memory extraction, learning,
  knowledge indexing, profile facts and personal-memory recall for the
  session (`sessionAudience`, `src/core/agent/audience.ts`). It is a
  wider audience than personal, so flow guard keeps B's personal data out of
  anything posted.
- **Tools on B, only in such a session:**
  - `remote_space_read` (room page, note, task, file)
  - `remote_space_post` (posts with `agent: true`; needs the host's F-D10 OK,
    and shows the refusal to the user)
  - `remote_space_propose_note`
  - `remote_space_task_op`

  Each is a thin call to `visitor-ops.ts`. Each is ASK by default the first
  time in a session, through the normal permission path, with "post to a
  space on another install" wording.
- **Everything runs on B's models, at the visitor's cost**
  (`resolveModel` for the visitor, as any personal turn).

---

## 10. F7 — Admin, audit, revocation UI

- **Host admin:** **Admin → Federation**
  (`GET /api/admin/federation/instances`) lists instances with their
  fingerprint, first and last seen, link state, number of remote members and
  their spaces, plus block and unblock (§7.6).
- **Space owner:** members from other installs show with the instance badge.
  Removing one works as for any member, and the revocation is immediate
  (FI9).
- **Visitor:** `Settings → Spaces on other installs` lists the pointer rows
  and their link state, with a leave action.
- **Audit actions:**
  - `space_joined_remote`, `space_left_remote`
  - `federation_instance_blocked`, `federation_instance_unblocked`
  - `remote_agent_turn` (host)
  - `remote_space_joined`, `remote_space_left` (visitor)

  Each carries `instanceId` and `memberHandle`.

---

## 11. Tests

All tests run against PGlite with two in-process installs (two DATA_DIRs,
two identities, the host server on a random port). The `ws` client dials
`ws://127.0.0.1` with `federation.lanCidrs: ['127.0.0.1/32']`, which also
exercises the LAN allowance.

1. **Handshake:**
   - Mutual authentication succeeds.
   - A wrong pinned fingerprint is refused.
   - A replayed nonce, a stale timestamp, a protocol mismatch, a blocked
     instance and `mode: off` are each refused with their close code.
2. **Dialer:**
   - Loopback is refused without `lanCidrs`.
   - `ws://` to a public name is refused.
   - Redirects are not followed.
   - The resolved IP is pinned.
3. **Join:**
   - Redeeming creates exactly one remote row bound to B.
   - The same user joining a second space reuses that row.
   - A used, expired or revoked token gives `invite_invalid`.
   - The visitor cap is enforced.
   - No other code path inserts `kind: 'remote'` (grep test).
4. **FI1:**
   - A frame `as` another instance's member gets `not_found`.
   - A frame `as` an unknown handle gets `not_found`.
   - A frame `as` a revoked member gets `not_found`.
5. **FI2 parity:** for each role (editor, commenter, viewer, guest with
   scope), every operation in §7.2 and §7.3 gives the same allow or deny as
   the local route for a local member of that role.
6. **Door:** outside `federationContext`, the remote row is refused by
   `getMembership`, `roomAccess`, the doc hub, `space.subscribe` and
   `contentRepos`.
7. **Virtual connection:**
   - `room.subscribe` delivers live `room.message` events as `event` frames.
   - A non-allowlisted gateway type gets `forbidden`.
   - Revocation drops the connection and sends `space.revoked`.
   - A later frame fails (FI9).
8. **Live note:** two web clients (one local on A, one through B's
   `remote.frame`) converge on the same text, and an oversized or non-text
   update is refused.
9. **Agent rules:**
   - An unaddressed agent post is refused.
   - An addressed one is accepted.
   - The hourly cap holds.
   - A host turn started by a visitor in an `own` space is refused.
   - In an `unattended` space it is funded by the sponsor, and ASK is
     denied.
10. **Residency (FI8):** after a full flow (join, read, post, note edit,
    agent turn), no table on B holds any message, note or task text from A
    (grep over all text columns), and the agent session's memories and
    knowledge are empty.
11. **Blocking:** blocking an instance closes the link, removes every
    membership of that instance and audits; unblocking does not restore
    memberships.
12. **Telnyx:** a real Ed25519 signature verifies and a forged one fails.

---

## 12. Docs, config, migrations, slicing

- **Docs:**
  - `docs/SPACES.md`: "Across installs" goes from contract to guide (host
    setup, joining, what visitors can do, agents, revocation, limits).
  - `docs/CONFIGURATION.md`: `federation.*`.
  - `.env.example`.
  - `CHANGELOG.md`.
  - `docs/plans/workroom-and-swarm-federation.md`: a note at the top that
    this spec supersedes its Part 2 for spaces.
- **Migration** `0137_federation.sql` (idempotent, with a journal entry).
- **Catalog** regenerated.
- **Build order**, inside one PR: F1, F2, F3, F4 (§7.1–7.3), F4 (§7.4–7.6),
  F5, F6, F7. Each step gets its own review before the next starts.

## 13. Open questions (deferred, not built here)

- File writes by visitors: a file proposal object (a diff with its base
  version), accepted by an editor.
- Approvals for remote requesters, routed to any host editor in the room.
- Key rotation and re-pinning.
- Visitor-side notifications for mentions while B is offline.
- Several host processes (D16).
- Delegation and inference sharing between installs (the swarm plan).
