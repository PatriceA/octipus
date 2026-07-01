# Octipus Codebase Robustness Analysis

## 1. Orchestrator and Agent Functionality
**Observations:**
- The `AgentWorker` implementation (`agent-worker.ts`) manages execution timelines robustly by preventing background LLM execution or tools from ticking against orchestrator timeouts using detached processes and `raceTimeout` wrappers. Early timeout leaks are correctly handled via cleanup (`clearTimeout` within a `finally` block).
- However, the `ApprovalManager` (`approval-manager.ts`) relies on a global `this.pendingApprovals` map that tracks all pending approvals across all sessions/users.

**Missing Error Handling / Bugs:**
- **Global Chat Approval Resolution Bug**: `tryResolveFromMessage(message)` has a critical flaw: `if (this.pendingApprovals.size !== 1) return false;`. Because `pendingApprovals` is a global map, if *any* two users (or two distinct agents) trigger an approval concurrently, the global size becomes >1, silently breaking chat-based resolution (e.g. "yes", "approve") for all users.
- **Hardcoded Approval Timeouts**: `ApprovalManager` automatically rejects pending approvals after exactly 1 hour (`3600000` ms). This is inflexible and will abort long-running overnight agents or workflows where the user steps away for an extended period.

**Recommendations:**
- Refactor `tryResolveFromMessage` to accept a `userId` argument and filter pending approvals down to only those owned by the user before performing the size check.
- Move the 1-hour hardcoded timeout in `requestApproval` to an agent-level configuration or pass it dynamically based on the orchestrator's timeout parameters.

## 2. Permissions UI and Prompts
**Observations:**
- Permissions and Approvals are handled via a Context API in the WebUI (`global-permission-banner.tsx` and `approval-card.tsx`). Approvals take precedence over permissions for display.

**Missing UI States / UX Improvements:**
- **Blind Sequential Approvals**: `GlobalPermissionBanner` only displays the single most recent permission or approval (`permissions[permissions.length - 1]`). If multiple permissions stack up, it displays a small `+X more` badge, but provides no interactive UI to view the queued items, page through them, or "Approve All". The user is forced to accept/deny the active prompt blindly to see what comes next.
- **Silent Chat Resolution Failures**: Due to the backend bug in `tryResolveFromMessage`, when `+X more` is active, answering "yes" in chat will silently fail. The user might think they approved it, but the UI banner remains stuck until explicitly clicked.

**Recommendations:**
- Implement a carousel or list-view toggle in `GlobalPermissionBanner` so users can review all pending actions.
- Provide a "Review All" modal and "Allow All" button for scenarios where an agent generates many tool authorization prompts in a batch.

## 3. Tool Use and Discovery
**Observations:**
- The tool registry leverages a localized auto-discovery mechanism (`src/tools/discovery.ts`) that correctly suppresses missing/broken import errors and logs warnings, which adds robustness during startup.

**Missing Error Handling / Bugs:**
- **Tool Availability Cache Bypass**: In `ToolRegistry.getToolHandlersForTools(toolIds)`, the tool availability check reads from a 60-second cache (`this.availabilityCache`). It explicitly skips a tool if the cache entry indicates it's unavailable. However, if the cache entry does *not* exist or has expired, it immediately assumes the tool is available and serves the handlers to the LLM without actually running `checkAvailability()`. This can provide the LLM with fundamentally broken tools (e.g. invalid credentials), causing confusing runtime crashes.
- **Silent MCP Server Loss**: The MCP Bridge (`src/mcp/bridge.ts`) listens for `transport.onClose` and sets the server status to `disconnected`, but implements *no automatic reconnection logic*. If an external MCP server crashes or the OS kills the process temporarily, it will permanently be lost to the agent unless the user manually toggles it in settings or restarts the app.

**Recommendations:**
- Update `ToolRegistry.getToolHandlersForTools` to eagerly resolve `checkAvailability` synchronously or ensure `checkAllAvailability` runs proactively before tools are pulled.
- Implement exponential backoff auto-reconnect logic in the MCP bridge upon receiving unexpected `transport.onClose` events.

## 4. Skill Use and Discovery
**Observations:**
- Skill discovery leverages a strong hybrid approach (`always_inject`, `triggers`, `vector`, `stale_fallback`).
- The `external-loader.ts` safely validates file sizes and enforces the presence of required fields (`name`, `description`) in frontmatter using regex validation.

**Missing Error Handling / Bugs:**
- **Brittle YAML Frontmatter Parsing**: While `external-loader` uses robust regex to verify required fields, the actual markdown parser (`src/skills/markdown.ts`) uses a naive `frontmatter.split('\n')` and string-slicing at the first `:`. This completely fails to parse multi-line strings, YAML lists, or objects. If a skill author writes a multi-line description, it will be brutally truncated to the first line, and subsequent lines will be silently ignored.

**Recommendations:**
- Replace the naive split/slice frontmatter parser in `src/skills/markdown.ts` with a standard, robust YAML parser library (e.g., `js-yaml`) to support standard frontmatter structures properly and avoid silent data loss on multi-line descriptions.
