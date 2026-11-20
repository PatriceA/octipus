/**
 * A carrier's media-stream wire format — the only part of a streamed call
 * that differs between carriers. Each speaks JSON text frames over the
 * WebSocket: the call's audio comes in as base64 8 kHz μ-law in `media`
 * frames between a `start` and a `stop`, and audio goes back the same way,
 * with a frame that drops what the carrier still holds (barge-in) and one
 * that asks to be told when playback reaches it.
 *
 * Everything else — the token check, hearing, replying, speaking — is the
 * same for all of them (src/api/voice-media-ws.ts, media-call.ts).
 */

/** What a carrier's frame says, in one shape for all carriers. */
export type MediaStreamEvent =
  /** The stream is up: the carrier's id for the call (as its REST API and webhooks name it) and for the stream. */
  | { type: 'start'; callId: string; streamId: string }
  /** 20 ms of the caller, base64 μ-law. */
  | { type: 'media'; payload: string }
  /** Playback has reached the mark `name`. */
  | { type: 'mark'; name: string }
  /** The stream is over (the call hung up, or the stream was stopped). */
  | { type: 'stop' }
  /** The carrier reports a problem with what it was sent. */
  | { type: 'error'; detail: string }
  | { type: 'other' };

export interface MediaWire {
  read(frame: unknown): MediaStreamEvent;
  /** One frame of audio for the caller (base64 μ-law, 8 kHz). */
  audio(streamId: string, payload: string): Record<string, unknown>;
  /** Drop what the carrier holds but has not played yet. */
  clear(streamId: string): Record<string, unknown>;
  /** Ask to be told (a `mark` event) when playback reaches this point. */
  mark(streamId: string, name: string): Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const part = (frame: Record<string, unknown>, key: string): Record<string, unknown> => (isRecord(frame[key]) ? frame[key] : {});

/** Caller audio only: a stream of both tracks also carries what the caller is being played. */
function callerMedia(frame: Record<string, unknown>): MediaStreamEvent {
  const media = part(frame, 'media');
  const track = text(media.track);
  const payload = text(media.payload);
  if (!payload || (track && track !== 'inbound')) return { type: 'other' };
  return { type: 'media', payload };
}

/**
 * Twilio Media Streams (`<Connect><Stream>`): in `connected`, `start`
 * (`start.callSid`, `start.streamSid`), `media`, `mark`, `stop`; out `media`,
 * `clear`, `mark`, each naming the `streamSid`.
 * https://www.twilio.com/docs/voice/media-streams/websocket-messages
 */
const twilio: MediaWire = {
  read(frame) {
    if (!isRecord(frame)) return { type: 'other' };
    switch (frame.event) {
      case 'start': {
        const start = part(frame, 'start');
        return { type: 'start', callId: text(start.callSid), streamId: text(start.streamSid) || text(frame.streamSid) };
      }
      case 'media': return callerMedia(frame);
      case 'mark': return { type: 'mark', name: text(part(frame, 'mark').name) };
      case 'stop': return { type: 'stop' };
      default: return { type: 'other' };
    }
  },
  audio: (streamSid, payload) => ({ event: 'media', streamSid, media: { payload } }),
  clear: (streamSid) => ({ event: 'clear', streamSid }),
  mark: (streamSid, name) => ({ event: 'mark', streamSid, mark: { name } }),
};

/**
 * Telnyx media streaming, bidirectional RTP (`streaming_start` with
 * `stream_bidirectional_mode: 'rtp'`, codec PCMU): in `connected`, `start`
 * (`start.call_control_id`, top-level `stream_id`), `media`, `mark`, `dtmf`,
 * `error`, `stop`; out `media` (the RTP payload, base64, 20 ms to 30 s),
 * `clear` and `mark`.
 * https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
 */
const telnyx: MediaWire = {
  read(frame) {
    if (!isRecord(frame)) return { type: 'other' };
    switch (frame.event) {
      case 'start': return { type: 'start', callId: text(part(frame, 'start').call_control_id), streamId: text(frame.stream_id) };
      case 'media': return callerMedia(frame);
      case 'mark': return { type: 'mark', name: text(part(frame, 'mark').name) };
      case 'stop': return { type: 'stop' };
      case 'error': {
        const payload = part(frame, 'payload');
        return { type: 'error', detail: `${text(payload.title) || 'error'} ${text(payload.detail)}`.trim() };
      }
      default: return { type: 'other' };
    }
  },
  audio: (_streamId, payload) => ({ event: 'media', media: { payload } }),
  clear: () => ({ event: 'clear' }),
  mark: (_streamId, name) => ({ event: 'mark', mark: { name } }),
};

/**
 * Plivo audio streaming (`<Stream bidirectional="true"
 * contentType="audio/x-mulaw;rate=8000">`): in `start` (`start.callId` — the
 * CallUUID —, `start.streamId`), `media`, `playedStream` (a checkpoint was
 * played), `clearedAudio`, `stop`; out `playAudio` (content type and rate as
 * the Stream asked for), `clearAudio` and `checkpoint`.
 * https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-reference
 */
const plivo: MediaWire = {
  read(frame) {
    if (!isRecord(frame)) return { type: 'other' };
    switch (frame.event) {
      case 'start': {
        const start = part(frame, 'start');
        return { type: 'start', callId: text(start.callId), streamId: text(start.streamId) || text(frame.streamId) };
      }
      case 'media': return callerMedia(frame);
      case 'playedStream': return { type: 'mark', name: text(frame.name) };
      case 'stop': return { type: 'stop' };
      default: return { type: 'other' };
    }
  },
  audio: (_streamId, payload) => ({ event: 'playAudio', media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload } }),
  clear: (streamId) => ({ event: 'clearAudio', streamId }),
  mark: (streamId, name) => ({ event: 'checkpoint', streamId, name }),
};

const WIRES: Record<string, MediaWire> = { twilio, telnyx, plivo };

/** The wire format of a carrier's media stream; null for a carrier without one. */
export function mediaWireFor(provider: string): MediaWire | null {
  return WIRES[provider] ?? null;
}
