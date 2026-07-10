'use client';

import {
  AudioLines,
  FileText,
  Image,
  Mic,
  Music,
  Paperclip,
  Send,
  Square,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { VoiceState } from '@/hooks/useVoiceConversation';
import { cn } from '@/lib/utils';
import { AudioWaveform } from './audio-waveform';

const subscribeNoop = () => () => {};
const hasNativeSpeech = () =>
  !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
const getVoiceSupport = () => {
  if (hasNativeSpeech()) return 'native';
  if (typeof MediaRecorder !== 'undefined') return 'server';
  return 'none';
};
const getVoiceSupportServer = () => 'none' as const;

export interface Attachment {
  id: string;
  file: File;
  preview?: string;
  type: 'image' | 'file' | 'audio';
}

interface PromptInputProps {
  onSend: (message: string, attachments?: Attachment[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Live voice conversation mode (hands-free talk ↔ spoken reply). */
  voiceMode?: boolean;
  voiceState?: VoiceState;
  voiceError?: string | null;
  /** False when STT is unavailable (no whisper, no cloud key) — disables the toggle. */
  voiceAvailable?: boolean;
  onToggleVoiceMode?: () => void;
}

function getAttachmentType(file: File): Attachment['type'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}

function getAttachmentIcon(type: Attachment['type']) {
  switch (type) {
    case 'image':
      return Image;
    case 'audio':
      return Music;
    default:
      return FileText;
  }
}

function truncateFilename(name: string, maxLen = 20): string {
  if (name.length <= maxLen) return name;
  const ext = name.lastIndexOf('.');
  if (ext === -1) return name.slice(0, maxLen - 3) + '...';
  const extension = name.slice(ext);
  const base = name.slice(0, maxLen - extension.length - 3);
  return base + '...' + extension;
}

const ACCEPTED_TYPES =
  'image/*,audio/*,.txt,.md,.js,.ts,.py,.json,.csv,.html,.css';

const MAX_HISTORY = 50;

const VOICE_STATE_LABEL: Record<VoiceState, string> = {
  idle: 'starting…',
  listening: 'listening',
  transcribing: 'transcribing',
  thinking: 'thinking',
  speaking: 'speaking',
  error: 'mic error',
};

export default function PromptInput({
  onSend,
  disabled = false,
  placeholder = 'Type a message...',
  voiceMode = false,
  voiceState = 'idle',
  voiceError = null,
  voiceAvailable = true,
  onToggleVoiceMode,
}: PromptInputProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [browsingHistory, setBrowsingHistory] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const dragCounterRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-resize textarea
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 24;
    const maxHeight = lineHeight * 8;
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [text, resizeTextarea]);

  // Auto-focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Cleanup previews on unmount
  useEffect(() => {
    return () => {
      attachments.forEach((a) => {
        if (a.preview) URL.revokeObjectURL(a.preview);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const newAttachments: Attachment[] = Array.from(files).map((file) => {
      const type = getAttachmentType(file);
      const preview = type === 'image' ? URL.createObjectURL(file) : undefined;
      return {
        id: crypto.randomUUID(),
        file,
        preview,
        type,
      };
    });
    setAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (disabled) return;

    if (trimmed) {
      setHistory((prev) => {
        const updated = [...prev, trimmed];
        return updated.slice(-MAX_HISTORY);
      });
    }
    setHistoryIndex(-1);
    setBrowsingHistory(false);

    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setText('');
    setAttachments([]);

    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.focus();
      }
    }, 0);
  }, [text, attachments, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Send on Enter (without Shift)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }

      // History navigation
      if (e.key === 'ArrowUp' && history.length > 0) {
        const el = textareaRef.current;
        const atStart = el?.selectionStart === 0 && el?.selectionEnd === 0;
        const isEmpty = text.length === 0;

        if (isEmpty || atStart) {
          e.preventDefault();
          const newIndex =
            historyIndex === -1
              ? history.length - 1
              : Math.max(0, historyIndex - 1);
          setHistoryIndex(newIndex);
          setText(history[newIndex]);
          setBrowsingHistory(true);
        }
      }

      if (e.key === 'ArrowDown' && browsingHistory) {
        e.preventDefault();
        if (historyIndex < history.length - 1) {
          const newIndex = historyIndex + 1;
          setHistoryIndex(newIndex);
          setText(history[newIndex]);
        } else {
          setHistoryIndex(-1);
          setText('');
          setBrowsingHistory(false);
        }
      }
    },
    [handleSend, history, historyIndex, text, browsingHistory]
  );

  // Paste handler for images
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    },
    [addFiles]
  );

  // Drag and drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);

      if (e.dataTransfer.files?.length) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles]
  );

  // Voice input supported if browser has SpeechRecognition OR MediaRecorder (fallback to server STT)
  const voiceSupport = useSyncExternalStore(subscribeNoop, getVoiceSupport, getVoiceSupportServer);
  const speechSupported = voiceSupport !== 'none';
  const useServerSTT = voiceSupport === 'server';

  // Voice input via Web Speech API
  const toggleVoice = useCallback(async () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    // MediaRecorder + server-side STT (/api/voice/transcribe)
    // UX: tap mic → waveform + stop button → tap stop → transcribing → result in input
    if (useServerSTT) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        setMediaStream(stream);
        const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
          : MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg'
          : '';
        const mediaRecorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        const format = mimeType.split('/')[1] || 'wav';
        const chunks: Blob[] = [];

        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

        mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          setMediaStream(null);
          setIsListening(false);

          if (chunks.length === 0) return;

          // Phase: transcribing
          setIsTranscribing(true);
          const blob = new Blob(chunks, { type: mimeType || 'audio/wav' });
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);

          try {
            const res = await fetch('/api/voice/transcribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ audio: base64, format }),
              credentials: 'include',
            });
            const data = await res.json();
            if (data.text) {
              setText((prev: string) => prev ? prev + ' ' + data.text : data.text);
            } else if (data.error) {
              console.error('Transcription error:', data.error);
            }
          } catch (err) {
            console.error('Server STT failed:', err);
          }
          setIsTranscribing(false);
        };

        recognitionRef.current = { stop: () => { if (mediaRecorder.state === 'recording') mediaRecorder.stop(); } };
        mediaRecorder.start();
        setIsListening(true);

        // Safety limit: 2 minutes max
        setTimeout(() => { if (mediaRecorder.state === 'recording') mediaRecorder.stop(); }, 120_000);
      } catch (_err) {
        alert('Microphone access denied. Check browser permissions.');
        setIsListening(false);
        setMediaStream(null);
      }
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser. Use Chrome or Edge.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    let finalTranscript = text;

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interim += transcript;
        }
      }
      setText(finalTranscript + interim);
    };

    recognition.onerror = (event: any) => {
      setIsListening(false);
      if (event.error === 'not-allowed') {
        alert('Microphone access denied. Allow microphone permissions in your browser settings.');
      } else if (event.error === 'no-speech') {
        // Silent timeout — not an error worth showing
      } else {
        console.error('Speech recognition error:', event.error);
      }
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
    } catch (err) {
      console.error('Failed to start speech recognition:', err);
      setIsListening(false);
    }
  }, [isListening, text, useServerSTT]);

  // Cleanup speech recognition on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative rounded-xl ring-1 bg-surface-container-highest p-3 transition-colors',
        browsingHistory
          ? 'ring-primary'
          : 'ring-outline-variant/10',
        disabled && 'opacity-60 pointer-events-none'
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Voice conversation error (STT/TTS/mic) */}
      {voiceMode && voiceError && (
        <div className="mb-2 rounded-lg bg-error/10 px-3 py-1.5 text-xs text-error">{voiceError}</div>
      )}

      {/* Drop zone overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10">
          <p className="text-sm font-medium text-primary">
            Drop files here
          </p>
        </div>
      )}

      {/* Attachment bar */}
      {attachments.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {attachments.map((attachment) => {
            const Icon = getAttachmentIcon(attachment.type);
            return (
              <div
                key={attachment.id}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-surface-container-high px-2 py-1 text-xs"
              >
                {attachment.type === 'image' && attachment.preview ? (
                  <img
                    src={attachment.preview}
                    alt={attachment.file.name}
                    className="h-10 w-10 rounded object-cover"
                  />
                ) : (
                  <Icon className="h-4 w-4 text-on-surface-variant" />
                )}
                <span className="max-w-[120px] truncate text-on-surface-variant">
                  {truncateFilename(attachment.file.name)}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  className="rounded p-0.5 text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-center gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (browsingHistory) {
              setBrowsingHistory(false);
              setHistoryIndex(-1);
            }
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={1}
          className="flex-1 resize-none bg-transparent text-sm text-on-surface outline-hidden placeholder:text-on-surface-variant"
          style={{ overflowY: 'hidden' }}
          disabled={disabled}
        />

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              addFiles(e.target.files);
              e.target.value = '';
            }
          }}
        />

        {/* Paperclip button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded-lg p-2 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
          title="Attach files"
        >
          <Paperclip className="h-4 w-4" />
        </button>

        {/* Voice input — mic button / waveform+stop / transcribing */}
        {speechSupported && !isListening && !isTranscribing && (
          <button
            type="button"
            onClick={toggleVoice}
            className="rounded-lg p-2 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
            title="Voice input"
          >
            <Mic className="h-4 w-4" />
          </button>
        )}

        {/* Recording: waveform + stop button */}
        {isListening && mediaStream && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg bg-error/10 px-2 py-1">
              <span className="dot dot-err dot-live text-error" />
              <AudioWaveform stream={mediaStream} className="h-8 w-32 opacity-80" />
            </div>
            <button
              type="button"
              onClick={() => recognitionRef.current?.stop()}
              className="rounded-lg bg-error/20 p-2 text-error transition-colors hover:bg-error/30"
              title="Stop recording"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          </div>
        )}

        {/* Browser SpeechRecognition active (Chrome) — simpler indicator */}
        {isListening && !mediaStream && (
          <button
            type="button"
            onClick={toggleVoice}
            className="relative rounded-lg p-2 text-error hover:bg-error/10"
            title="Stop listening"
          >
            <Mic className="h-4 w-4" />
            <span className="absolute inset-0 animate-ping rounded-lg border border-error opacity-30" />
          </button>
        )}

        {/* Transcribing indicator */}
        {isTranscribing && (
          <div className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5">
            <span className="dot dot-live text-primary bg-primary h-1.5 w-1.5" />
            <span className="text-xs text-accent animate-pulse">transcribing<span className="term-caret" /></span>
          </div>
        )}

        {/* Live voice conversation toggle */}
        {onToggleVoiceMode && (
          <button
            type="button"
            onClick={voiceAvailable ? onToggleVoiceMode : undefined}
            disabled={!voiceAvailable}
            className={cn(
              'rounded-lg p-2 transition-colors',
              !voiceAvailable
                ? 'text-on-surface-variant/40 cursor-not-allowed'
                : voiceMode
                  ? 'bg-primary/15 text-primary hover:bg-primary/25'
                  : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
            )}
            title={
              !voiceAvailable
                ? voiceError || 'Voice unavailable — run `octi setup` to install local voice'
                : voiceMode
                  ? 'Exit voice conversation'
                  : 'Start voice conversation'
            }
          >
            <AudioLines className="h-4 w-4" />
          </button>
        )}

        {/* Voice conversation state */}
        {voiceMode && (
          <div className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5">
            <span className={cn('dot dot-live h-1.5 w-1.5', voiceState === 'error' ? 'text-error bg-error' : 'text-primary bg-primary')} />
            <span className="text-xs text-accent">{VOICE_STATE_LABEL[voiceState]}<span className="term-caret" /></span>
          </div>
        )}

        {/* Send button */}
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className={cn(
            'rounded-lg p-2 transition-colors',
            canSend
              ? 'bg-primary text-on-primary hover:bg-primary-container'
              : 'bg-surface-container-high text-on-surface-variant'
          )}
          title="Send message"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
