# Install Octipus

## Before you start

- **Node.js 24.19.0 or newer, including npm**, and Git. Check `node --version` and `npm --version` before installing. Node 24.9 introduced the required crypto API but has a module-loader bug; 24.19 is the supported minimum used by CI. After upgrading Node, open a new terminal and check again.
- Linux/macOS/WSL: Bash and curl. Windows: PowerShell and Git for Windows. Native dependencies may need your platform's C/C++ build tools and Python if a prebuilt package is unavailable.
- A model: an API key for a hosted provider, or a running Ollama with a downloaded model. Embedded storage does not require Docker, PostgreSQL, Redis, or Valkey. Local models need additional RAM/disk space according to the model.
- Vendor CLI subscriptions are another option: install and authenticate the vendor CLI separately, then add its CLI model in Models. Provider policies and billing determine whether subscription use is allowed or charged separately.

## One-command installer

Linux, macOS, or WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/PatriceA/octipus/main/scripts/install.sh | bash -s -- --quick
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/PatriceA/octipus/main/scripts/install.ps1))) -Quick
```

`--quick` / `-Quick` is the recommended first run: embedded storage, default data directory, host and port, five prompts (admin username and password, provider, API key or URL, model), no optional installs, and it finishes by starting the backend and web UI and opening the browser. Leave the flag off for the full wizard described below; `octi setup` can be rerun at any time to change anything.

The installer checks prerequisites, clones `main`, installs the locked backend, web, and MCP packages, builds them, audits all three dependency trees, installs the `octi` command, and opens terminal setup. Node and Git must already be installed. This is a source installation of the current development branch, not a pinned release binary.

The Unix checkout defaults to `~/.octipus/app`, with `octi` in `~/.local/bin`. Add the printed PATH line to your shell profile if necessary. Windows uses `%USERPROFILE%\.octipus\app` and adds its command directory to your user PATH. Open a new terminal to pick up PATH changes. The printed absolute CLI path works immediately.

Setup selects storage (embedded is the default), generates secrets, creates an administrator, saves provider settings and a default model, and offers optional capabilities. It temporarily starts the backend and shuts it down after setup. Model credentials are configured, but a paid inference is not automatically run: send a first chat message to verify the connection.

```bash
octi start web       # starts backend and web UI
# Open http://localhost:3007; log in with the setup account.
octi doctor
octi status
octi logs
octi tui             # terminal chat, while backend is running
octi stop
```

Local defaults: API **3005**, web **3007**. There is no separate web setup page. `octi start` alone starts only the backend. Processes are managed locally; the native installer does not install an automatic boot service.

Unix flags: `--quick` (five-prompt setup that ends running); `--start` starts the web stack after the full wizard; `--desktop` also installs Rust/Tauri prerequisites; `--skip-setup` installs/builds only; `--non-interactive` reads setup environment variables. Pass flags after `bash -s --`. Windows equivalents are `-Quick`, `-Start`, `-SkipSetup`, `-NonInteractive`, and `-Desktop` (prints the Rust, WebView2 and Build Tools prerequisites, which are installed separately). Windows also needs `curl.exe`, which ships with Windows 10 1803 and later.

The `octi` command exposes the same subcommands on both platforms: the Windows batch launcher hands anything it does not implement itself (`capabilities`, `models`, `persona`, `plugin`, `version`) to the TypeScript dispatcher, and the Unix binary forwards `start`, `stop`, `status`, `logs`, `open`, `desktop` and `uninstall` to the bash launcher. `octi doctor` reads the checkout's `.env` and asks the running backend for provider status, so it reports the configuration the setup wizard actually wrote.

For example, to install and start in one invocation:

```bash
curl -fsSL https://raw.githubusercontent.com/PatriceA/octipus/main/scripts/install.sh | bash -s -- --start
```

## Manual source installation

```bash
git clone https://github.com/PatriceA/octipus.git
cd octipus
npm ci
npm --prefix web ci
npm --prefix mcp-server ci
npm run audit:all
npm run build
npm --prefix web run build
npm --prefix mcp-server run build
npm run setup
node bin/octi.mjs start web
```

Use `node bin/octi.mjs` instead of `octi` unless you install a PATH launcher. `npm run build:cli` creates `dist/octi` for Unix; it still requires Node and the checkout. For development, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Audits and updates

`npm run audit:all` checks backend, web, and MCP dependencies, including development/build packages. It checks every package even if an earlier audit fails and returns a nonzero status for vulnerabilities or registry errors. Installers show audit warnings and continue; they do not silently rewrite the lockfiles. Internet access to the npm audit registry is needed.

Review reported fixes in the affected package. Do not blindly use `npm audit fix --force`: it can downgrade or break tooling. The current backend audit includes a development-only esbuild advisory through drizzle-kit for which npm suggests a breaking downgrade. Web and MCP receive compatible lockfile fixes when available.

Before updating, back up `.env` together with your database/data directory: `MASTER_KEY` is needed to decrypt the vault. Stop the running instance, then rerun the installer. It refuses a dirty checkout or a failed fast-forward update. Existing setup preserves storage, ports, and secrets; use the existing admin credentials. For an account using TOTP, supply `OCTIPUS_SETUP_TOTP` for that login. Remote setup is explicit: `octi setup --remote http://host:port`.

## Headless setup

Set these variables in your environment or secret manager, then run the installer with `--non-interactive` (or `npm run setup -- --non-interactive` in a built checkout):

```bash
export OCTIPUS_SETUP_STORAGE=embedded
export OCTIPUS_SETUP_ADMIN_USER=admin
export OCTIPUS_SETUP_ADMIN_PASS='choose-a-unique-strong-password'
export OCTIPUS_SETUP_PROVIDER=ollama
export OCTIPUS_SETUP_MODEL='your-installed-model'
export OCTIPUS_SETUP_BASE_URL=http://localhost:11434
```

For a hosted provider, select its provider ID/model and set `OCTIPUS_SETUP_API_KEY`. For external storage, set `OCTIPUS_SETUP_STORAGE=external` and `OCTIPUS_SETUP_DATABASE_URL` to an existing PostgreSQL database with pgvector. External services are not created by native setup. Additional variables are documented in [setup-wizard.ts](../scripts/setup-wizard.ts).

## Docker

Docker installation requires Git, Docker with Compose v2, and OpenSSL; host Node/npm is unnecessary:

```bash
git clone https://github.com/PatriceA/octipus.git
cd octipus
bash scripts/install-docker.sh
```

This creates `.env.compose` with random secrets, builds/starts PostgreSQL and Octipus, waits for health, and runs terminal setup inside the container. Keep `.env.compose` with your backups. The defaults are web **3017**, API **3015**, and database **5442** on the host. Open `http://localhost:3017`. Use `docker compose --env-file .env.compose logs`, `stop`, or `up -d` to manage it. Do not replace existing deployment secrets with newly generated ones: for an existing stack, continue using its existing Compose environment file.

Container tools and local model URLs refer to the container's environment: host CLI logins, host files, and `localhost` model servers are not automatically available. See [DOCKER.md](DOCKER.md).
