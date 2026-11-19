/**
 * WAV in and out, for the speech pipeline: every engine can write WAV, and
 * every listener (the browser, a phone line, the mobile app) can play mono
 * 16-bit PCM — so PCM is what speech travels as, and this is the one place
 * that reads it out of a WAV and wraps it back into one.
 */

export interface PcmAudio {
  /** Mono signed 16-bit little-endian samples. */
  pcm: Buffer;
  sampleRate: number;
}

/** Wrap mono s16le PCM in a 44-byte WAV header. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

/**
 * Read a WAV into mono s16le PCM. Takes what speech engines write: 16-bit
 * PCM or 32-bit float, any channel count (downmixed), chunks in any order,
 * and a streamed file whose `data` size was never filled in. Anything else
 * fails loud with what it found.
 */
export function parseWav(wav: Uint8Array): PcmAudio {
  const buf = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file (no RIFF/WAVE header).');
  }
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('latin1', offset, offset + 4);
    const declared = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    // A streamed WAV leaves the size at 0 or 0xFFFFFFFF: the data runs to the end.
    const size = id === 'data' && (declared === 0 || start + declared > buf.length) ? buf.length - start : declared;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(start);
      channels = buf.readUInt16LE(start + 2);
      sampleRate = buf.readUInt32LE(start + 4);
      bits = buf.readUInt16LE(start + 14);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(start + 24);
    } else if (id === 'data') {
      data = buf.subarray(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!data || !channels || !sampleRate) throw new Error('WAV file has no audio data.');
  const frame = (bits / 8) * channels;
  const frames = Math.floor(data.length / frame);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = i * frame + c * (bits / 8);
      if (format === 1 && bits === 16) sum += data.readInt16LE(at);
      else if (format === 3 && bits === 32) sum += Math.max(-1, Math.min(1, data.readFloatLE(at))) * 32767;
      else throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit); expected 16-bit PCM or 32-bit float.`);
    }
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return { pcm: out, sampleRate };
}
