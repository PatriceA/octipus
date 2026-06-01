'use client';

/**
 * Renders a unified-style patch (each line prefixed with `+`, `-`, or a space)
 * with colored add/remove lines. Shared by the work-stream diff preview in the
 * message timeline (Thread 1) and the in-chat file view's diff mode (Thread 2).
 */
export default function DiffView({ patch, className }: { patch: string; className?: string }) {
  const lines = patch.length ? patch.split('\n') : [];
  return (
    <pre
      className={`overflow-auto rounded border border-white/10 bg-[#0d1117] font-mono text-[11px] leading-relaxed ${className ?? ''}`}
    >
      {lines.map((line, i) => {
        const sign = line.charAt(0);
        const cls =
          sign === '+'
            ? 'bg-green-500/15 text-green-300'
            : sign === '-'
              ? 'bg-red-500/15 text-red-300'
              : 'text-on-surface-variant';
        return (
          <div key={`${i}:${line}`} className={`whitespace-pre px-2 ${cls}`}>
            {line === '' ? ' ' : line}
          </div>
        );
      })}
    </pre>
  );
}
