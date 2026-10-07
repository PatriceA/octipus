import { useState } from 'react';
import { cliQuestionsSchema } from '../../src/shared/cli-questions';

/** Render the whole CLI questionnaire; a permission click cannot supply answers. */
export function CliQuestionForm({ args, onSubmit, onCancel }: {
  args?: Record<string, unknown>;
  onSubmit: (resolution: string) => void;
  onCancel: () => void;
}) {
  const parsed = cliQuestionsSchema.safeParse(args);
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  if (!parsed.success) return <div role="alert" className="p-4">
    This question request is malformed and cannot be answered.
    <button onClick={onCancel} className="ml-3 underline">Cancel questions</button>
  </div>;
  const { questions } = parsed.data;
  const answer = (index: number) => [...(selected[index] ?? []), ...(custom[index]?.trim() ? [custom[index].trim()] : [])].join(', ');
  return <form className="p-4 space-y-4" onSubmit={event => {
    event.preventDefault();
    if (questions.every((_, index) => answer(index))) {
      onSubmit(JSON.stringify(Object.fromEntries(questions.map((q, index) => [q.question, answer(index)]))));
    }
  }}>
    <h2 className="font-semibold text-warning">Agent needs your answers</h2>
    <div className="max-h-[60vh] overflow-y-auto space-y-5">
      {questions.map((q, index) => <fieldset key={index} className="space-y-2 min-w-0">
        <legend className="whitespace-pre-wrap break-words text-sm font-medium">{q.header && <span className="block text-warning mb-1">{q.header}</span>}{q.question}</legend>
        {q.multiSelect && <p className="text-xs text-on-surface-variant">Choose one or more options.</p>}
        {q.options.map(option => <label key={option.label} className="flex gap-3 rounded-xs border border-outline-variant p-3 cursor-pointer">
          <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`question-${index}`} checked={(selected[index] ?? []).includes(option.label)}
            onChange={event => {
              setSelected(previous => ({ ...previous, [index]: q.multiSelect
                ? event.target.checked ? [...(previous[index] ?? []), option.label] : (previous[index] ?? []).filter(label => label !== option.label)
                : [option.label] }));
              if (!q.multiSelect) setCustom(previous => ({ ...previous, [index]: '' }));
            }} />
          <span className="min-w-0 text-sm break-words"><span className="block font-medium">{option.label}</span>
            {option.description && <span className="block whitespace-pre-wrap text-on-surface-variant mt-1">{option.description}</span>}
          </span>
        </label>)}
        <label className="block text-sm">Your own answer
          <textarea value={custom[index] ?? ''} rows={2} className="block w-full mt-1 p-2 border border-outline-variant rounded-xs bg-surface-container-low"
            onChange={event => {
              setCustom(previous => ({ ...previous, [index]: event.target.value }));
              if (!q.multiSelect) setSelected(previous => ({ ...previous, [index]: [] }));
            }} />
        </label>
      </fieldset>)}
    </div>
    <div className="flex gap-3">
      <button type="submit" disabled={!questions.every((_, index) => answer(index))} className="px-3 py-2 rounded-xs bg-primary text-on-primary disabled:opacity-50">Submit answers</button>
      <button type="button" onClick={onCancel} className="px-3 py-2 rounded-xs border border-error text-error">Cancel questions</button>
    </div>
  </form>;
}
