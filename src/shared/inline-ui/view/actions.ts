/**
 * Pure helpers the view renderer needs (docs/plans/inline-ui-views-spec.md
 * §2.6, §2.7, §4): scopes, template expansion, and running a component's
 * actions — local writes, links, and the event that answers the agent.
 */
import { cleanSuggestedText, isSafeInlineUiLink } from '../bridge';
import { INLINE_UI_VIEW_LIMITS } from '../limits';
import { getPointer, resolveDynamic, resolvePath, setPointer } from './data';
import type { ExprScope } from './expr';
import { type FormatOptions, valueToText } from './format';
import { toJsonSafe } from './json';
import { childRefs } from './normalize';
import type { ChildList, EventStepBody, InlineUiActionProp, InlineUiActionStep, InlineUiView, InlineUiViewComponent, JsonObject, SetStep } from './types';

/** The top-level scope of a view: its data (or `data`, e.g. a stored answer's) and computed names. */
export function viewScope(view: InlineUiView, data: JsonObject = view.data, opts: FormatOptions = {}): ExprScope {
  return { data, computed: view.computed, ...opts };
}

export function getViewComponent(view: InlineUiView, id: string): InlineUiViewComponent | undefined {
  return view.components.find((c) => c.id === id);
}

/** An `action` prop as a list of steps. */
export function actionSteps(action: InlineUiActionProp | undefined): InlineUiActionStep[] {
  if (action === undefined) return [];
  return Array.isArray(action) ? action : [action];
}

/** The event steps a component's actions carry. */
export function componentEventSteps(component: InlineUiViewComponent): EventStepBody[] {
  if (component.component !== 'Button') return [];
  return actionSteps(component.action).flatMap((step) => ('event' in step ? [step.event] : []));
}

/** The number of copies a template may render: 200, fewer when each copy has many components. */
export function templateItemLimit(view: InlineUiView, templateId: string): number {
  const byId = new Map(view.components.map((c) => [c.id, c]));
  const size = (id: string): number => {
    const c = byId.get(id);
    return c ? 1 + childRefs(c).reduce((n, ref) => n + size(ref.id), 0) : 0;
  };
  return Math.max(1, Math.min(INLINE_UI_VIEW_LIMITS.templateItems, Math.floor(INLINE_UI_VIEW_LIMITS.renderedComponents / Math.max(1, size(templateId)))));
}

/** One child to render: the component id, a stable key, and the scope it renders in. */
export interface ChildCopy { id: string; key: string; scope: ExprScope }

/**
 * The children to render for a `children` prop. A list renders as is; a
 * template renders one copy per item of the list at its path (nothing when
 * the path does not hold a list), each with `item`, `index` and `itemPath`,
 * up to `templateItemLimit`; `hidden` counts the items left out.
 */
export function expandTemplateChildren(view: InlineUiView, children: ChildList<string>, scope: ExprScope): { children: ChildCopy[]; hidden: number } {
  if (Array.isArray(children)) return { children: children.map((id) => ({ id, key: id, scope })), hidden: 0 };
  const itemsPath = resolvePath(children.path, scope);
  const list = getPointer(scope.data, itemsPath);
  if (!Array.isArray(list)) return { children: [], hidden: 0 };
  const limit = templateItemLimit(view, children.template);
  const copies = list.slice(0, limit).map((item, index) => ({
    id: children.template,
    key: `${children.template}:${index}`,
    scope: { ...scope, item, index, itemPath: `${itemsPath}/${index}` },
  }));
  return { children: copies, hidden: Math.max(0, list.length - limit) };
}

/** A resolved event: what `inlineUi.action` carries and the message the conversation shows. */
export interface ResolvedEvent {
  name: string;
  /** Every context value resolved; numbers that are not finite become null. */
  context: JsonObject;
  /** `userMessage` interpolated, or the button's label; cleaned like a suggestion (S6). */
  userMessage: string;
}

/**
 * Resolve an event step of `componentId` in `scope` (the data model at the
 * click, and the template item when the button is inside a template).
 */
export function resolveEventAction(view: InlineUiView, componentId: string, event: EventStepBody, scope: ExprScope): ResolvedEvent {
  const context: JsonObject = {};
  for (const [key, value] of Object.entries(event.context ?? {})) context[key] = toJsonSafe(resolveDynamic(value, scope));
  let message = event.userMessage === undefined ? '' : cleanSuggestedText(valueToText(resolveDynamic(event.userMessage, scope), scope));
  if (!message) {
    const component = getViewComponent(view, componentId);
    const label = component?.component === 'Button' ? valueToText(resolveDynamic(component.label, scope), scope) : '';
    message = cleanSuggestedText(label) || event.name;
  }
  return { name: event.name, context, userMessage: message };
}

/** The data model after a `set` step, resolved in `scope`; `data` is not changed. Throws for a path that cannot be written. */
export function applySetAction(data: JsonObject, action: SetStep, scope: ExprScope): JsonObject {
  const here = { ...scope, data };
  return setPointer(data, resolvePath(action.set.path, here), toJsonSafe(resolveDynamic(action.set.value, here)));
}

export type ViewEffect =
  | { type: 'openUrl'; url: string }
  | { type: 'event'; event: ResolvedEvent };

/**
 * Run a component's `action` steps in order at a click. Each `set` sees the
 * writes before it (and the template item is read again from its path);
 * links and events are returned as effects for the page to carry out, in
 * order. Throws for a link that is not `https:` or a path that cannot be
 * written, before any effect is returned.
 */
export function runViewActions(view: InlineUiView, componentId: string, scope: ExprScope): { data: JsonObject; effects: ViewEffect[] } {
  const component = getViewComponent(view, componentId);
  if (!component) throw new Error(`the view has no component "${componentId}"`);
  let data = scope.data;
  const effects: ViewEffect[] = [];
  const current = (): ExprScope => {
    const item = scope.itemPath === undefined ? scope.item : getPointer(data, scope.itemPath);
    return { ...scope, data, ...(scope.itemPath === undefined ? {} : { item: item ?? null }) };
  };
  const steps = component.component === 'Button' ? actionSteps(component.action) : [];
  for (const step of steps) {
    if ('set' in step) {
      data = applySetAction(data, step, current());
    } else if ('openUrl' in step) {
      const url = valueToText(resolveDynamic(step.openUrl, current()));
      if (!isSafeInlineUiLink(url)) throw new Error(`the link "${url.slice(0, 80)}" is not an https: URL`);
      effects.push({ type: 'openUrl', url });
    } else {
      effects.push({ type: 'event', event: resolveEventAction(view, componentId, step.event, current()) });
    }
  }
  return { data, effects };
}
