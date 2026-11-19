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
import { type Ref, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react';
import type { RealtimeState } from '@/hooks/useVoiceRealtime';
import { api } from '@/lib/api';
import type { TranscribeAnswer } from '@/lib/types/voice';
import { cn } from '@/lib/utils';
import { audioFormatOf, blobToBase64, microphoneError, startClipRecorder } from '@/lib/voice-audio';
import { PROTECTION_LEVELS, PROTECTION_LEVEL_LABELS, type ProtectionLevel } from '../../../src/shared/protection';
import { AudioWaveform } from './audio-waveform';

/** The browser's own speech recognition (Chrome, Edge, Safari). What it hears goes to the browser vendor. */
interface BrowserRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type BrowserRecognitionCtor = new () => BrowserRecognition;
const browserRecognition = (): BrowserRecognitionCtor | undefined => {
  const w = window as unknown as { SpeechRecognition?: BrowserRecognitionCtor; webkitSpeechRecognition?: BrowserRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

const subscribeNoop = () => () => {};
/** What this browser can do for dictation: record a clip for the server, recognise speech itself, both or neither. */
const getDictationAbilities = () => {
  const record = typeof MediaRecorder !== 'undefined';
  const recognise = !!browserRecognition();
  return record && recognise ? 'both' : record ? 'record' : recognise ? 'browser' : 'none';
};
const getDictationAbilitiesServer = () => 'none' as const;

const BROWSER_DICTATION_LABEL = "Dictate with your browser's speech recognition (audio is sent to the browser vendor)";
/** A dictated clip is cut here. */
const DICTATION_MAX_MS = 120_000;

export interface Attachment {
  id: string;
  file: File;
  preview?: string;
  type: 'image' | 'file' | 'audio';
}

/** What a page can do to the composer from outside (an interactive answer's "Edit in composer"). */
export interface PromptInputHandle {
  /** Append `text` on a new line after the draft (never replacing it) and mark it as from that interactive answer. */
  insertDraft: (text: string, source: { inlineUiId: string; title?: string }) => void;
}

interface PromptInputProps {
  onSend: (message: string, attachments?: Attachment[], options?: { inlineUiProvenance?: string; attachmentProtectionLevel?: ProtectionLevel }) => void;
  /** Files already attached from the workspace file viewer. */
  hasAttachedFiles?: boolean;
  /** The composer handle (`insertDraft`). */
  composerRef?: Ref<PromptInputHandle>;
  disabled?: boolean;
  /** The conversation dictated into: its protection level decides which engines may hear it. */
  sessionId?: string | null;
  placeholder?: string;
  /** Why the voice conversation could not start, shown under the input. */
  voiceError?: string | null;
  /**
   * Whether the server can hear (a speech-to-text engine runs): dictation is
   * transcribed there and the conversation toggle is offered. `null` = not
   * known yet, so nothing is offered that might send audio elsewhere.
   */
  voiceAvailable?: boolean | null;
  /** Hands-free voice conversation: talk, and the reply is spoken. */
  realtimeMode?: boolean;
  realtimeState?: RealtimeState;
  realtimePartial?: string;
  realtimeError?: string | null;
  /** Whether replies are spoken; false = no speech engine, replies are only shown. */
  realtimeSpeaks?: boolean | null;
  onToggleRealtimeMode?: () => void;
  /** Stop the reply being spoken. */
  onInterruptRealtime?: () => void;
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
  'image/*,audio/*,.pdf,.txt,.md,.js,.ts,.py,.json,.csv,.html,.css';

const MAX_HISTORY = 50;


const REALTIME_STATE_LABEL: Record<RealtimeState, string> = {
  idle: 'starting…',
  connecting: 'connecting…',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
};

export default function PromptInput({
  onSend,
  hasAttachedFiles = false,
  disabled = false,
  placeholder = 'Type a message...',
  realtimeMode = false,
  realtimeState = 'idle',
  realtimePartial = '',
  realtimeError = null,
  realtimeSpeaks = null,
  onToggleRealtimeMode,
  onInterruptRealtime,
  voiceError = null,
  voiceAvailable = null,
  composerRef,
  sessionId = null,
}: PromptInputProps) {
  const [text, setText] = useState('');
  // The interactive answer a suggestion in the draft came from; sent with the
  // message (its chip in the transcript). Removable before sending.
  const [inlineUiSource, setInlineUiSource] = useState<{ inlineUiId: string; title?: string } | null>(null);
  const [commands, setCommands] = useState<Array<{ name: string; description: string }>>([]);
  const [commandError, setCommandError] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const commandListId = useId();
  const showCommands = !disabled && !commandsDismissed && /^\/[^\s]*$/.test(text);
  const matchingCommands = commands.filter(command => command.name.startsWith(text.slice(1).toLowerCase()));
  const selectedCommand = matchingCommands[commandIndex] ?? matchingCommands[0];
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentProtectionLevel, setAttachmentProtectionLevel] = useState<ProtectionLevel | ''>('');
  const hasFiles = attachments.length > 0 || hasAttachedFiles;
  const [previousHasFiles, setPreviousHasFiles] = useState(hasFiles);
  // Reset before rendering when parent-owned attachments disappear, so a
  // later file requires a fresh sensitivity choice without an effect cascade.
  if (previousHasFiles !== hasFiles) {
    setPreviousHasFiles(hasFiles);
    if (!hasFiles) setAttachmentProtectionLevel('');
  }
  const sensitivityId = useId();
  const [isDragging, setIsDragging] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  /** Why dictation did not work, shown under the input until the next attempt. */
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [browsingHistory, setBrowsingHistory] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<{ stop(): void } | null>(null);
  const dragCounterRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showCommands) return;
    let cancelled = false;
    api.get<{ commands: Array<{ name: string; description: string }> }>('/chat/commands')
      .then(result => { if (!cancelled) { setCommands(result.commands); setCommandError(false); } })
      .catch(() => { if (!cancelled) setCommandError(true); });
    return () => { cancelled = true; };
  }, [showCommands]);
  const selectCommand = useCallback((name: string) => {
    setText(`/${name} `);
    setBrowsingHistory(false);
    setHistoryIndex(-1);
    textareaRef.current?.focus();
  }, []);

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
    setAttachmentProtectionLevel('');
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
    if (!trimmed && !hasFiles) return;
    if (disabled || hasFiles && attachmentProtectionLevel === '') return;

    if (trimmed) {
      setHistory((prev) => {
        const updated = [...prev, trimmed];
        return updated.slice(-MAX_HISTORY);
      });
    }
    setHistoryIndex(-1);
    setBrowsingHistory(false);

    onSend(trimmed, attachments.length > 0 ? attachments : undefined, {
      ...(inlineUiSource ? { inlineUiProvenance: inlineUiSource.inlineUiId } : {}),
      ...(hasFiles && attachmentProtectionLevel !== '' ? { attachmentProtectionLevel } : {}),
    });
    setText('');
    setAttachments([]);
    setAttachmentProtectionLevel('');
    setInlineUiSource(null);

    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.focus();
      }
    }, 0);
  }, [text, attachments, disabled, onSend, inlineUiSource, hasFiles, attachmentProtectionLevel]);

  useImperativeHandle(composerRef, () => ({
    insertDraft: (inserted, source) => {
      setText((prev) => (prev.trim() ? `${prev}\n${inserted}` : inserted));
      setInlineUiSource(source);
      // The user clicked "Edit in composer": moving focus here is theirs.
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
  }), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;
      if (showCommands) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setCommandsDismissed(true);
          return;
        }
        if (matchingCommands.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          const index = matchingCommands.indexOf(selectedCommand);
          setCommandIndex((index + (e.key === 'ArrowDown' ? 1 : -1) + matchingCommands.length) % matchingCommands.length);
          return;
        }
        if (selectedCommand && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && text !== `/${selectedCommand.name}`))) {
          e.preventDefault();
          selectCommand(selectedCommand.name);
          return;
        }
      }
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
    [handleSend, history, historyIndex, text, browsingHistory, showCommands, matchingCommands, selectedCommand, selectCommand]
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

  // Dictation. When the server can hear, the clip is recorded here and
  // transcribed there, by the engine the install chose (which may be a
  // private one). The browser's own recognition sends the audio to the
  // browser vendor, so it is used only when the server has no engine at all,
  // and the button says so.
  const dictationAbilities = useSyncExternalStore(subscribeNoop, getDictationAbilities, getDictationAbilitiesServer);
  const canRecord = dictationAbilities === 'both' || dictationAbilities === 'record';
  const canRecognise = dictationAbilities === 'both' || dictationAbilities === 'browser';
  const dictation: 'server' | 'browser' | 'none' =
    voiceAvailable === true ? (canRecord ? 'server' : 'none')
      : voiceAvailable === false && canRecognise ? 'browser'
        : 'none';

  const dictateWithServer = useCallback(async () => {
    let recorder: Awaited<ReturnType<typeof startClipRecorder>>;
    try {
      recorder = await startClipRecorder(DICTATION_MAX_MS);
    } catch (err) {
      setDictationError(microphoneError(err));
      return;
    }
    setMediaStream(recorder.stream);
    setIsListening(true);
    recognitionRef.current = recorder;
    try {
      const clip = await recorder.done;
      setMediaStream(null);
      setIsListening(false);
      if (clip.size === 0) {
        setDictationError('Nothing was recorded.');
        return;
      }
      setIsTranscribing(true);
      const answer = await api.post<TranscribeAnswer>('/voice/transcribe', {
        audio: await blobToBase64(clip),
        format: audioFormatOf(clip.type),
        ...(sessionId ? { sessionId } : {}),
      });
      // A transcription that failed answers 200 with `error`.
      if (answer.error) setDictationError(`Dictation failed: ${answer.error}`);
      else if (answer.text) setText((prev) => (prev ? `${prev} ${answer.text}` : answer.text ?? ''));
      else setDictationError('No speech was heard in the recording.');
    } catch (err) {
      setDictationError(`Dictation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setMediaStream(null);
      setIsListening(false);
      setIsTranscribing(false);
    }
  }, [sessionId]);

  const dictateWithBrowser = useCallback(() => {
    const Recognition = browserRecognition();
    if (!Recognition) {
      setDictationError('This browser has no speech recognition.');
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    let finalTranscript = text;
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalTranscript += transcript;
        else interim += transcript;
      }
      setText(finalTranscript + interim);
    };
    recognition.onerror = (event) => {
      setIsListening(false);
      // 'no-speech' is the recogniser's own timeout after silence, and 'aborted' is the stop button.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      setDictationError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'The microphone is blocked. Allow it for this site in the browser, then try again.'
        : `The browser's speech recognition failed: ${event.error}`);
    };
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
    } catch (err) {
      setIsListening(false);
      setDictationError(`The browser's speech recognition could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [text]);

  const toggleVoice = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }
    setDictationError(null);
    if (dictation === 'server') void dictateWithServer();
    else if (dictation === 'browser') dictateWithBrowser();
  }, [isListening, dictation, dictateWithServer, dictateWithBrowser]);

  // Cleanup speech recognition on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  const canSend = (text.trim().length > 0 || hasFiles) && !disabled && (!hasFiles || attachmentProtectionLevel !== '');

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
      {showCommands && (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-2 rounded-xl bg-surface-container-highest p-2 shadow-lg ring-1 ring-outline-variant/30">
          <div className="px-2 py-1 text-xs text-on-surface-variant">Commands · ↑↓ choose · Tab complete · Esc close</div>
          <div id={commandListId} role="listbox" aria-label="Chat commands" className="max-h-64 overflow-y-auto">
            {matchingCommands.map(command => (
              <button key={command.name} id={`${commandListId}-${command.name}`} type="button" role="option"
                aria-selected={command === selectedCommand} tabIndex={-1}
                ref={element => { if (command === selectedCommand) element?.scrollIntoView({ block: 'nearest' }); }}
                onMouseDown={event => event.preventDefault()}
                onClick={() => selectCommand(command.name)}
                className={cn('flex w-full flex-col rounded-lg px-3 py-2 text-left text-sm', command === selectedCommand && 'bg-primary/10')}
              >
                <span className="font-medium text-on-surface">/{command.name}</span>
                <span className="text-xs text-on-surface-variant">{command.description}</span>
              </button>
            ))}
          </div>
          {(commandError || !matchingCommands.length) && <p role="status" className="px-3 py-2 text-sm text-on-surface-variant">
            {commandError ? 'Could not load commands. Type /help or reopen this menu to retry.' : commands.length ? 'No matching commands.' : 'Loading commands…'}
          </p>}
        </div>
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
      {inlineUiSource && (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-on-surface-variant" data-testid="composer-inline-ui-source">
          <span className="rounded-full bg-surface-container-high px-2 py-0.5">
            from interactive answer{inlineUiSource.title ? ` “${inlineUiSource.title}”` : ''}
          </span>
          <button type="button" onClick={() => setInlineUiSource(null)} className="underline" aria-label="Remove the interactive-answer source">remove</button>
        </div>
      )}
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

      {hasFiles && (
        <div className="mb-3 space-y-1 text-xs">
          <label htmlFor={sensitivityId} className="block font-medium text-on-surface">Attachment sensitivity</label>
          <select id={sensitivityId} value={attachmentProtectionLevel}
            onChange={event => setAttachmentProtectionLevel(event.target.value ? Number(event.target.value) as ProtectionLevel : '')}
            disabled={disabled} className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-high px-3 py-2 text-on-surface">
            <option value="">Choose sensitivity before sending</option>
            {PROTECTION_LEVELS.map(level => <option key={level} value={level}>{PROTECTION_LEVEL_LABELS[level]}</option>)}
          </select>
          <p className="text-on-surface-variant">Applies to all attached files. Choose the most sensitive content: Public, Internal, Confidential (personal data), or Strictly confidential (health, HR, legal, bank data). Strictly confidential files require a local model. Earlier protected content in this conversation still applies.</p>
        </div>
      )}

      {/* Input row */}
      <div className="flex items-center gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          aria-controls={showCommands ? commandListId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showCommands && selectedCommand ? `${commandListId}-${selectedCommand.name}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setCommandIndex(0);
            setCommandsDismissed(false);
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

        {/* Dictation — mic button / waveform+stop / transcribing */}
        {dictation !== 'none' && !isListening && !isTranscribing && (
          <button
            type="button"
            onClick={toggleVoice}
            className="rounded-lg p-2 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
            title={dictation === 'browser' ? BROWSER_DICTATION_LABEL : 'Dictate'}
            aria-label={dictation === 'browser' ? BROWSER_DICTATION_LABEL : 'Dictate'}
            data-testid="dictate-button"
            data-dictation={dictation}
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

        {/* The browser's own recognition is listening — simpler indicator */}
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

        {/* Voice conversation toggle (hands-free) — offered when the server can hear */}
        {onToggleRealtimeMode && (voiceAvailable === true || realtimeMode) && (
          <button
            type="button"
            onClick={onToggleRealtimeMode}
            className={cn(
              'rounded-lg p-2 transition-colors',
              realtimeMode
                ? 'bg-primary/15 text-primary hover:bg-primary/25'
                : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
            )}
            title={realtimeMode ? 'Exit voice conversation' : 'Start voice conversation'}
            aria-label={realtimeMode ? 'Exit voice conversation' : 'Start voice conversation'}
            aria-pressed={realtimeMode}
          >
            <AudioLines className="h-4 w-4" />
          </button>
        )}

        {/* Voice conversation: its state and what is being said, or what went wrong */}
        {realtimeMode && (
          <div
            role="status"
            data-testid="voice-conversation-status"
            data-state={realtimeState}
            className={cn('flex items-start gap-1.5 rounded-lg px-3 py-2 max-w-[32rem]', realtimeError ? 'bg-error/10' : 'bg-primary/10')}
          >
            <span className={cn('dot dot-live h-1.5 w-1.5 mt-1.5 shrink-0', realtimeError ? 'text-error bg-error' : 'text-primary bg-primary')} />
            <span className={cn('text-sm leading-snug line-clamp-4 break-words', realtimeError ? 'text-error' : 'text-accent')}>
              {realtimeError
                || realtimePartial
                || (realtimeState === 'listening' && realtimeSpeaks === false ? 'Listening only — no speech engine' : REALTIME_STATE_LABEL[realtimeState])}
              {!realtimeError && <span className="term-caret" />}
            </span>
            {realtimeState === 'speaking' && onInterruptRealtime && (
              <button
                type="button"
                onClick={onInterruptRealtime}
                className="shrink-0 rounded p-1 text-primary hover:bg-primary/15"
                title="Stop speaking"
                aria-label="Stop speaking"
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            )}
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
              ? 'bg-primary text-on-primary hover:bg-primary-dim'
              : 'bg-surface-container-high text-on-surface-variant'
          )}
          title="Send message"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>

      {(dictationError || voiceError) && (
        <p role="alert" data-testid="composer-voice-error" className="mt-2 flex items-start gap-2 text-xs text-error">
          <span className="min-w-0 break-words">{dictationError || voiceError}</span>
          {dictationError && (
            <button type="button" onClick={() => setDictationError(null)} className="shrink-0 underline" aria-label="Dismiss the dictation error">dismiss</button>
          )}
        </p>
      )}
    </div>
  );
}
