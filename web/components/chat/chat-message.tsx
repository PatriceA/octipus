'use client';

import { Bot, User, Zap } from 'lucide-react';
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

export function ChatMessage({ message }: ChatMessageProps) {
  const meta = message.metadata;

  return (
    <div
      className={cn(
        'flex gap-3',
        message.role === 'user' ? 'justify-end' : 'justify-start'
      )}
    >
      {message.role !== 'user' && (
        <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center flex-shrink-0">
          <Bot className="w-5 h-5 text-blue-600 dark:text-blue-400" />
        </div>
      )}
      <div
        className={cn(
          'max-w-[70%] px-4 py-2 rounded-lg',
          message.role === 'user'
            ? 'bg-primary-600 text-white'
            : message.role === 'system'
            ? 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 italic'
            : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
        )}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <p className="text-xs opacity-60" suppressHydrationWarning>
            {message.timestamp.toLocaleTimeString()}
          </p>
          {message.classification && message.classification !== 'casual' && (
            <span className="text-xs opacity-50 font-mono">
              [{message.classification}]
            </span>
          )}
          {/* Metadata bar for assistant messages */}
          {message.role === 'assistant' && meta && (
            <span className="text-xs opacity-50 font-mono flex items-center gap-1">
              {meta.cached && <Zap className="w-3 h-3 text-yellow-500" />}
              {meta.model && <span>{meta.model}</span>}
              {meta.tokens != null && <span>{meta.tokens}t</span>}
              {meta.latencyMs != null && <span>{meta.latencyMs}ms</span>}
            </span>
          )}
        </div>
      </div>
      {message.role === 'user' && (
        <div className="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center flex-shrink-0">
          <User className="w-5 h-5 text-white" />
        </div>
      )}
    </div>
  );
}
