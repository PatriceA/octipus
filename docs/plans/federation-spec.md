# Spaces across installs — implementation spec

Status: **spec, reviewed against the code, ready to build** (one PR). It builds the S7 contract of
[coworking-spec.md §11](coworking-spec.md) and the "Across installs" design of
[coworking.md](coworking.md). For spaces, it replaces the peer transport of
[workroom-and-swarm-federation.md](workroom-and-swarm-federation.md) Part 2.
Pooled inference and delegation remain out of scope.

**Goal.**
- Anna runs Octipus on install B. Ben owns a space on install A and sends Anna an invite link.
- Anna pastes the link into **her own** Octipus. The space shows in her sidebar with a "hosted by A" badge.
- Through her own install she can read and post in the space's rooms, co-edit its live notes, read its files, and work its tasks.
- She can bring **her own agent**. It thinks on her models, at her cost, and acts in the space only through space operations.
- Nothing of the space is stored on B outside her agent's own session history.
- Ben, or an admin of A, can revoke Anna or all of B at once.

## Contents

1. What exists
2. Decisions
3. Security invariants
4. F1: instance identity and config
5. F2: the peer link
6. F3: joining and leaving
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

- `users.kind = 'remote'` holds:
  - `remote_instance_id` and `remote_user_ref`;
  - a `~name@<fingerprint>` username;
  - no email and no password.

  The `users_kind_chk` CHECK enforces this, and `(remote_instance_id, remote_user_ref)` is unique (migration `0135_guests_remote.sql`, `src/db/schema/users.ts`).
- Local usernames may not start with `~` (`src/security/user-kinds.ts`). `remoteDisplayName` exists but nothing uses it yet.
- Every sign-in path refuses a remote row:
  - `SessionManager.create` and session validation;
  - API tokens, passkeys and impersonation;
  - SAML JIT, SCIM and the ws-ticket;
  - admin PATCH.

  Nothing in the code creates a remote row.
- `fundingFor('remote', …)` already returns `sponsor` in `unattended` and `sponsored` spaces and throws `funding_off` in `own` spaces (`src/core/agent/context.ts`). The `AgentTrigger` type has `'remote'`, but no code path produces it.

### 1.2 Every space door refuses remote rows on purpose

- `getMembership(userId, workspaceId, db?, opts?)` joins `users` on `kind = 'local'` (`src/core/spaces/service.ts`). It has about 90 call sites in 28 files: room access, the doc hub, presence, approvals routing (`security/approval-route.ts`), `readSpace`/`recheckSpace` at every agent spawn, and others.
- `listen.ts`, `funding.ts`, `install-access.ts`, channel bindings, orgs and API tokens each check `kind = 'local'` separately.
- Federation opens exactly one door, in the data (§7.1). The explicit `kind = 'local'` checks listed above stay closed.

### 1.3 What the host side can reuse

| Visitor need | Existing code | Notes |
|---|---|---|
| room stream | gateway `room.subscribe` / `room.unsubscribe` (`gateway/room-handlers.ts`): `roomAccess`, `afterMessageId` catch-up (≤200 per page, `hasMore`), turn strip, presence; `hub.publishToResource('room:<id>')` | reached through `ConnectionManager.handleMessage`, which parses with zod and applies the per-connection rate buckets |
| post | `room.post` → `postAndQueue` → `postRoomMessage` → `handleRoomMessage(roomId, userId, msgId)` → `enqueueRoomTurn` → `runRoomTurn` (trigger defaults to `'room'`) | moderation arrives as `room.post` content: `/stop queue`, `/clear`, `/compact` (`rooms/commands.ts`) |
| read pages | `listRoomMessages` | actor |
| live notes | `doc.join` / `doc.update` / `doc.awareness` / `doc.leave` → `DocumentHub` (peers keyed by `connectionId`; text-only updates; rate limits; awareness user overwritten by the server) | |
| note proposals | `proposeNoteEdit` (`docs/edit-proposals.ts`), needs `run_agent_write`; `note_edit_proposals.session_id` is a `uuid` | |
| tasks | statuses `open \| in_progress \| done \| archived` (`tasks/status.ts`); `POST /tasks/:id/checkout`, `/release`, `/comments`; `contentRepos(principal).tasks` | `contentRepos`/`spaceRepos` **trust the principal** and do not check membership |
| principals | `memberPrincipal` (`db/repositories/space.ts`) builds a shared Principal from a membership | |
| files | `WorkspaceFS.forSpace(workspaceId, { guestFolders })` takes no role: the caller checks it | |
| approvals | `routeApprovalFor` (`security/approval-route.ts`), with `ApprovalCaller.trigger` | |
| revocation | `onMembershipChanged(workspaceId, userId)` (`spaces/membership.ts`): bumps the membership version, stops agents, prunes room sockets, the doc hub and leases | |

Gateway connections are single-user (`ConnectionContext.userId`), and the doc
hub keys peers by `connectionId`. The host therefore keeps **one virtual
connection per (visitor, B-side client connection)** (§7.2). Its frames go
through `ConnectionManager.handleMessage`, so parsing, rate limits and
handlers are reused unchanged.

### 1.4 Plan text and code that do not match (corrected here)

- The gateway has no `hmac` method, no `setHmacValidator`, and no numeric trust level (see the `protocol.ts` header). This spec uses its own endpoint instead (§5.1).
- Visitor principal: this spec uses the built option, a `users` row with `kind = 'remote'`. The peer is the link's authenticated identity, not a principal.
- Stale paths: `orchestrator/{hooks,input-guard}` now lives at `src/core/agent/{hooks,input-guard}.ts`.
- `sessionAudience` (`agent/audience.ts`) is derived from the session's kind, `groupChannelId` and `workspaceId`. There is no settable audience field and no `federated` audience. §7.5 and §9 add both, derived from data.
- Room posts do not go through `guardInput` today; only agent turns do. Room transcripts are fenced as member content.
- A bad invite token throws `SpaceError('not_found')`. `invite_invalid` exists only in `registration.ts`.
- **Telnyx bug:** its "ed25519" check runs an HMAC keyed with the public key, and `if (!publicKey) return true` fails open (`voice/telephony/telnyx.ts`). F1 fixes both.

---

## 2. Decisions

| # | Decision |
|---|---|
| F-D1 | **One host per space.** Access is live: no sync and no mirror. When the host is offline, so is the space. |
| F-D2 | **Identity is an Ed25519 keypair per install.** The private key is the vault system secret `federation.identity`, created under an advisory lock. `instance_id` = `base32(sha256(spki))`, 26 characters (130 bits). It is displayed in four groups. |
| F-D3 | **Own WebSocket endpoint** `/federation`, always registered and refusing every peer (4403) unless `federation.mode ∈ {host, both}`, so a mode change needs no restart. It is separate from `/gateway`. |
| F-D4 | **Mutual signed handshake** binding an **ephemeral X25519 key exchange**. After the handshake, every frame is sealed with ChaCha20-Poly1305 using per-direction keys and a sequence number (§5.3). This holds over TLS as well: frames stay integrity-protected through TLS-terminating proxies. `ws://` is allowed only to or from addresses inside `federation.lanCidrs`. The visitor pins the host fingerprint carried in the invite. |
| F-D5 | **The invite is the authority on the host.** A space owner's invite is enough to admit a member from another install. The host's admins control `federation.mode` and can block an instance. On B, joining is the user's own action; B's `federation.mode` must allow `visit`. |
| F-D6 | **A visitor is a `users` row with `kind = 'remote'`.** It is created only when an invite is redeemed, bound to the redeeming instance, and acted for only by a link whose verified fingerprint is that instance. A remote row's role is at most **editor**. |
| F-D7 | **One link per instance pair.** Frames name the visitor (`as`) and B's client connection (`conn`). The host keeps one virtual connection per (visitor, conn), at most 5 per visitor. |
| F-D8 | **Visitors act only through space operations:** room watch/read/post, live-note co-editing, note edit proposals, task read/create/checkout/release/comment, space-memory read, file read. **No file writes** in this PR. |
| F-D9 | **Host agent turns started by a visitor** run with `trigger: 'remote'`. They are sponsor-funded in `unattended`/`sponsored` spaces and refused in `own` spaces. An approval that would ask the requester is **denied**. Each instance gets its own cap on queued remote turns. |
| F-D10 | **The visitor's agent** posts as the visitor's row with `metadata.agent = true`, shown as "anna's agent". Agent turn-taking rules are **cooperative** (B could mislabel a post). The host's hard bounds are the per-visitor post rate and the per-room cap on agent-labelled posts. |
| F-D11 | **B stores space content only in rows keyed to the visitor-agent sessions** (messages, tool actions, run events, trajectories, approvals of those sessions). These rows are deleted with the session, and never reach memories, knowledge, embeddings, profile facts or notes. Compaction is off for those sessions. Pointer rows (`remote_spaces`) hold metadata only. |
| F-D12 | **Revocation is per space and immediate.** It sends `space.revoked { spaceId }` and prunes through the existing membership steps. Blocking an instance closes its link and revokes every membership the instance holds. |
| F-D13 | **Single process** (D16): links, virtual connections and the doc hub live in memory. |
| F-D14 | **Protocol version.** `hello` carries `protocol: 1` and the app version. A peer on a different major version is refused (close code 4409). Frames are parsed strictly; an unknown type is answered with `unsupported`. |

---

## 3. Security invariants

| # | Invariant |
|---|---|
| FI1 | A frame is acted on only after the handshake, only when it is sealed under the link keys with the next sequence number, and only for a visitor bound to the link's verified instance whose instance is `active`. Anything else gets a uniform `not_found` (an unknown visitor) or closes the link (a bad seal). |
| FI2 | The host checks every visitor operation with the same functions it uses for a local member of the same role and guest scope: gateway frames through `handleMessage`, REST-shaped operations through the same service calls with `memberPrincipal`. A remote member has no path that a local member of that role lacks. |
| FI3 | A visitor never causes a host tool run, except through the host's sponsored agent (F-D9) under the requester's role. That run gets ASK denied, a federated audience, and a per-instance turn cap. |
| FI4 | Content from a peer is untrusted. Room posts are fenced as member content in host turns (as today). Remote posts also go through `guardInput` before they are stored. Frames are capped at `gateway.maxFrameBytes`. Yjs updates go through the hub's checks. |
| FI5 | Only space content leaves the host, through the listed operations and the outbound allowlist of virtual connections (§7.2). Member lists and room events carry the member-visible name (the username, as local members and guests see it) and never an e-mail field or user settings. A room with a remote member is a **federated audience** for every turn in it, read again at every tool decision: personal data of host members and `secret` labels never go to it. Writes into a space with any remote member are federated egress for every turn in it. |
| FI6 | Every outbound dial passes the guarded dialer: a public address, or an address inside `federation.lanCidrs`; IP pinned; no redirects; re-checked on every reconnect. |
| FI7 | Replay and tampering: handshake nonces are single-use (the host's per socket, the visitor's kept in `kv_store` with a TTL once its signature verified); timestamps must fall within ±60 s; after the handshake, AEAD with strictly increasing sequence numbers per direction. |
| FI8 | B keeps no space content outside the visitor-agent session rows of F-D11. A test greps every text column on B, minus that allowlist. |
| FI9 | Revocation (a membership, an instance block, or `federation.mode` turned off) ends live access within one round trip. No later frame for that space succeeds. |
| FI10 | Both ends audit with `instanceId` and the member handle. |
| FI11 | Abuse bounds: per-IP budgets for handshakes and joins; per-link frame rate; per-link send queue cap; per-visitor gateway buckets; per-instance limits on remote turns and members. |

---

## 4. F1 — Instance identity and config

### 4.1 Identity (`src/core/federation/identity.ts`)

- `getInstanceIdentity()`:
  - Reads `federation.identity` with a vault call that tells **absent** apart from **error**: `getReservedSystemSecret`, which throws on a vault error instead of returning null and is the only read that reaches a reserved name.
  - On error, it throws, and federation stays off for that start (logged loudly).
  - When the secret is absent, it takes a Postgres advisory lock, reads again, then generates an Ed25519 key (`crypto.generateKeyPairSync('ed25519')`) and stores the PKCS8 PEM.
  - Returns `{ instanceId, publicKeySpkiB64, sign(bytes), display }`.
- The name `federation.identity` is reserved, enforced inside the vault: `getByName`, `get`, `store`, `setSystemSecret`, `update`, `rotate` and `delete` throw for it and `list` leaves it out, so no admin-supplied reference (a model's `apiKeyRef`, a SCIM token ref) can read it; only `getReservedSystemSecret` and `createSystemSecretOnce` reach it. The admin vault routes answer 403 for it.
- `verifyEd25519(publicKey, bytes, sig)` is a thin wrapper over `crypto.verify(null, …)`. It accepts SPKI DER, or a raw 32-byte key, which it wraps in the Ed25519 SPKI prefix.
- `instanceIdOf(spkiB64)` = `base32(sha256(spki)).slice(0, 26)`, lowercase.
- `shortInstanceLabel(id)` = the first 8 characters, used only in a handle's `@<fp8>` (§6.2). Badges show 12 characters (§7.4). Identity is always the full id.

### 4.2 Config (the usual five places)

| Key | Env | Default | Meaning |
|---|---|---|---|
| `federation.mode` | `FEDERATION_MODE` | `off` | `off`, `visit` (join spaces elsewhere), `host` (others join spaces here), `both` |
| `federation.lanCidrs` | `FEDERATION_LAN_CIDRS` | `[]` | private ranges a link may use over plain `ws://`, dialled or accepted |
| `federation.heartbeatSeconds` | `FEDERATION_HEARTBEAT_SECONDS` | `15` | ping interval; 3 missed pings close the link |
| `federation.maxVisitorsPerInstance` | `FEDERATION_MAX_VISITORS_PER_INSTANCE` | `50` | live memberships one instance may hold here |
| `federation.maxRemoteTurnsPerInstance` | `FEDERATION_MAX_REMOTE_TURNS_PER_INSTANCE` | `5` | queued or running host turns started by one instance's visitors |
| `federation.agentPostsPerHour` | `FEDERATION_AGENT_POSTS_PER_HOUR` | `20` | agent-labelled posts per install per room per hour |

- `mode ∈ {host, both}` needs `PUBLIC_URL` / `oauth.publicUrl`. If it is missing, startup logs an error and invites carry no federation part.
- A change to `mode` applies at once: turning `host` off closes every inbound link, and turning `visit` off closes every outbound one.

### 4.3 Telnyx

`voice/telephony/telnyx.ts` verifies with `verifyEd25519`, using Telnyx's raw 32-byte key. A missing key makes verification fail instead of pass.

---

## 5. F2 — The peer link

### 5.1 Endpoint and dialer

- **Host endpoint.**
  - `app.ws('/federation')` sits next to `/gateway` in `api/http/serve.ts`. It is always registered; while `mode ∉ {host, both}` every socket is refused right after the upgrade with close code 4403, so turning hosting on (or off) applies without a restart. Turning hosting off also closes every open inbound link (4403).
  - WS upgrades bypass HTTP hooks, so the endpoint does its own budgets, counted per IPv4 address or per IPv6 /64:
    - before the handshake: at most 10 sockets per address and 256 in all, 30 handshakes per address per minute; a plain frame over 4 KiB is refused (4401) before it is parsed;
    - sealed links: at most 16 per address and 1024 in all; at most 64 from instances with no `federation_instances` row, which may only send `space.join` (and `ping`) until a join writes their row — anything else is `not_found` (FI1);
    - the budgets are swept every minute.
  - The handshake must complete within 5 s.
  - Plain `ws://` is accepted only from a client address inside `lanCidrs`; otherwise the socket must come from a trusted proxy whose rightmost `X-Forwarded-Proto` is `https`/`wss`. A trusted proxy that names no client (no `X-Forwarded-For`/`X-Real-IP`) is not a LAN client, whatever its own address.
- **Dialer** (`src/core/federation/dialer.ts`): `dialPeer(url, expectedInstanceId)`.
  - `wss:` is required, unless the resolved address is inside `lanCidrs`.
  - The host is resolved and checked: a public address, or one inside `lanCidrs`. Loopback, link-local and metadata addresses are never allowed unless `lanCidrs` explicitly contains them (tests use `127.0.0.1/32`).
  - The connection is pinned to the checked address with the `lookup` pin that `fetchPinned` uses, which handles `all: true`. No redirects are followed.
- **Direction.** B always dials A.

### 5.2 Frames

- Before `welcome`, frames are plain JSON: `{ v: 1, type, body }`.
- After `welcome`, every frame on the wire is `{ v: 1, s: seq, c: ciphertext }`. The AEAD nonce is derived from `seq` (four zero bytes, then `seq` as 64-bit big-endian), so it is not sent: each direction has its own fresh key per link, so a (key, nonce) pair never repeats.
  - The plaintext is `{ id, type, as?, conn?, body }`.
  - Requests get `{ type: 'result', re: id, ok, body | error }`.
  - Host events are `{ type: 'event', as, conn, body: <gateway server message> }`.
- Size: at most `gateway.maxFrameBytes` before sealing.
- Unknown types get `unsupported`.
- **Send queue.** Each link counts its queued bytes (`ws.bufferedAmount` plus its own queue). Above max(4 MiB, 2 × the largest sealed frame for `gateway.maxFrameBytes`) the link is closed with 4429.
- **Requests in flight.** A link answers at most 32 of the peer's requests at once; one more is answered `busy` without running.

### 5.3 Handshake

1. **Host → B:** `hello { protocol: 1, instanceId: A, publicKey: A_pub, nonce: nA, ts, eph: xA_pub, appVersion }`.
2. **B checks** that `instanceIdOf(A_pub)` equals the pinned id and that `protocol` matches.
3. **B → host:** `hello { protocol: 1, instanceId: B, publicKey: B_pub, nonce: nB, ts, eph: xB_pub, appVersion, sig: sign_B(T("visitor", protocol, nA, nB, A, B, xA_pub, xB_pub, ts, appVersionA, appVersionB)) }`.
4. **Host checks:**
   - `instanceIdOf(B_pub) = B`;
   - ts within ±60 s;
   - the signature (over its own `nA`, which lives in the socket's state only: one hello per socket, so it cannot be used twice);
   - only then, that `nB` is new for B (recorded in `kv_store`, TTL 120 s), so unsigned frames cannot fill the store;
   - B is not `blocked`.
5. **Host → B:** `welcome { sig: sign_A(T("host", protocol, nA, nB, A, B, xA_pub, xB_pub, ts, appVersionA, appVersionB)) }`.
6. **B verifies** the host's signature.
7. **Keys.** Both sides derive `HKDF-SHA256(X25519(x, x'), salt = nA‖nB, info = "octipus-fed-1" ‖ SHA-256(T("keys", protocol, nA, nB, A, B, xA_pub, xB_pub, ts, appVersionA, appVersionB)))`, which gives 64 bytes split into two direction keys. Sequence numbers start at 0. A seal failure or an out-of-order sequence number closes the link with 4401.

`T(...)` is the canonical, length-prefixed concatenation of its fields. Failures close the link with 4401 and a reason. Instance rows are written only on the first successful `space.join` (§6.2), never on a bare handshake.

### 5.4 Heartbeat, limits, close

- **Heartbeat.** `ping`/`pong` every `heartbeatSeconds`; 3 missed pings close the link.
- **Reconnect.** B reconnects with exponential backoff (1 s up to 60 s, with jitter) while a local user has the space open or an agent turn needs the link. The backoff starts over only after a link stayed up 30 s. A host that refused the link (4403, 4409) is not redialled until the next explicit request or retain. Turning visiting off closes the links and stops the redials; turning it back on redials every host still retained. A dial that completes after visiting went off is closed, not used.
- **Per-link limits.**
  - 60 frames per second.
  - `space.join`: 5 per minute per link, and 20 per hour per source IP.
- **Close codes.**

  | Code | Meaning |
  |---|---|
  | 4401 | authentication or seal failure |
  | 4403 | blocked, or federation off |
  | 4409 | protocol mismatch |
  | 4429 | rate or queue limit |
  | 4000 | normal close |

### 5.5 Files

All in `src/core/federation/`:

| File | Role |
|---|---|
| `identity.ts` | instance identity (§4.1) |
| `dialer.ts` | outbound dialing (§5.1) |
| `seal.ts` | X25519, HKDF and ChaCha20-Poly1305 framing |
| `link.ts` | codec, correlation, heartbeat and send-queue accounting (both sides) |
| `host-server.ts` | the host endpoint |
| `host-ops.ts` | host operations (§7) |
| `virtual-connection.ts` | virtual gateway connections (§7.2) |
| `remote-members.ts` | remote member rows (§6.2) |
| `visitor-client.ts` | the visitor's link pool |
| `visitor-ops.ts` | visitor-side operations (§8) |
| `protocol.ts` | zod schemas |

---

## 6. F3 — Joining and leaving

### 6.1 Invite links carry the host

When the host has `mode ∈ {host, both}` and a public URL:

- `POST /api/spaces/:id/invites` also returns `federatedUrl: <publicUrl>/join/<token>#octipus=<instanceId>`. The full 26-character id goes in the fragment.
- The `/join` page offers **Join from your own Octipus**, with instructions.
- Guest invites federate too. Their scope applies to the remote row.

### 6.2 Redemption

1. **On B.** The user posts `POST /api/remote-spaces/join { link }`. This needs `mode ∈ {visit, both}`.
   - B parses the origin, the token and the fingerprint, and refuses a link without a fingerprint.
   - B shows the host fingerprint and asks for confirmation before it dials.
   - It then dials and completes the handshake.
2. **B sends** `space.join { token, user: { ref: <B user id>, name: <B display name ≤40> } }`.
3. **The host, in one transaction:**
   1. Previews the invite. A dead invite throws `SpaceError('not_found')`, which is answered as `invite_invalid`.
   2. Refuses an `owner` role (invites never grant it).
   3. Upserts `federation_instances` (status `active`; first and last seen). A `blocked` row refuses the join. The row lock serialises joins of one instance.
   4. Upserts the remote `users` row with `upsertRemoteMember(tx, instanceId, ref, name)`:
      - username `~<slug(name)>@<instanceId[:8]>`, with a numeric suffix on collision;
      - `remote_instance_id = B`;
      - this is the **only** writer of `kind = 'remote'`.
   5. Calls `acceptInviteInTx(tx, { userId }, token)`.
   6. Counts this instance's **live memberships** against `maxVisitorsPerInstance`, the new one included. A re-join of a space the member already belongs to adds none and always passes.
   7. Audits `space_joined_remote`.
   - Join budgets: 5 a minute per link, 20 an hour per source address; addresses with no join left in the window are pruned once a minute.
4. **After commit,** `afterInviteAccepted` runs, as it does for local members.
5. **The host replies** `{ space: { id, name, role, scope }, member: { handle } }`.
6. **B stores** `remote_spaces(id, user_id, host_instance_id, host_public_key, host_url, space_id, space_name, role, member_handle, joined_at, left_at)`. The row is unique on `(user_id, host_instance_id, space_id)` while `left_at IS NULL`.

### 6.3 Leaving

`DELETE /api/remote-spaces/:id` sets `left_at`, which is a tombstone. While a tombstone exists, B sends `space.leave { spaceId }` every time the link opens, and deletes the row once the host acknowledges it. On the host, `space.leave` removes the membership through the normal member-removal path. The space owner can also remove a remote member like any other member.

---

## 7. F4 — The host side

### 7.1 The data door

`getMembership` (`src/core/spaces/service.ts`) accepts a member row when **either**:

- `users.kind = 'local'` (unchanged), **or**
- `users.kind = 'remote'` **and** `federation_instances.status = 'active'` for its `remote_instance_id`, **and** `federation.mode ∈ {host, both}`.

The second case is one `LEFT JOIN federation_instances` plus a config check in the same function. It holds for every call site, whatever async context the call runs in: queued room turns, approval routing on a fresh loopback request, presence publishes triggered by another user, and doc-hub membership changes. The result carries `remote: { instanceId } | null`, and `AgentSpace` gains `remote: boolean`.

These stay local-only, because they check `kind = 'local'` separately:

- `listen.ts`: a remote row never triggers a listen turn;
- `funding.ts`: a remote row never becomes a sponsor;
- `install-access.ts`;
- channel bindings, orgs, API tokens and every sign-in path.

Role cap:

- `PATCH` on a member role, and ownership transfer, refuse `owner` for a remote row (`SpaceError('forbidden')`).
- The migration adds a trigger-free guard: `workspace_members` role `owner` with a remote user is refused by a CHECK through a function, the same way `guest_scope_is_valid` works.

Presence: `publishSpacePresence` already filters by the reader's scope. With the data door, a remote guest's membership is read correctly. The fail-open branch, where a null membership means "everyone", becomes **fail-closed**: null means "nobody". This fix applies to local users as well.

### 7.2 Virtual connections

- **Creation.**
  - `ConnectionManager.registerVirtual({ userId, instanceId, conn, sink })` creates a `GatewayConnection` with `state: 'active'`.
  - Its fake `ws` has `readyState: 1`, a `send` that hands the message to `sink` (which seals an `event` frame with `as`/`conn`), and a `close` that drops the connection.
  - It is put into `connections` and `byUser` like a real connection, so `getConnectionsByUser`, `closeUserConnections`, `publishToResource` and room/doc pruning all see it.
  - Context: `clientType: 'peer'` (added to `ClientType`), `trustLevel: 'user'`, `ip: 'peer:<instanceId>'`, no workspace hint, empty `resources` and `eventSubscriptions` = `room.mention` and `chat.error` only (never `*`).
  - Its rate buckets are keyed by (link, visitor), not by connection: every virtual connection of a visitor on a link draws on the same buckets, which outlive `conn.close`.
  - At most 5 per visitor per link, separate from `maxPerUser`. It is dropped when its link closes, on `conn.close` from B, when the visitor's last membership ends, or after 10 idle minutes.
- **Inbound frames.**
  - A gateway frame from the visitor is checked against an **allowlist of client message types**: `room.subscribe`, `room.unsubscribe`, `room.post`, `room.typing`, `room.read`, `space.subscribe`, `doc.join`, `doc.update`, `doc.awareness`, `doc.leave`, `ping`.
  - It is then passed to `ConnectionManager.handleMessage(connectionId, raw)`, which applies zod parsing and the per-connection rate buckets.
  - `room.post` content that starts with `/` is refused for a remote sender, so visitors get no moderation commands.
  - Generic `subscribe`/`unsubscribe` are not on the list. B unsubscribes by sending `conn.close` (or `doc.leave`/`room.unsubscribe`, as listed).
- **Events.**
  - Server events for the virtual connection go out on the link, tagged with its `conn`, through an **outbound allowlist** enforced in the sink: the answers and pushes of the allowlisted frames (`error`, `pong`, `subscribed`, `room.catchup`, `room.posted`, `doc.*`, `file.leases`) and the events `room.message`, `room.turn`, `room.presence`, `room.typing`, `room.read`, `room.removed`, `space.presence`, `task.changed`, `room.mention`, `chat.error`. Everything else — `agent.*`, `swarm.*`, `chat.delta`, `chat.response`, permission prompts and other progress of a host turn, which carry raw tool arguments and observations — is dropped. `space.revoked` is sent on the link directly (§7.6).
  - Events published to the visitor's user id (`publishEvent`, such as a requester error from a room turn, `room.mention` or `task.changed`) reach the visitor's virtual connections in the same way.

### 7.3 REST-shaped operations

The principal is `memberPrincipal(membership)`. The role is checked here, because `contentRepos`, `spaceRepos` and `WorkspaceFS` trust their caller.

| Frame | Calls | Check |
|---|---|---|
| `space.info` | `getSpace` | member |
| `space.members` | `listMembers` | member; guests see only their rooms' members; the member-visible name (the username, badged for a remote member), role, `remote` and the install's full id; never an e-mail field (FI5) |
| `space.rooms` | `listRooms` | membership, private rooms, guest scope |
| `room.page` | `listRoomMessages` | `roomAccess`; at most 200 per page |
| `note.list` / `note.read` | `contentRepos(memberPrincipal).notes` | role, scope |
| `note.propose` | `proposeNoteEdit` with `proposerKey = remote:<rowId>` | `run_agent_write` |
| `task.list` / `task.read` | `contentRepos(…).tasks` | role, guest rooms |
| `task.create` | the task create path, status `open` | role may create tasks (editor), as for a local member |
| `task.checkout` / `task.release` / `task.comment` | the same functions as `/tasks/:id/checkout`, `/release`, `/comments` | as for a local member of that role |
| `file.list` / `file.read` | `WorkspaceFS.forSpace(workspaceId, { guestFolders })` | role at least viewer; guest folders; read-only; at most 1 MiB per read, read through one handle (at most 1 MiB + 1 bytes, so a growing file is refused), and refused when the encoded answer (base64 for binary) would not fit one link frame |
| `memory.list` | the space memory read | member, not a guest |

Note proposals key on `session_id` (a uuid). Migration `0137` therefore adds `note_edit_proposals.proposer_key text` with a unique pending index on `(note_id, coalesce(session_id::text, proposer_key))`, and the lock key uses the same value.

### 7.4 Posts, mentions, display

- **Posts.** A remote post passes `guardInput` before `postRoomMessage`. A refused post returns an `error` result and is not stored. A post it only warns about is stored with `metadata.guardFlags`; the room transcript marks it `[flagged: …]` and adds a security alert, as for a flagged request.
  - An agent-labelled post (`agent: true`) is stored with `metadata.agent = true` and counts against `federation.agentPostsPerHour` for its install in the room, counted and inserted under one advisory lock. The 10-minute "answer only when addressed" rule is cooperative; B's agent loop enforces it (§9).
  - The per-visitor `room.post` bucket is the hard bound.
- **Display.** Everywhere a remote row is shown (`displayNames` in `session-history.ts`, the room transcript in `room-context.ts`, the members list), the name is followed by a host-side **instance badge** (`[B:abcd1234efgh]`, 12 base32 characters of the verified instance id). An agent-labelled post reads "anna's agent [B:abcd1234efgh]". The full id is shown where a badge is listed (the member list's hover, Admin → Federation). Local usernames that look like `name@xxxx` get no badge, so the two cannot be confused.
- **Mentions.**
  - Only `@~name@fp8` resolves to a remote member.
  - `@name@fp8` keeps its current meaning (a local user whose name contains `@`).
  - `mentionsOctipus` no longer matches when the next character is `@`, so addressing `@octipus@…` never starts the host agent.
  - A mention of a remote member is not written to local notifications. It is sent as `room.mention` to that visitor's virtual connections and dropped when none is open (B shows unread from `room.page` on its next open).

### 7.5 Host agent turns started by visitors

- **Trigger.** `postAndQueue` → `handleRoomMessage` passes `trigger: 'remote'` when the author is a remote row. `RoomRequest` stores the trigger, and `runRoomTurn` accepts `'room' | 'listen' | 'remote'`. `fundingFor` decides: in `own` spaces it refuses, and the visitor gets the existing "funding off" error event.
- **Turn cap.** `enqueueRoomTurn` also counts queued and running turns per instance against `maxRemoteTurnsPerInstance`.
- **Approvals.** `routeApprovalFor` denies `ask_human` when `trigger === 'remote'`, and the room strip shows "a host member must run this".
- **Federated audience.** `AgentContext` gains `audienceFederated: boolean`. It is true when the run's trigger is `remote`, **or** when the room has any remote member (one `EXISTS` read at spawn). It is carried on the run, not the session, because a room session is shared by local and remote turns. A member of another install may join while a turn runs, so `routeApprovalFor` reads it again at every tool decision, and the room reply reads it again before it is posted (a cached `EXISTS`, keyed on the space's membership version and at most 30 s old). The flow guard treats a federated run as audience `federated`, which is wider than `space`:
  - personal reads of host members are refused;
  - `secret` reads are refused;
  - once the session holds a `private` or `secret` label, any egress (a send out, or a write into the space) is refused;
  - a room answer that drew on personal data or credential material is not posted when the room gained a remote member during the turn; the requester hears why.
- **Space-wide stores.** When the space has any remote member, a write into its notes, files, memory or tasks is federated egress for every turn in that space, private sessions and room turns alike: with a `secret` label it is refused, and the I6 consent text adds "members of this space on other installs will read it".
- **Accounting.** The turn's cost row carries `funding: 'sponsor'` and `metadata.remoteInstance`.

### 7.6 Revocation and blocking

- **Membership changes.** `onMembershipChanged(workspaceId, userId)` gets one more step for a remote row: send `space.revoked { spaceId }` on the visitor's link. The existing steps prune room sockets, doc hub peers and leases of that space for the virtual connections, because they are ordinary connections. The virtual connections are closed only when the visitor has no membership left on this host.
- **Blocking an instance.** `POST /api/admin/federation/instances/:id/block` sets `status = 'blocked'`, closes the link (4403), removes every membership of that instance's rows through the normal path — each removal on its own, the admin as its audit actor (FI10), a failure reported as a warning while the others go on — and audits the block whatever happened to the removals. The data door (§7.1) refuses its rows at once, even before removal finishes. `unblock` restores the status only.
- **Federation turned off.** `federation.mode` without `host` closes inbound links, and the data door refuses remote rows at once.

---

## 8. F5 — The visitor side

### 8.1 Data (migration `0137_federation.sql`)

- `federation_instances` (host side): `instance_id` PK, `public_key`, `status active|blocked`, `first_seen`, `last_seen`, `blocked_by`, `blocked_at`.
- `remote_spaces` (visitor side): as in §6.2.
- `note_edit_proposals.proposer_key` with its index (§7.3).
- The remote-owner guard (§7.1).

The schema goes in `src/db/schema/federation.ts`.

### 8.2 Link pool and proxy

- **One link per host instance**, shared by all of B's users who joined spaces there. B fills `as` only with the stored handle of the user it serves, and `conn` with that user's gateway connection id, or `agent:<sessionId>` for the agent.
- **REST on B.** Every route checks that the pointer row is the caller's, and B forwards the matching frame:
  - `GET /api/remote-spaces` and `GET /api/remote-spaces/:id`, which refreshes the row from `space.info`;
  - `…/rooms`, `…/members`, `…/notes`, `…/notes/:noteId`, `…/tasks`, `…/files`, `…/files/*` and `…/rooms/:roomId/messages`;
  - `POST` routes for room messages, note proposals, task create and task operations.
- **Gateway on B.**
  - The browser sends `remote.frame { remoteSpaceId, frame }`, where `frame` is one of the allowlisted types.
  - Host events come back as `remote.event { remoteSpaceId, event }`, only to the connection named by `conn`.
  - Link state changes go out as `remote.link { remoteSpaceId, state: 'up' | 'down' }`.
  - When a browser connection closes, B sends `conn.close` for it.
- **Reconnect.** After a link drop, B announces `remote.link down`. On reconnect it re-issues, for every open browser connection:
  - `space.subscribe`;
  - `room.subscribe` with the last seen `afterMessageId`, looping while `hasMore`;
  - `doc.join` with the client's epoch and state vector (a host restart forces a full sync).

  Then it announces `remote.link up`.
- **Logs on B** record frame types, sizes and ids, never bodies.

### 8.3 Web (its own slice in the build order)

- **Workspace.** `ActiveWorkspace` gains `kind: 'remote'`. `web/lib/api.ts` does not send `X-Octipus-Workspace` for a remote workspace; remote calls use `/api/remote-spaces/:id/...`. The picker lists remote spaces under "on other installs", each with the host's instance badge.
- **Joining.** "Join a space on another install" has a paste box, shows the host fingerprint, and asks for confirmation.
- **Data sources.** The rooms, notes, tasks and files views take a data-source interface: `local` uses today's hooks; `remote` uses the routes above and wraps gateway frames in `remote.frame`. The rooms UI is about 1.8k lines; it gets the interface first, then notes and tasks, then files. Actions the role does not allow stay hidden.
- **Live notes.** The live-note editor sends Yjs frames through `remote.frame`.
- **Leaving.** The leave dialog says: "what your agent already read stays in its session history".

---

## 9. F6 — The visitor's own agent

- **Session.** "Ask my agent" in a remote room creates a personal session on B with `context.remoteRoom = { remoteSpaceId, roomId }`.
- **Audience.** `sessionAudience` derives `'remote-space'` from `context.remoteRoom`:
  - `shared: true`;
  - memory extraction, recall, learning, knowledge indexing, profile facts and compaction off;
  - `markSharedAudience` is called at session creation.
- **Turn context.** `remoteRoomTurnContext` is a new branch next to `spaceTurnContext` (`agent/service.ts`). For a session with `remoteRoom`, it fetches the room transcript with `room.page` (windowed to `rooms.transcriptWindowChars`), fences it with a random tag, marks the session `suspicious`, and stores nothing.
- **Tools.** Only these are available in such a session:
  - `remote_space_read` (room page, note, task, file);
  - `remote_space_post`;
  - `remote_space_propose_note`;
  - `remote_space_task_op`;
  - non-personal reads: web search and page fetch.

  No personal tools are given: mail, calendar, notes, memory, files, shell, connectors.
- **Posting.** `remote_space_post` is an egress tool. The flow guard treats it like a shared post: a private or secret taint in the turn asks **every** time, and a clean turn asks the first time in each session.
- **Turn-taking.** The agent answers only when the user asked in the panel, or when a room post addressed `@~anna@…`'s agent within the last 10 minutes. The latter is an opt-in ("let my agent answer when addressed") that is off by default.
- **Models.** Everything runs on B's models, at the visitor's cost.

---

## 10. F7 — Admin, audit, revocation UI

- **Host admin:** Admin → Federation (`GET /api/admin/federation/instances`) lists each instance with its badge and full id, first and last seen, link state, live memberships and turns in flight, plus block and unblock.
- **Space owner:** members from other installs carry the instance badge; removing one revokes at once.
- **Visitor:** Settings → Spaces on other installs lists pointer rows, link state and pending leaves.
- **Audit:** `space_joined_remote`, `space_left_remote`, `federation_instance_blocked`, `federation_instance_unblocked`, `remote_agent_turn`, `remote_space_joined` and `remote_space_left`, each with `instanceId` and `memberHandle`.

---

## 11. Tests

The suite runs two in-process installs with separate data dirs and identities. The host listens on a random port, and both use `lanCidrs: ['127.0.0.1/32']`.

1. **Identity.**
   - A vault error makes `getInstanceIdentity` throw rather than mint a new key.
   - Concurrent first calls produce one key.
   - The vault routes refuse the reserved name.
2. **Handshake and seal.**
   - Mutual authentication succeeds.
   - Each of these is refused with its close code: a wrong pin, a replayed nonce, a stale timestamp, a protocol mismatch, a blocked instance, and mode off (close after upgrade).
   - A relayed handshake with swapped ephemeral keys fails.
   - A tampered, replayed or reordered sealed frame closes the link.
3. **Dialer.**
   - Loopback is refused without `lanCidrs`.
   - `ws://` to a public name is refused.
   - No redirect is followed.
   - The IP stays pinned.
4. **Join.**
   - Joining creates one remote row bound to B; a second space reuses it.
   - A dead token gives `invite_invalid`.
   - An `owner` invite or role promotion is refused.
   - The live-membership cap holds.
   - A grep test finds no other writer of `kind: 'remote'`.
   - Per-IP join budgets hold.
5. **FI1.** A frame `as` another instance's member, an unknown handle, a revoked member, or a member of a blocked instance gets `not_found`.
6. **Data door.**
   - A remote row passes `getMembership` only while its instance is active and mode is `host`/`both`.
   - `listen`, `funding`, `install-access`, channel bindings and API tokens still refuse it.
   - A queued room turn and an approval routed over the CLI loopback bridge see the same membership as the frame that started them.
7. **FI2 parity.** For each role (editor, commenter, viewer, guest with scope), every gateway frame of §7.2 and every operation of §7.3 gives the same allow or deny as for a local member of that role.
8. **Virtual connections.**
   - The rate buckets apply.
   - A non-allowlisted type, generic `subscribe` and `/commands` are refused.
   - Two `conn`s of one visitor keep separate doc and room subscriptions.
   - `room.subscribe` delivers live `room.message` events.
   - A requester error from a room turn reaches the visitor.
   - The send-queue cap closes the link.
9. **Revocation.**
   - Removing a visitor from space X keeps their access to space Y on the same host.
   - A later frame for X fails.
   - A downgrade to viewer stops posting but keeps reading.
   - A block removes all of that instance's memberships, and the door refuses them at once.
10. **Presence.**
    - A remote guest receives only members of their rooms, even when the publish is triggered by a local user.
    - A null membership yields nobody.
11. **Live note.** A local client on A and a client through B converge, and oversized or non-text updates are refused.
12. **Host turns.**
    - A visitor's `@octipus` in an `own` space is refused.
    - In an `unattended` space it is sponsor-funded, ASK is denied, the audience is federated (a personal read is refused) and the per-instance cap holds.
    - A local turn in a room with a remote member is federated too.
13. **Mentions and display.**
    - `@~anna@fp8` notifies the visitor through the link.
    - `@anna@fp8` stays local.
    - `@octipus@B` does not start the host agent.
    - Badges render.
    - Member lists, room pages and presence sent to visitors carry no e-mail field.
14. **The visitor's agent.**
    - The `remote-space` audience turns memory, learning, indexing and compaction off.
    - Only the remote tools and non-personal reads are offered.
    - `remote_space_post` asks every time after a private read.
15. **Residency (FI8).** After a full flow, no text column on B outside the F-D11 allowlist contains any message, note or task text from A, and memories, knowledge and embeddings are empty.
16. **Leaving.** A tombstone survives a B restart and is delivered when the link next opens.
17. **Telnyx.** A real signature verifies, a forged one fails, and a missing key fails.

---

## 12. Docs, config, migrations, slicing

- **Docs:**
  - `docs/SPACES.md`: "Across installs" becomes a guide covering setup, joining, what visitors can do, agents, revocation, limits and the threat model.
  - `docs/CONFIGURATION.md`: the `federation.*` keys.
  - `.env.example` and `CHANGELOG.md`.
  - `docs/plans/workroom-and-swarm-federation.md`: a top note that this spec supersedes Part 2 for spaces.
- **Migration:** `0137_federation.sql` (idempotent, with a journal entry). Regenerate the catalog.
- **Build order (one PR, each slice reviewed before the next):**
  1. F1 identity, config and Telnyx.
  2. F2 link, seal and dialer.
  3. F3 joining and leaving, plus the §7.1 data door.
  4. F4 virtual connections and REST operations (§7.2–7.3).
  5. F4 posts, mentions, turns and revocation (§7.4–7.6).
  6. F5 server side (pool, proxy, reconnect).
  7. Web data sources: rooms first, then notes and tasks, then files.
  8. F6 visitor agent.
  9. F7 admin and audit.

## 13. Open questions (deferred, not built here)

- File writes by visitors: a file proposal object (a diff with its base version), accepted by an editor.
- Approvals for remote requesters routed to a host editor in the room.
- Key rotation and re-pinning.
- Mentions delivered while B is offline.
- Several host processes (D16).
- Delegation and inference sharing between installs (the swarm plan).
