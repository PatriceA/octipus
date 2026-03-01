import type { PIIFilterResult, PIIRedaction } from './types';

interface PIIPattern {
  type: PIIRedaction['type'];
  pattern: RegExp;
  replacement: string;
}

const PII_PATTERNS: PIIPattern[] = [
  // Email addresses
  {
    type: 'email',
    pattern: /[\w.+-]+@[\w.-]+\.\w{2,}/g,
    replacement: '[EMAIL]',
  },
  // Phone numbers (international and US formats)
  {
    type: 'phone',
    pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    replacement: '[PHONE]',
  },
  // SSN (US)
  {
    type: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[SSN]',
  },
  // Credit card numbers
  {
    type: 'credit_card',
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    replacement: '[CREDIT_CARD]',
  },
  // API keys and tokens (sk-, pk-, bearer tokens, long hex/base64 strings)
  {
    type: 'api_key',
    pattern: /(?:sk|pk|api[_-]?key|token|secret|password|bearer)[-=:\s]+[a-zA-Z0-9_/+.-]{20,}/gi,
    replacement: '[API_KEY]',
  },
  // Standalone long secret-like strings (hex or base64, 32+ chars)
  {
    type: 'api_key',
    pattern: /\b[a-f0-9]{32,}\b/gi,
    replacement: '[SECRET]',
  },
  // IP addresses (IPv4)
  {
    type: 'ip_address',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    replacement: '[IP_ADDRESS]',
  },
];

/**
 * Filter personally identifiable information from text.
 * Returns the filtered text and a log of redactions made.
 */
export function filterPII(text: string): PIIFilterResult {
  const redactions: PIIRedaction[] = [];
  let filtered = text;

  for (const { type, pattern, replacement } of PII_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;

    filtered = filtered.replace(pattern, (match, ...args) => {
      // The offset is the second-to-last argument for replace callbacks
      const offset = typeof args[args.length - 2] === 'number' ? args[args.length - 2] : 0;
      redactions.push({
        type,
        original: match,
        replacement,
        position: [offset, offset + match.length],
      });
      return replacement;
    });
  }

  return {
    filtered,
    redactions,
    hasRedactions: redactions.length > 0,
  };
}
