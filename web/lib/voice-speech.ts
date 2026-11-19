/**
 * Text on its way to being spoken. The shaper is shared with the server
 * (src/shared/speech-text.ts), so a reply sounds the same on every surface.
 */
export { forSpeech as stripForSpeech, SentenceChunker } from '../../src/shared/speech-text';
