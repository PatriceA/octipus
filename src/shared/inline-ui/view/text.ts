/**
 * A view as plain markdown, for surfaces that cannot render it
 * (docs/plans/inline-ui-views-spec.md §5 "Other surfaces"): headings and
 * text, `label: value` lines, tables of at most 20 rows, a chart as its
 * table, inputs with their current value, buttons as a list of choices.
 * Deterministic: locale and time zone default to `en-US` and `UTC`.
 */
import { isSafeInlineUiLink } from '../bridge';
import { INLINE_UI_VIEW_LIMITS } from '../limits';
import { expandTemplateChildren, getViewComponent, viewScope } from './actions';
import { getPointer, resolveDynamic, resolvePath } from './data';
import { type ExprScope, InlineUiExprError } from './expr';
import { type FormatOptions, INLINE_UI_NO_VALUE, formatValue, isTruthy, valueToText } from './format';
import { isJsonObject, jsonEqual, readProperty } from './json';
import type { ChildList, Dynamic, InlineUiView, InlineUiViewComponent, JsonObject, JsonValue, PathRef, TableColumn } from './types';

export interface InlineUiViewTextOptions extends FormatOptions {
  /** The data model to show instead of the view's own (e.g. a stored answer's). */
  data?: JsonObject;
}

/** A rendered piece; adjacent list pieces join with one newline, everything else with a blank line. */
interface Chunk { text: string; list?: boolean }

function join(chunks: Chunk[]): string {
  let out = '';
  chunks.forEach((c, i) => {
    if (i > 0) out += c.list && chunks[i - 1].list ? '\n' : '\n\n';
    out += c.text;
  });
  return out;
}

/** A dynamic value, or a visible warning when its expression fails (the reader sees it, as in the web). */
function value(dyn: Dynamic | undefined, scope: ExprScope): JsonValue {
  try {
    return resolveDynamic(dyn, scope);
  } catch (err) {
    if (err instanceof InlineUiExprError) return `⚠ ${err.message}`;
    throw err;
  }
}

const text = (dyn: Dynamic | undefined, scope: ExprScope): string => valueToText(value(dyn, scope), scope);
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();
const cell = (s: string): string => oneLine(s).replace(/\|/g, '\\|');
const bound = (ref: PathRef, scope: ExprScope): JsonValue => getPointer(scope.data, resolvePath(ref['@path'], scope)) ?? null;
const orNone = (s: string): string => s || INLINE_UI_NO_VALUE;

function table(columns: Array<Pick<TableColumn, 'label' | 'align' | 'format'> & { key: string }>, rows: JsonValue, scope: ExprScope): Chunk[] {
  const list = Array.isArray(rows) ? rows : [];
  const max = INLINE_UI_VIEW_LIMITS.textTableRows;
  const head = `| ${columns.map((c) => cell(c.label)).join(' | ')} |`;
  const rule = `| ${columns.map((c) => (c.align === 'end' ? '--:' : c.align === 'center' ? ':-:' : '---')).join(' | ')} |`;
  const body = list.slice(0, max).map((row) => `| ${columns.map((c) => cell(formatValue(readProperty(row, c.key), c.format, scope))).join(' | ')} |`);
  const chunks: Chunk[] = [{ text: [head, rule, ...body].join('\n') }];
  if (list.length === 0) chunks.push({ text: '_(no rows)_' });
  if (list.length > max) chunks.push({ text: `_…and ${list.length - max} more rows_` });
  return chunks;
}

class TextRenderer {
  constructor(private readonly view: InlineUiView) {}

  children(children: ChildList<string>, scope: ExprScope): Chunk[] {
    const { children: copies, hidden } = expandTemplateChildren(this.view, children, scope);
    const out = copies.flatMap((copy) => this.render(copy.id, copy.scope));
    if (hidden > 0) out.push({ text: `_…and ${hidden} more_` });
    return out;
  }

  render(id: string, scope: ExprScope): Chunk[] {
    const c = getViewComponent(this.view, id);
    if (!c) return [];
    if (c.visible !== undefined && !isTruthy(value(c.visible, scope))) return [];
    return this.component(c, scope);
  }

  private component(c: InlineUiViewComponent, scope: ExprScope): Chunk[] {
    switch (c.component) {
      case 'Column':
      case 'Row':
        return this.children(c.children, scope);
      case 'Card': {
        const title = c.title === undefined ? '' : oneLine(text(c.title, scope));
        return [...(title ? [{ text: `**${title}**` }] : []), ...this.children(c.children, scope)];
      }
      case 'Tabs':
        return c.tabs.flatMap((tab) => [{ text: `**${oneLine(tab.title)}**` }, ...this.render(tab.child, scope)]);
      case 'Steps':
        return c.steps.flatMap((step, i) => [{ text: `**Step ${i + 1} of ${c.steps.length}: ${oneLine(step.title)}**` }, ...this.render(step.child, scope)]);
      case 'Divider':
        return [{ text: '---' }];
      case 'Text': {
        const t = text(c.text, scope);
        switch (c.variant ?? 'body') {
          case 'heading': return [{ text: `### ${oneLine(t)}` }];
          case 'subheading': return [{ text: `#### ${oneLine(t)}` }];
          case 'caption': return [{ text: `_${oneLine(t)}_` }];
          case 'label': return [{ text: `**${oneLine(t)}**` }];
          default: return t.trim() ? [{ text: t.trim() }] : [];
        }
      }
      case 'Stat': {
        const hint = c.hint === undefined ? '' : oneLine(text(c.hint, scope));
        return [{ text: `${oneLine(text(c.label, scope))}: **${orNone(oneLine(text(c.value, scope)))}**${hint ? ` — ${hint}` : ''}` }];
      }
      case 'Badge':
        return [{ text: `[${oneLine(text(c.text, scope))}]` }];
      case 'Progress': {
        const label = c.label === undefined ? 'Progress' : oneLine(text(c.label, scope));
        return [{ text: `${label}: ${orNone(text(c.value, scope))} / ${valueToText(c.max ?? 100, scope)}` }];
      }
      case 'KeyValue':
        return c.items.map((item) => ({ text: `- ${oneLine(text(item.label, scope))}: ${orNone(oneLine(text(item.value, scope)))}`, list: true }));
      case 'Table':
        return table(c.columns, value(c.rows, scope), scope);
      case 'Chart':
        return table([{ key: c.x, label: c.x }, ...c.series.map((s) => ({ key: s.key, label: s.label ?? s.key }))], value(c.data, scope), scope);
      case 'Link': {
        const label = oneLine(text(c.text, scope));
        const url = text(c.url, scope);
        return [{ text: isSafeInlineUiLink(url) ? `[${label.replace(/[[\]]/g, '')}](${url})` : label }];
      }
      case 'TextField':
      case 'DateTimeInput':
        return [{ text: `${oneLine(c.label)}: ${orNone(oneLine(valueToText(bound(c.value, scope), scope)))}` }];
      case 'Slider':
        return [{ text: `${oneLine(c.label)}: ${orNone(formatValue(bound(c.value, scope), c.format, scope))}` }];
      case 'CheckBox':
        return [{ text: `- [${isTruthy(bound(c.value, scope)) ? 'x' : ' '}] ${oneLine(c.label)}`, list: true }];
      case 'ChoicePicker': {
        const options = value(c.options, scope);
        const list = Array.isArray(options) ? options.filter(isJsonObject) : [];
        const current = bound(c.value, scope);
        const chosen = (Array.isArray(current) ? current : current === null ? [] : [current])
          .map((v) => valueToText(list.find((o) => jsonEqual(o.value, v))?.label ?? v, scope));
        const label = c.label === undefined ? 'Choice' : oneLine(c.label);
        const shown = chosen.length ? chosen.join(', ') : `one of ${list.map((o) => valueToText(o.label, scope)).join(', ')}`;
        return [{ text: `${label}: ${oneLine(shown)}` }];
      }
      case 'Button':
        return [{ text: `- ${oneLine(text(c.label, scope))}`, list: true }];
    }
  }
}

/** The view as markdown; see the module comment. */
export function inlineUiViewText(view: InlineUiView, opts: InlineUiViewTextOptions = {}): string {
  const { data, ...format } = opts;
  return join(new TextRenderer(view).render(view.root, viewScope(view, data ?? view.data, format))).trim();
}
