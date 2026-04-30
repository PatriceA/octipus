# Building a Channel Adapter

Channel adapters bridge external messaging platforms to Octipus via the Gateway protocol.

## Architecture

```
External Platform (e.g., Discord)
    │
    ▼
GatewayAdapter (your code)
    │
    ├── emitMessage()  ──► Gateway Hub ──► Orchestrator
    │
    ◄── handleSend()   ◄── Gateway Hub ◄── Orchestrator response
    ◄── handleReact()  ◄── Gateway Hub ◄── Feedback emoji
    ◄── handleTyping() ◄── Gateway Hub ◄── Typing indicator
```

## Creating an Adapter

### 1. Extend GatewayAdapter

```typescript
// src/channels/adapters/discord-adapter.ts
import { GatewayAdapter } from '../adapter-base';
import type { GatewayToAdapter } from '../adapter-base';
import type { ChannelType } from '@/core/types';

export class DiscordGatewayAdapter extends GatewayAdapter {
  readonly channelType: ChannelType = 'discord';
  readonly name = 'Discord';

  private client: any = null;

  async start(): Promise<void> {
    // Initialize your platform SDK
    this.client = new DiscordClient(process.env.DISCORD_TOKEN);

    // Bridge: platform messages → gateway
    this.client.on('message', (msg) => {
      this.emitMessage({
        channel: 'discord',
        channelId: msg.channelId,
        userId: msg.author.id,
        userName: msg.author.username,
        content: msg.content,
        metadata: { messageId: msg.id },
      });
    });

    await this.client.connect();
    this.emitStatus(true);
  }

  async stop(): Promise<void> {
    await this.client?.disconnect();
    this.emitStatus(false);
  }

  // Gateway sends response → deliver to platform
  async handleSend(payload: GatewayToAdapter['channel.send']): Promise<void> {
    await this.client.sendMessage(payload.channelId, payload.content);
  }

  // Optional: emoji reactions
  async handleReact(payload: GatewayToAdapter['channel.react']): Promise<void> {
    await this.client.addReaction(payload.messageId, payload.emoji);
  }

  // Optional: typing indicator
  async handleTyping(payload: GatewayToAdapter['channel.typing']): Promise<void> {
    if (payload.active) {
      await this.client.startTyping(payload.channelId);
    }
  }
}
```

### 2. Register with the Gateway

Add your adapter to the channel initialization in `src/channels/index.ts`:

```typescript
import { DiscordGatewayAdapter } from './adapters/discord-adapter';

// In initializeChannels():
if (config.discord?.enabled) {
  const adapter = new DiscordGatewayAdapter();
  adapterRegistry.register(adapter);
}
```

### 3. Add ChannelType

Add your channel type to `src/core/types.ts`:

```typescript
export type ChannelType = 'telegram' | 'slack' | 'teams' | 'whatsapp' | 'webchat' | 'discord';
```

## Adapter Protocol

### Messages You Send (Adapter → Gateway)

**`channel.message`** — When a user sends a message on the platform:
```typescript
this.emitMessage({
  channel: 'discord',        // Your channel type
  channelId: '123456',       // Platform-specific chat/channel ID
  userId: 'user789',         // Platform user ID
  userName: 'Alice',         // Display name (optional)
  content: 'Hello!',         // Message text
  attachments: [],            // Optional file attachments
  threadId: 'thread1',       // Optional thread/reply chain
  metadata: { messageId: 'msg1' },  // Platform-specific metadata
});
```

**`channel.status`** — Connection state changes:
```typescript
this.emitStatus(true);                    // Connected
this.emitStatus(false, 'Token expired');  // Disconnected with reason
```

### Messages You Receive (Gateway → Adapter)

**`handleSend`** — Deliver a response to the user:
```typescript
async handleSend(payload) {
  // payload.channelId — where to send
  // payload.content — message text
  // payload.replyTo — optional message ID to reply to
  // payload.threadId — optional thread to post in
}
```

**`handleReact`** — Add emoji reaction (optional):
```typescript
async handleReact(payload) {
  // payload.messageId — message to react to
  // payload.emoji — emoji string (e.g., '✅')
}
```

**`handleTyping`** — Typing indicator (optional):
```typescript
async handleTyping(payload) {
  // payload.channelId — where to show typing
  // payload.active — true to start, false to stop
}
```

## Testing

Mock the gateway send callback in tests:

```typescript
import { DiscordGatewayAdapter } from './discord-adapter';

const adapter = new DiscordGatewayAdapter();
const sent: any[] = [];
adapter.setGatewaySend((type, payload) => sent.push({ type, payload }));

// Simulate platform message
adapter.emitMessage({ channel: 'discord', channelId: '1', userId: 'u1', content: 'test' });

expect(sent).toHaveLength(1);
expect(sent[0].type).toBe('channel.message');
```
