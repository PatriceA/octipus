/**
 * The recall eval's lines (web/app/recall): `question => expected; other expected`,
 * or `question => -` for a question the knowledge base should not answer.
 * Blank lines, `#` comments and lines without `=>` are left out.
 */
export function parseEvalLines(text: string): Array<{ question: string; expect: string[] }> {
  return text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('=>')).map((line) => {
    const at = line.lastIndexOf('=>');
    const question = line.slice(0, at).trim();
    const rest = line.slice(at + 2).trim();
    return { question, expect: rest === '-' ? [] : rest.split(';').map((s) => s.trim()).filter(Boolean) };
  }).filter((c) => c.question);
}
