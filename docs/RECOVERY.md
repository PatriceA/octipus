# Self-repair and recovery mode

Octipus is often reached from somewhere other than the machine it runs on: a
phone, a laptop on another network, a domain or tunnel in front of the API. If
the backend doesn't come back after a restart, all of those stop working at
once, and before this you had to be at the machine to fix it.

`octi start` (and the Docker image) now run the backend under a small
supervisor, `scripts/supervisor.mjs`. It repairs what it can on its own. When
it can't, it keeps the API port answering in **recovery mode**, so you can see
what went wrong and bring the backend back from wherever you are.

## What it does on its own

| Situation | What the supervisor does |
| --- | --- |
| Boot crashes, or doesn't answer `/api/health` within 120 s | Stops it and retries after a short backoff, for transient trouble such as a port still being released, a database still starting or a network that isn't up yet |
| Still failing | Starts the **last good build**: a copy of the last `dist/` that booted and stayed healthy for a minute, kept in `.last-good-build/`. A bad pull or a broken build is the usual reason a restart doesn't come back |
| Still failing | **Recovery mode** (below) |
| Running backend crashes | Starts it again |
| Running backend stops answering health checks for a minute | Kills it and starts it again |
| In recovery mode | Tries the backend again after 2, 5, 15, 30 and then every 60 minutes, except while someone has used the recovery API in the last 10 minutes |

`octi start` also no longer gives up when `npm run build` fails. It starts the
supervisor anyway, which falls back to the last good build.

## Restarting from a chat

`octi restart` and `octi stop` started from inside Octipus (the shell tool, a
CLI agent, a chat on your phone) now hand themselves off to a detached process
and return immediately. Before, the command ran as a child of the backend it
was stopping. The backend's shutdown killed its children's process groups, so
the restart died after the stop and before the start, and nothing came back.
The hand-off's output is in `~/.octipus/restart.log` (or `stop.log`).

`octi restart` without a target now also brings the web UI back if it was
running. Before, it came back as backend-only, and anything that reached the
API through the web UI's proxy (a domain, a tunnel, the phone app) lost its
connection.

## Recovery mode

When nothing boots, the supervisor serves a small HTTP server on the API port.
It also takes the web UI port when nothing else is listening there. This
server needs neither the backend, `dist/` nor `node_modules`.

- `GET /api/health` → `503 {"status":"recovery", "reason": …}` (public)
- `GET /api/recovery` → status page with buttons (public; actions need the token)
- `GET /api/recovery/status` → mode, failed attempts with exit code and the
  last 40 log lines of each, the last good build, git commit
- `GET /api/recovery/logs?lines=300` → backend and supervisor log, plus the
  tail of the last build log
- `POST /api/recovery/restart` with `{}` (retry), `{"rebuild": true}` (run
  `npm run build`, then retry) or `{"build": "last-good"}` → `202`. Then poll
  `/api/health` until you get `200`, or `503` again if it failed

Every `/api/recovery/*` call needs the **recovery token**:
`Authorization: Bearer <token>`.

```bash
curl -H "Authorization: Bearer $TOKEN" https://octipus.example.com/api/recovery/status
curl -H "Authorization: Bearer $TOKEN" "https://octipus.example.com/api/recovery/logs?lines=300"
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"build":"last-good"}' https://octipus.example.com/api/recovery/restart
```

Recovery mode has no shell. It can show you why the backend failed and run the
fixed set of actions above. A fix that needs a code or config change still
needs a way onto the machine.

### The token

`octi recovery` prints the token, the current mode and the URL. The token is
created on the first `octi start` in `~/.octipus/recovery-token` (mode 0600),
or set it yourself with `OCTIPUS_RECOVERY_TOKEN`. **Save it somewhere you can
reach when you are away**, such as a password manager. Without it, recovery
mode can show you that the backend is down but nothing more.

In Docker, the token file does not outlive the container: set
`OCTIPUS_RECOVERY_TOKEN` in the container environment.

Only reach the recovery endpoints over HTTPS (your domain or tunnel), as you
would the rest of the API.

## Files

| Path | What |
| --- | --- |
| `~/.octipus/supervisor.json` | Current mode, attempts, last good build (`octi status` reads it) |
| `~/.octipus/recovery-token` | Recovery token |
| `~/.octipus/backend.log` | Supervisor and backend log (`octi logs`) |
| `~/.octipus/restart.log` | Output of a restart handed off from inside Octipus |
| `<checkout>/.last-good-build/` | Last build that stayed up; `build.json` names its commit |

## Settings

| Variable | Default | |
| --- | --- | --- |
| `OCTIPUS_BOOT_TIMEOUT_MS` | `120000` | How long a boot may take to answer `/api/health` |
| `OCTIPUS_BOOT_RETRIES` | `2` | Retries of the current build after a failed boot, before the last good one (`0`: none) |
| `OCTIPUS_RECOVERY_TOKEN` | (file) | Token instead of `~/.octipus/recovery-token` |
| `OCTIPUS_LAST_GOOD_DIR` | `<checkout>/.last-good-build` | Where the last good build is kept |

`octi start --dev` (hot reload) runs without the supervisor, as before.
Windows (`octi.cmd`) does not use it yet.
