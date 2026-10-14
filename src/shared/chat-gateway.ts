/**
 * Chat limits and names shared by the gateway (`src/core/gateway`) and its
 * clients (the web chat page, the TUI). Dependency-free, so the web bundle
 * can import the values without the protocol's schemas.
 */

/** Longest `chat.send` content, in characters (the server refuses longer with INVALID_MESSAGE). */
export const CHAT_MESSAGE_MAX_CHARS = 100_000;

/**
 * Largest base64 `data` of one inline `chat.send` attachment: the default
 * `gateway.maxFrameBytes`, since the attachment travels in the same frame.
 * Clients upload files over REST (`POST /sessions/:id/attachments`) and send
 * `fileRefs` instead; inline attachments are for small files only.
 */
export const CHAT_INLINE_ATTACHMENT_MAX_CHARS = 262_144;

/**
 * The resource a connection subscribes to while it shows the chat page. An
 * in-app delivery (`webchat:<userId>`) counts as delivered only when one of
 * the user's connections holds it: nothing else renders a proactive
 * `chat.message`.
 */
export const CHAT_INBOX_RESOURCE = 'chat:inbox';

/**
 * The external messaging channels: the only ones with outbound chat ids. A
 * session of one of them takes its turns outside any gateway connection, so
 * the web chat sees its new messages only by refetching them.
 */
export const EXTERNAL_CHANNEL_TYPES = ['telegram', 'slack', 'teams', 'whatsapp'] as const;
