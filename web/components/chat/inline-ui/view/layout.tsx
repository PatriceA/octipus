'use client';

/** Layout components of a view: Column, Row, Card, Tabs, Steps, Divider (spec §2.6). */
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  type ChildList,
  type Dynamic,
  type ExprScope,
  expandTemplateChildren,
  type InlineUiComponentName,
  isTruthy,
  resolveDynamic,
  type TitledChild,
  valueToText,
} from '../../../../../src/shared/inline-ui/view';
import { cn } from '@/lib/utils';
import { type NodeProps, useViewRuntime } from './runtime';
import { ComponentError, ViewNode } from './view';

const GAP = { sm: 'gap-1.5', md: 'gap-3', lg: 'gap-5' } as const;
const ITEMS = { start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch' } as const;
const JUSTIFY = { start: 'justify-start', center: 'justify-center', end: 'justify-end', between: 'justify-between' } as const;

/** In a row, controls and short labels keep their own width; everything else shares the line and wraps. */
const NATURAL_WIDTH: ReadonlySet<InlineUiComponentName> = new Set(['Button', 'Badge', 'Link', 'CheckBox', 'Divider']);

function visibleIn(visible: Dynamic<boolean>, scope: ExprScope): boolean | null {
  try {
    return isTruthy(resolveDynamic(visible, scope));
  } catch (err) {
    console.warn('[inline-ui] a row child\'s visible could not be resolved', err);
    return null;
  }
}

function Children({ list, scope, inRow }: { list: ChildList<string>; scope: ExprScope; inRow?: boolean }) {
  const rt = useViewRuntime();
  let expanded: ReturnType<typeof expandTemplateChildren>;
  try {
    expanded = expandTemplateChildren(rt.view, list, scope);
  } catch (err) {
    const id = Array.isArray(list) ? 'children' : list.template;
    return <ComponentError id={id} message={err instanceof Error ? err.message : String(err)} />;
  }
  return (
    <>
      {expanded.children.map((copy) => {
        const node = <ViewNode key={copy.key} id={copy.id} scope={copy.scope} />;
        if (!inRow) return node;
        const component = rt.components.get(copy.id);
        // A hidden child takes no slot (and no gap) in the row. A `visible` that
        // fails to resolve keeps its slot: ViewNode shows the error there.
        if (component?.visible !== undefined && visibleIn(component.visible, copy.scope) === false) return null;
        const kind = component?.component;
        return <div key={copy.key} className={kind && NATURAL_WIDTH.has(kind) ? 'shrink-0 min-w-0' : 'flex-[1_1_10rem] min-w-0'}>{node}</div>;
      })}
      {expanded.hidden > 0 && <p className="text-xs text-on-surface-variant">…and {expanded.hidden} more not shown.</p>}
    </>
  );
}

export function Column({ c, scope }: NodeProps<'Column'>) {
  return (
    <div className={cn('flex flex-col min-w-0', GAP[c.gap ?? 'md'], ITEMS[c.align ?? 'stretch'])}>
      <Children list={c.children} scope={scope} />
    </div>
  );
}

export function Row({ c, scope }: NodeProps<'Row'>) {
  return (
    <div className={cn('flex min-w-0', c.wrap === false ? 'flex-nowrap overflow-x-auto' : 'flex-wrap', GAP[c.gap ?? 'md'], ITEMS[c.align ?? 'stretch'], JUSTIFY[c.justify ?? 'start'])}>
      <Children list={c.children} scope={scope} inRow />
    </div>
  );
}

export function Card({ c, r, scope }: NodeProps<'Card'>) {
  const rt = useViewRuntime();
  const title = r.title === undefined ? '' : valueToText(r.title, rt.format);
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-outline-variant/50 bg-surface-container p-3 min-w-0 h-full">
      {title && <h4 className="text-sm font-semibold text-on-surface break-words">{title}</h4>}
      <Children list={c.children} scope={scope} />
    </section>
  );
}

export function Divider() {
  return <hr className="border-0 border-t border-outline-variant/50 my-1" />;
}

/** Tabs: the ARIA tabs pattern, arrow keys move between tabs (selection follows focus). */
export function Tabs({ c, scope }: NodeProps<'Tabs'>) {
  const base = useId();
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabs: TitledChild<string>[] = c.tabs;
  const current = Math.min(active, Math.max(0, tabs.length - 1));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = tabs.length - 1;
    const next = e.key === 'ArrowRight' ? (current === last ? 0 : current + 1)
      : e.key === 'ArrowLeft' ? (current === 0 ? last : current - 1)
      : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div role="tablist" aria-orientation="horizontal" onKeyDown={onKeyDown} className="flex gap-1 overflow-x-auto border-b border-outline-variant/50">
        {tabs.map((tab, i) => (
          <button
            key={tab.child}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            id={`${base}-tab-${i}`}
            aria-selected={i === current}
            aria-controls={i === current ? `${base}-panel` : undefined}
            tabIndex={i === current ? 0 : -1}
            onClick={() => setActive(i)}
            className={cn('shrink-0 -mb-px border-b-2 px-3 py-1.5 text-sm', i === current ? 'border-primary text-primary font-medium' : 'border-transparent text-on-surface-variant hover:text-on-surface')}
          >{tab.title}</button>
        ))}
      </div>
      {tabs[current] && (
        <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${current}`} tabIndex={0} className="min-w-0 focus-visible:outline-none">
          <ViewNode id={tabs[current].child} scope={scope} />
        </div>
      )}
    </div>
  );
}

/** Steps: one at a time, Back / Next, the position announced as it changes. */
export function Steps({ c, scope }: NodeProps<'Steps'>) {
  const [active, setActive] = useState(0);
  const steps: TitledChild<string>[] = c.steps;
  const n = steps.length;
  const current = Math.min(active, Math.max(0, n - 1));
  if (n === 0) return null;
  return (
    <div className="flex flex-col gap-3 min-w-0" role="group" aria-roledescription="steps">
      <ol className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Steps">
        {steps.map((step, i) => (
          <li key={step.child} aria-current={i === current ? 'step' : undefined} className={cn('flex items-center gap-1.5', i === current ? 'text-on-surface font-medium' : 'text-on-surface-variant')}>
            <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] tabular-nums', i === current ? 'bg-primary text-on-primary' : i < current ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-highest')} aria-hidden>{i + 1}</span>
            {step.title}
          </li>
        ))}
      </ol>
      <div className="min-w-0">
        <ViewNode id={steps[current].child} scope={scope} />
      </div>
      <div className="flex items-center gap-2">
        <button type="button" disabled={current === 0} onClick={() => setActive(current - 1)} className="inline-flex items-center gap-1 rounded-md border border-outline-variant px-2.5 py-1 text-sm text-on-surface hover:bg-surface-container-high disabled:opacity-40 disabled:hover:bg-transparent">
          <ChevronLeft className="h-4 w-4" aria-hidden /> Back
        </button>
        <p aria-live="polite" className="text-xs text-on-surface-variant tabular-nums" data-testid="inline-ui-steps-position">Step {current + 1} of {n}</p>
        <button type="button" disabled={current === n - 1} onClick={() => setActive(current + 1)} className="ml-auto inline-flex items-center gap-1 rounded-md border border-outline-variant px-2.5 py-1 text-sm text-on-surface hover:bg-surface-container-high disabled:opacity-40 disabled:hover:bg-transparent">
          Next <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
