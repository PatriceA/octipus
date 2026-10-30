# Authenticated connections

The generic `connections` tool replaces vault interpolation in shell environments.
It supports HTTP APIs and Git without installing a separate client for each service.
MCP transports can use the same named profiles. General shell, file and tool-argument
interpolation remains blocked by `credential-boundary`.

## Set up an API token in the UI

1. Open **Secrets → Add Secret** and save the token. Leave **Set up API access
   after saving** selected, or choose **Connect API** beside an existing secret.
2. Enter a connection name (the name you tell the agent), the server origin
   (protocol + host + optional port), and the allowed API path prefix.
3. Select the service's authentication scheme. The token comes from the vault;
   do not paste it again. Select GET for read-only access, and only add methods
   that the API needs. HTTP requires an explicit unencrypted-transport choice.
4. Save the API connection. It appears below the secret, and authorized agents
   can discover it immediately with `connections__list`; no restart is needed.

For SonarQube 9.x, use **Basic token (empty password)**. For example: name
`sonarqube`, origin `https://sonarqube.example.com`, path `/api`, GET only. Newer SonarQube
versions also support bearer tokens; use the authentication documented for the
installed version. [SonarQube 9.9 authentication documentation](https://docs.sonarsource.com/sonarqube-server/9.9/extension-guide/web-api).

For Appwrite, enter the origin without `/v1`
(for example `https://appwrite.example.com`), path `/v1`, authentication **API key
header**, header name `X-Appwrite-Key`, and leave its prefix empty. Add your
project ID as the public header `X-Appwrite-Project`. Public headers contain
non-secret settings only, and agents cannot override them. The API key remains
in the vault; do not add it as a public header. Select only the methods needed
for the task; GET is enough for reads. [Appwrite REST authentication](https://appwrite.io/docs/apis/rest).

Storing a token alone does not approve a destination. Provider/channel cards
already configure their own clients; arbitrary API tokens need the connection
step above. The API setup screen stores only connection settings alongside the
credential metadata. It does not read the token or reset its access restrictions.
Removing an API connection leaves the secret in the vault.

### Self-signed or expired HTTPS certificates

Normal certificate verification is the default. For a device such as OPNsense,
the credential owner can choose **Certificate trust → Trust one exact certificate**,
then **Inspect server certificate**. Inspection sends no HTTP request or vault
credentials. Check the server and fingerprint, select the explicit trust checkbox,
and save. The connection then accepts only that exact SHA-256 certificate,
including an otherwise invalid issuer, expiry or hostname. A replacement
certificate requires another inspection and approval; requests fail before
sending authentication when the fingerprint changes.

This exception belongs to one approved HTTPS connection. It does not change
global TLS settings or public-network validation. The approval fingerprint and
origin are recorded in the credential audit. Select **Normal certificate
verification** and save to remove the exception. OPNsense uses Basic authentication
with its API key as the username (choose its vault-entry name) and API secret as
the password; the path prefix is `/api`.

Ordinary users can approve public API destinations. Public requests use the
existing public-address validation and pinned DNS transport, including after DNS
changes. Administrators can approve internal/LAN servers. This permission is
recorded by the server and cannot be supplied in a setup request. Personal API
connections cannot be used in shared-space sessions.

## Advanced operator configuration (Git and MCP)

Simple HTTP APIs can be configured in the UI above. Operator profiles remain
available for Git, explicitly trusted MCP servers, and managed deployments.

The operator maintains `~/.octipus/credential-connections.json` (or the server's
`OCTIPUS_CONNECTIONS_FILE`). It is a JSON array, owned by the backend's OS user,
not group/world writable, and outside the agent workspace. Use mode 0600.
There are **no secret values** in this file. Credential names refer to existing vault
entries; normal expiry, active-state and tool/agent ACLs still apply.

```json
[
  {
    "id": "jenkins",
    "userId": "YOUR-OCTIPUS-USER-ID",
    "workspaceId": null,
    "credential": "JENKINS_API_KEY",
    "http": {
      "origin": "https://jenkins.example.com",
      "auth": { "type": "basic", "usernameCredential": "JENKINS_USER" },
      "methods": ["GET", "POST"]
    }
  },
  {
    "id": "gitlab-api",
    "userId": "YOUR-OCTIPUS-USER-ID",
    "workspaceId": null,
    "credential": "GITLAB_TOKEN",
    "http": {
      "origin": "https://gitlab.example.com",
      "auth": { "type": "header", "name": "PRIVATE-TOKEN" },
      "pathPrefix": "/api/v4",
      "methods": ["GET", "POST", "PUT", "PATCH", "DELETE"]
    }
  },
  {
    "id": "gitlab-git",
    "userId": "YOUR-OCTIPUS-USER-ID",
    "workspaceId": null,
    "credential": "GITLAB_TOKEN",
    "http": {
      "origin": "https://gitlab.example.com",
      "auth": { "type": "basic", "username": "oauth2" },
      "methods": ["GET", "POST"],
      "git": true,
      "repositoryRoots": ["/srv/projects"]
    }
  }
]
```

`workspaceId: null` means this user's user-scoped credential across their own
workspaces; it **does not select workspace credential overrides**. An explicit
workspace id limits access to that workspace and permits its vault override.
Personal connections are refused from shared-space contexts. No fallback to
another user's or a system credential occurs.

Authentication supports bearer tokens, Basic authentication (a public username or
a second named vault credential), and custom credential headers with an optional
prefix. HTTP is refused unless `allowInsecureHttp: true` explicitly acknowledges
plaintext transport for that exact origin, such as an existing internal GitLab.
Private/LAN origins are intentional operator grants. Redirects are never followed.
An optional `pathPrefix` restricts the paths below that origin. There are no wildcard
hosts or agent-controlled authentication/routing headers.

Profiles are reread on new tool calls; adding an HTTP/Git profile needs no restart.
Installing this code or changing role tool grants does need a backend restart.
Default roles with shell access now include `connections`. Explicitly customized
roles retain their permissions and need an operator to add this tool group.

## API use

Discover `connections__list`. Use `connections__get` for GET requests, or
`connections__request` for other methods. Arguments contain only the connection
name, origin-relative path, query fields, optional non-authentication headers,
and a JSON object or form fields. For example:

```json
{"connection":"jenkins","path":"/job/example/42/api/json","query":{"tree":"result,building"}}
```

A build trigger uses `request` with POST and form parameters. Jenkins installations
that require a CSRF crumb can return it through a GET and accept it as a subsequent
non-authentication header. Normal tool authorization still applies to writes;
configuring a credential does not authorize triggering a build.

Results include status, `ok`, and redacted JSON/text (maximum 4 MiB). A redirect,
login page, authorization failure and missing connection configuration are distinct
from successful authentication. No response headers such as cookies are returned.
Requests default to 120 seconds; the explicit `timeout` also sizes the CLI bridge's
deadline. Timeouts after dispatch do not prove that a mutation had no effect.

## Git use

Use `connections__git_fetch` / `connections__git_push`, with a local `path`,
`remotePath` such as `/group/project.git`, and explicit `refspecs`. Fetch destinations
must be `refs/remotes/...` or `refs/tags/...`, for example:

```json
{"connection":"gitlab-git","path":"/srv/projects/example","remotePath":"/group/example.git","refspecs":["+refs/heads/main:refs/remotes/origin/main"]}
```

Git receives a temporary loopback URL, never the vault value, an authentication
environment variable or an authenticated remote URL. Only the selected Git protocol
operation is accepted by the broker. Network Git runs from a clean temporary bare
repository, ignoring repository-provided URL rewrites, proxies, hooks and helpers.
The approved repository's object store is shared; fetched ref updates are applied
transactionally with expected old values, so concurrent ref changes cause a failure.
No checkout is performed and the original FETCH_HEAD is not changed. Configured
repository roots must contain the actual Git metadata and object store too.

The temporary broker closes before the call returns. Fetch and push have separate
permission actions; push defaults to ASK. Transfers default to 10 minutes, accept
an explicit timeout, limit request bodies to 64 MiB and responses to 512 MiB.
The application server executes Git under the approved repository roots, so it does
not depend on the shell sandbox seeing the same mount paths.

## MCP bindings

An operator-configured MCP server can set `credentialConnection` to a profile id.
For HTTP/SSE servers the profile must list that exact server id in
`http.mcpServers`, and all endpoint URLs must match the approved origin/path.
Remote responses and errors are masked before protocol handling or persistence.
Credentials refresh at request time. HTTP requests honor caller cancellation and
have a bounded deadline. This cannot undo an operation already accepted remotely.

For stdio, the profile's `stdio` array must explicitly bind the server id, absolute
executable, exact args, absolute cwd, permitted environment values and credential
environment name:

```json
{"serverId":"example","command":"/usr/bin/node","args":["/opt/trusted-mcp/server.js"],"cwd":"/opt/trusted-mcp","env":{},"envName":"API_TOKEN"}
```

Server configuration cannot substitute a different executable, args, cwd or loader
environment. Startup is an explicit operator trust grant to this server; actual
agent ACLs are checked at dispatch. Discovery of tools, schemas, resource URIs and
prompts is also scoped to the profile principal. Credential-bound servers use the
scoped `mcp_list_tools` / `mcp_call_tool` path rather than global static advertisements.
Changing a profile or rotating a stdio credential requires reconnecting that server;
cached transports refuse further dispatch until then.

## Trust boundary

A configured service receives the credential for authentication. Its operator must
be trusted with it. Output masking covers raw values and common encodings, not
arbitrary transformations by a malicious service. Git pack data comes from the
trusted Git server and can become repository files. A deliberately malicious server
could encode authentication data into content; an exact-string scanner cannot
prevent that. Likewise an explicitly trusted stdio executable receives a secret in
its environment and can persist it. Its code, dependencies and files must be trusted.

Native host CLI access and operator configuration are trusted boundaries. An agent
with unrestricted native host access runs as that OS user and cannot be isolated
from that user's configuration by this file's permissions. Registered general
shell/file operations still cannot request vault interpolation. No claim is made
that these profiles safely supply secrets to arbitrary scripts, arbitrary MCP
arguments, untrusted local servers or arbitrary file generators.

### Logins for websites and HTTP Basic APIs

In **Secrets → Add Secret**, choose **Login (username + password)** and enter a name, username, password and domain, such as `https://example.com`. Both fields are encrypted together. The domain is an exact origin: protocol, hostname and port must match; subdomains are separate. HTTP requires explicit consent because it sends credentials without TLS. Logins may belong to your user or current workspace.

Tell your agent the entry name. `browser__fill_login` and `browser-ext__fill_login` take that name, an exact page/tab ID and the two input selectors. They fill visible username/password inputs on the saved origin, with a same-origin form action, without returning the credentials or submitting. The website and its own scripts are trusted recipients, as with a password manager. This cannot protect credentials from a malicious site on the approved domain or software controlling your browser.

A browser used for saved Logins blocks arbitrary JavaScript, cookie/storage access and raw screenshots/captures; normal navigation and page controls remain available. A context previously used for arbitrary agent scripts cannot receive a saved Login. Use a fresh browser context/profile instead. The Chrome extension must be reloaded after updating to version 2.1.0, and connected with your personal API token. Its protection persists across reconnects; reconnecting does not make an existing browser safe for arbitrary code.

For HTTP Basic APIs, choose **Connect API** on the Login entry, then approve the path and methods. Authentication uses both saved fields and the domain cannot be changed there. Internal servers require administrator approval; afterwards the owner can change only the certificate trust without broadening that approved connection. Public HTTPS certificate trust is available to each credential owner. Use the connection name with the existing `connections` tools.

**Edit Login** changes either field without displaying existing values. Leave a field blank to keep it. Changing the domain removes the saved API consent; approve the new destination again. Generic secret reads and rotation cannot expose or overwrite a Login bundle.

### JSON sign-in followed by Bearer tokens

For APIs that accept `{username, password}` in a JSON login body, choose **Saved Login (JSON sign-in and Bearer tokens)** in Connect API. HTTP Basic is a different protocol and will not populate that body. Configure the login endpoint, optional refresh endpoint and the API's JSON field names; optional `language` is a public login setting. Fields are top-level JSON names, not templates or executable expressions.

Saving this mode explicitly approves internal authentication POST requests to those endpoints, while **Allowed requests** still limits ordinary API calls. Both endpoints must stay on the saved Login origin and inside the approved path prefix. Redirects are refused. Login/refresh endpoints cannot be called as ordinary agent requests, and their responses never become tool results.

Octipus rechecks vault ownership, workspace, expiry and tool/agent access before every request, including when using a cached token. Tokens remain in bounded process memory; restart requires a new sign-in. It refreshes shortly before the returned `expires_in`, or uses the configurable fallback lifetime when no expiry is returned. Refresh-token rotation is supported. A rejected refresh (HTTP 400/401) permits one new sign-in; other refresh failures stop the request. An application request returning HTTP 401 is never replayed automatically, so a mutation cannot run twice as part of token recovery. The next request refreshes authentication.

For an API using a client-generated double-submit CSRF pair, enable **Generate a matching CSRF query parameter and header**. Octipus generates a fresh matching pair for login, refresh and resource requests. This mode does not implement cookie-derived CSRF challenges, CAPTCHA, MFA, nested JSON token paths, or arbitrary login scripts.

For SSP fd-dev specifically: domain `https://ssp-api-fd-dev.services.fintus.io`, prefix `/api`, login `/api/login`, refresh `/api/public/refresh-access-token`, language `de`, CSRF query `_csrf` and header `X-XSRF-TOKEN`. The defaults match its `access_token`, `refresh_token`, `expires_in` response and `{refreshToken}` refresh body. Agents should request a protected API resource using `ssp_login_fd_dev`; they should not manually submit `/api/login`.

Certificate trust is available for every personal/workspace HTTPS API entry, regardless of credential type. Owners can inspect and explicitly pin a public server's exact certificate. For an internal server already approved by an administrator, they can save a certificate change while preserving its existing origin, path, methods and authentication. New internal destinations or broader grants still require administrator approval. Public connections keep public-IP validation and DNS pinning even when a custom certificate is trusted.
