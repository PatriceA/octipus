# Building a Channel Adapter

Built-in channel adapters bridge external messaging platforms through the Unified Message Interface (UMI). Gateway clients use a separate WebSocket frame schema; adapters are in-process classes.

## Architecture

```
External Platform (e.g., Slack, Teams, custom platform)
    │
    ▼
YourChannel extends BaseChannel (your code)
    │
    ├── emitMessage()  ──► UMI ──► Gateway Hub ──► Root agent
    │
    ◄── send()         ◄── UMI ◄── Gateway Hub ◄── Root agent response
    ◄── setReaction()  ◄── UMI ◄── Gateway Hub ◄── Feedback emoji
    ◄── sendTyping()   ◄── UMI ◄── Gateway Hub ◄── Typing indicator
```

## Creating an Adapter

### 1. Extend BaseChannel

The following is SDK-specific pseudocode, not a drop-in implementation. Define
and type `MyPlatformClient`, load credentials through the config/vault integration,
and map real message IDs and error handling before using it.

```typescript
// src/channels/my-platform/index.ts
import { BaseChannel } from '../interface';
import type { ChannelResponse, ChannelType } from '@/core/types';

export class MyPlatformChannel extends BaseChannel {
  readonly type: ChannelType = 'my-platform';
  readonly name = 'My Platform';

  private client: MyPlatformClient | null = null;

  async connect(): Promise<void> {
    // Initialize your platform SDK
    this.client = new MyPlatformClient(process.env.MY_PLATFORM_TOKEN);

    // Bridge: platform messages → channel
    this.client.on('message', (msg) => {
      this.emitMessage(
        this.createUnifiedMessage(msg.channelId, msg.author.id, msg.content, {
          userName: msg.author.username,
          metadata: { messageId: msg.id },
        })
      );
    });

    await this.client.connect();
    this.setConnected(true);
  }

  async disconnect(): Promise<void> {
    await this.client?.disconnect();
    this.setConnected(false);
  }

  // Channel sends response → deliver to platform
  async send(channelId: string, response: ChannelResponse): Promise<string> {
    await this.client.sendMessage(channelId, response.content);
    return 'message-sent';
  }

  // Optional: emoji reactions
  async setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.client.addReaction(messageId, emoji);
  }

  // Optional: typing indicator
  async sendTyping(channelId: string, active: boolean = true): Promise<void> {
    if (active) {
      await this.client.startTyping(channelId);
    }
  }
}
```

### 2. Make the channel discoverable

Export a `BaseChannel` instance or a constructible subclass from
`src/channels/<name>/index.ts`. `src/channels/discovery.ts` discovers it;
`src/channels/index.ts` registers discovered channels with UMI. Override
`isEnabled(config)` to gate startup on configured credentials, following a
sibling adapter. Register any new settings and secret mappings, and verify the
channel is also present in the production bundle.

### 3. Add ChannelType

Add your channel type to `src/core/types.ts`:

```typescript
// Append 'my-platform' to the existing ChannelType union.
// Preserve existing API/test channel members.
```

And update the configuration schema in `src/config/schema.ts` to include settings for your channel if needed.

## Channel Interface

### Methods to Override

Your channel must implement these abstract methods from `BaseChannel`:

**`connect(): Promise<void>`** — Initialize the channel
```typescript
async connect(): Promise<void> {
  // Set up client, register event listeners, connect to platform
  this.setConnected(true);
}
```

**`disconnect(): Promise<void>`** — Clean up and disconnect
```typescript
async disconnect(): Promise<void> {
  // Close connections, clear state
  this.setConnected(false);
}
```

**`send(channelId: string, response: ChannelResponse): Promise<string>`** — Deliver a response to the user
```typescript
async send(channelId: string, response: ChannelResponse): Promise<string> {
  // response.content — message text
  // response.attachments — array of files to send
  // response.replyTo — optional message ID to reply to
  // response.threadId — optional thread to post in
  // Return the platform-specific message ID
}
```

### Optional Methods

**`setReaction(channelId: string, messageId: string, emoji: string): Promise<void>`** — Add emoji reaction
```typescript
async setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
  // Add emoji to a message (skip if platform doesn't support)
}
```

**`sendTyping(channelId: string, active: boolean): Promise<void>`** — Typing indicator
```typescript
async sendTyping(channelId: string, active: boolean = true): Promise<void> {
  // Show/hide typing indicator (skip if platform doesn't support)
}
```

### Sending Messages from Your Platform

When a user sends a message on your platform, emit it to the UMI:

```typescript
this.emitMessage(
  this.createUnifiedMessage(
    'channel-123',              // Platform-specific chat/channel ID
    'user-456',                 // Platform user ID
    'Hello!',                   // Message text
    {
      userName: 'Alice',        // Display name (optional)
      attachments: [],          // Optional file attachments
      threadId: 'thread-1',     // Optional thread/reply chain
      metadata: { messageId: 'msg-789' },  // Platform-specific metadata
    }
  )
);
```

### Connection State Changes

Update the connection state when the channel connects or disconnects:

```typescript
this.setConnected(true);   // Connected
this.setConnected(false);  // Disconnected
```

To emit errors, use:

```typescript
this.emitError(new Error('Connection failed'));
```

## Testing

Test your channel by subscribing to UMI events:

```typescript
import { MyPlatformChannel } from './my-platform';
import { getUMI } from '@/channels';

const channel = new MyPlatformChannel();
const umi = getUMI();
umi.register(channel);

// Listen for messages from the platform
const messages: any[] = [];
umi.on('message', (msg) => {
  messages.push(msg);
});

await channel.connect();

// Simulate platform message
channel.emitMessage(
  channel.createUnifiedMessage('ch-1', 'u-1', 'test', {
    userName: 'Alice',
  })
);

expect(messages).toHaveLength(1);
expect(messages[0].content).toBe('test');

await channel.disconnect();
```
