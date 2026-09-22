/** Remove citation/provenance sections from voice transport, not saved history. */
export function stripSpeechSources(text: string): string {
  return text
    // Standalone footer or heading, with plain, italic, bold or heading markup.
    .replace(/(?:^|\n)[ \t]*[#>*_\-]*[ \t]*(?:sources?|quellen?)(?:[ \t]*[*_]*[ \t]*:[\s\S]*|[ \t]*[*_]*[ \t]*\r?\n[\s\S]*)$/i, '')
    // Model-written citations can follow the answer in the same paragraph.
    .replace(/([.!?])[ \t]+[*_]*(?:sources?|quellen?)[*_]*[ \t]*:[^\r\n]*/gi, '$1')
    .trim();
}
