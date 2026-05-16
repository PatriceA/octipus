'use client';

import { Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MessageMetadata {
  model?: string;
  tokens?: number;
  latencyMs?: number;
  cached?: boolean;
}

export interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  agentId?: string;
  classification?: string;
  metadata?: MessageMetadata;
}

interface ChatMessageProps {
  message: ChatMessageData;
}

/**
 * TUI-style chat row. Matches the role-prefixed layout of
 * `src/tui-pi/components/messages-pane.ts`:
 *
 *   ❯  user message goes here
 *      assistant message goes here
 *   ·  system message goes here
 *
 * No bubbles, no avatars — colour + prefix is enough to disambiguate
 * roles in a mono terminal. The metadata footer is dim and tabular.
 */
export function ChatMessage({ message }: ChatMessageProps) {
  const meta = message.metadata;

  const prefix =
    message.role === 'user' ? '❯' :
    message.role === 'system' ? '·' :
    ' ';

  const prefixColor =
    message.role === 'user' ? 'text-primary' :
    message.role === 'system' ? 'text-outline-variant' :
    'text-outline-variant';

  const bodyColor =
    message.role === 'user' ? 'text-on-surface' :
    message.role === 'system' ? 'text-on-surface-variant italic' :
    'text-on-surface';

  return (
    <div className="font-mono group">
      <div className="flex gap-2 items-baseline">
        <span aria-hidden className={cn('shrink-0 w-3 text-center font-bold', prefixColor)}>
          {prefix}
        </span>
        <div className={cn('flex-1 min-w-0 text-[13px] leading-relaxed whitespace-pre-wrap break-words', bodyColor)}>
          {message.content}
        </div>
      </div>
      <div className="flex items-center gap-3 mt-0.5 pl-5 text-[10px] text-outline opacity-0 group-hover:opacity-100 transition-opacity">
        <span suppressHydrationWarning>{message.timestamp.toLocaleTimeString()}</span>
        {message.classification && message.classification !== 'casual' && (
          <span>[{message.classification}]</span>
        )}
        {message.role === 'assistant' && meta && (
          <span className="flex items-center gap-1.5 tabular-nums">
            {meta.cached && <Zap className="w-3 h-3 text-warning" />}
            {meta.model && <span>{meta.model}</span>}
            {meta.tokens != null && <span>· {meta.tokens}t</span>}
            {meta.latencyMs != null && <span>· {meta.latencyMs}ms</span>}
          </span>
        )}
      </div>
    </div>
  );
}
