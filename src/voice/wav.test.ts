import { describe, expect, test } from 'vitest';
import { parseWav, pcmToWav } from './wav';

const samples = (values: number[]) => new Uint8Array(new Int16Array(values).buffer);
const read = (pcm: Buffer) => [...new Int16Array(new Uint8Array(pcm).buffer)];

describe('WAV in and out', () => {
  test('PCM wrapped in a WAV reads back as the same samples at the same rate', () => {
    const { pcm, sampleRate } = parseWav(pcmToWav(samples([0, 100, -100, 32767, -32768]), 48000));
    expect(sampleRate).toBe(48000);
    expect(read(pcm)).toEqual([0, 100, -100, 32767, -32768]);
  });

  test('stereo is downmixed; 32-bit float is converted; a streamed file with no data size is read to its end', () => {
    const stereo = Buffer.from(pcmToWav(samples([100, 300, -200, -400]), 24000));
    stereo.writeUInt16LE(2, 22); // two channels
    stereo.writeUInt16LE(4, 32);
    expect(read(parseWav(stereo).pcm)).toEqual([200, -300]);

    const float = Buffer.alloc(44 + 8);
    pcmToWav(new Uint8Array(0), 16000).copy(float, 0, 0, 44);
    float.writeUInt16LE(3, 20); // IEEE float
    float.writeUInt16LE(32, 34);
    float.writeUInt32LE(0xffffffff, 40); // streamed: size never filled in
    float.writeFloatLE(0.5, 44);
    float.writeFloatLE(-1, 48);
    expect(read(parseWav(float).pcm)).toEqual([16384, -32767]);
  });

  test('a file that is not a WAV, or an encoding nobody plays, fails with what it found', () => {
    expect(() => parseWav(Buffer.from('ID3 not a wav at all'))).toThrow(/Not a WAV file/);
    const alaw = Buffer.from(pcmToWav(samples([1, 2]), 8000));
    alaw.writeUInt16LE(6, 20);
    expect(() => parseWav(alaw)).toThrow(/Unsupported WAV encoding \(format 6/);
  });
});
