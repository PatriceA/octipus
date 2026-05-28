declare module 'mammoth' {
  interface MarkdownResult {
    value: string;
    messages: Array<{ type: 'warning' | 'error'; message: string }>;
  }
  function convertToMarkdown(input: { path: string } | { buffer: Buffer }): Promise<MarkdownResult>;
}

declare module 'word-extractor' {
  class WordExtractor {
    extract(filePath: string): Promise<WordDocument>;
  }
  interface WordDocument {
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(): string;
    getFooters(): string;
    getAnnotations(): string;
    getTextboxes(): string;
  }
  export = WordExtractor;
}
