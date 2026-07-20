/**
 * Binary-blob stripping for non-vision models.
 *
 * A tool that returns a screenshot puts base64 into STRING content, which no
 * provider reads as an image — so a text-only model gets tens of thousands of
 * junk tokens. See the 743d4b66 post-mortem (373 KB screenshot → 9B text model).
 */
import { describe, expect, test } from 'bun:test';
import { stripBinaryBlobs } from './tool-executor';

const blob = 'A'.repeat(2000);

describe('stripBinaryBlobs', () => {
  test('replaces a base64 blob but keeps the useful JSON around it', () => {
    const out = stripBinaryBlobs(JSON.stringify({ url: 'https://example.com', size: 373_000, base64: blob }));
    expect(out).not.toContain(blob);
    expect(out).toContain('binary blob omitted');
    expect(out).toContain('2000 chars');
    // The context the model can actually use survives.
    expect(out).toContain('https://example.com');
    expect(out).toContain('373000');
  });

  test('is shape-agnostic — covers every image-returning tool shape', () => {
    // browser: {base64}, browser-ext: {image}, MCP: {content:[{data}]}
    for (const payload of [{ base64: blob }, { image: blob }, { content: [{ type: 'image', data: blob }] }]) {
      expect(stripBinaryBlobs(JSON.stringify(payload))).toContain('binary blob omitted');
    }
  });

  test('leaves ordinary output alone', () => {
    const text = 'The function returns a Promise<void> and throws on invalid input.';
    expect(stripBinaryBlobs(text)).toBe(text);
  });

  test('does not touch identifiers, hashes or short tokens', () => {
    // A sha256 is 64 chars; a UUID and a JWT-ish token are far under the 1 KB bar.
    const text = JSON.stringify({
      sha: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      id: '550e8400-e29b-41d4-a716-446655440000',
      token: 'a'.repeat(1023),
    });
    expect(stripBinaryBlobs(text)).toBe(text);
  });

  test('handles multiple blobs in one result', () => {
    const out = stripBinaryBlobs(JSON.stringify({ a: blob, b: 'B'.repeat(1500) }));
    expect(out.match(/binary blob omitted/g)).toHaveLength(2);
  });
});
