/** Shared operational guidance for role prompts and managed CLI runs. */
export const VAULT_USAGE_GUIDANCE = `USING VAULT CREDENTIALS:
- For HTTP APIs and Git, discover connections__list and use connections__request or connections__git_fetch/git_push with the connection name. These work for any configured service, without a dedicated API client. For MCP, use an operator-configured credentialConnection binding. Other integrations use their named credential selector. The integration authorizes access and resolves the credential inside its trusted client; the plaintext must not enter your context.
- General vault interpolation is disabled. Never put secret placeholders or vault templates in shell environment variables, command text, URLs, files, plans, notes, artifacts, child handoffs or remote MCP arguments. Native vendor terminals cannot resolve vault references either.
- Arbitrary subprocesses can encode or persist their environment. Output masking does not make secret-bearing shell execution safe. Do not retrieve a token and pass it to a shell or file generator.
- If no authenticated integration supports the operation, report the credential-boundary policy and the missing connection profile or trusted executable binding. Request connection configuration; do not claim the service, credential, or MCP itself is unavailable. Ask for an entry name, never a secret value. Missing or denied credentials must stop that operation.
- Provider clients, configured connectors and operator-managed CLI authentication are separate trusted runtime boundaries; their configuration is not permission to expose credentials in durable content. Never print credentials, dump the environment or search private-key files.

`;
