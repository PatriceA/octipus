'use client';

import { Mic, MicOff, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

/**
 * Compact composer matching the TUI's prompt row: leading `❯` glyph
 * (turns red on speech recognition active), single-line dim border,
 * blue accent on focus. Send / mic are square framed buttons rather
 * than rounded chips.
 */
export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      setSpeechSupported(true);
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        setInput(transcript);
      };

      recognition.onend = () => setIsListening(false);
      recognition.onerror = () => setIsListening(false);
      recognitionRef.current = recognition;
    }
  }, []);

  const toggleListening = () => {
    if (!recognitionRef.current) return;
    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const handleSend = () => {
    if (!input.trim() || disabled) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div className="border-t border-outline-variant/60 p-3 bg-surface-container-lowest">
      <div className="flex gap-2 items-stretch font-mono">
        <div className="relative flex-1">
          <span
            aria-hidden
            className={cn(
              'absolute left-2 top-1/2 -translate-y-1/2 font-bold transition-colors text-sm',
              isListening ? 'text-error' : input ? 'text-primary' : 'text-outline-variant',
            )}
          >
            ❯
          </span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder={isListening ? 'listening…' : 'send a message…'}
            className={cn(
              'w-full pl-7 pr-3 py-2 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary transition-colors',
              isListening && 'border-error',
            )}
            disabled={disabled}
          />
        </div>
        {speechSupported && (
          <button
            onClick={toggleListening}
            disabled={disabled}
            className={cn(
              'px-2.5 rounded-xs border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
              isListening
                ? 'border-error bg-error-container/40 text-error hover:bg-error-container'
                : 'border-outline-variant/60 bg-surface-container-low text-on-surface-variant hover:text-on-surface hover:border-outline',
            )}
            title={isListening ? 'Stop listening' : 'Voice input'}
          >
            {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>
        )}
        <button
          onClick={handleSend}
          disabled={disabled || !input.trim()}
          className="px-3 rounded-xs bg-primary text-on-primary cursor-pointer hover:bg-primary-dim disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 text-[12px]"
        >
          <Send className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">send</span>
        </button>
      </div>
    </div>
  );
}
