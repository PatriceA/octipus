'use client';

/**
 * What every component of a rendered view reads (docs/plans/inline-ui-views-spec.md
 * §5): the view, its data model, how an input writes, whether inputs and
 * event buttons are live, and how a click runs a button's actions.
 */
import { createContext, useContext } from 'react';
import {
  type Dynamic,
  type ExprScope,
  type FormatOptions,
  INLINE_UI_COMMON_PROPS,
  INLINE_UI_VIEW_CATALOG,
  type InlineUiComponentName,
  type InlineUiView,
  type InlineUiViewComponent,
  type InlineUiViewComponentOf,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type PropSpec,
  resolveDynamic,
} from '../../../../../src/shared/inline-ui/view';

export interface ViewRuntime {
  view: InlineUiView;
  components: ReadonlyMap<string, InlineUiViewComponent>;
  data: JsonObject;
  /** Write `value` at an absolute pointer of the data model. */
  write: (pointer: string, value: JsonValue) => void;
  /** Inputs show their value but do not change it (an answer was sent). */
  readOnly: boolean;
  /** Inputs and buttons are off altogether (a streaming preview, or `disabled`). */
  inert: boolean;
  /** Why a button that answers the agent cannot be pressed now, or null. */
  eventBlock: string | null;
  /** Id of the element that explains `eventBlock`, for `aria-describedby`. */
  eventBlockId: string;
  /** Run a button's actions (it was clicked) in the scope it rendered in. */
  click: (componentId: string, scope: ExprScope) => void;
  format: FormatOptions;
  /** The text comes from another install: Markdown loads no images and links nothing here. */
  untrusted: boolean;
}

export const ViewRuntimeContext = createContext<ViewRuntime | null>(null);

export function useViewRuntime(): ViewRuntime {
  const rt = useContext(ViewRuntimeContext);
  if (!rt) throw new Error('a view component rendered outside InlineUiView');
  return rt;
}

/** The dynamic props of one component, resolved in its scope (static props are read from the component). */
export type ResolvedProps = Readonly<Record<string, JsonValue>>;

export interface NodeProps<K extends InlineUiComponentName> {
  c: InlineUiViewComponentOf<K>;
  r: ResolvedProps;
  scope: ExprScope;
}

function dynamicFields(spec: PropSpec): string[] {
  return spec.fields ? Object.entries(spec.fields).filter(([, f]) => f.dynamic).map(([k]) => k) : [];
}

/**
 * Resolve every prop the catalog marks dynamic, and the dynamic fields of
 * list props (`KeyValue.items`): resolution is shallow, so those are read one
 * by one. Throws with the prop named, for the component's inline error.
 */
export function resolveProps(c: InlineUiViewComponent, scope: ExprScope): ResolvedProps {
  const raw = c as unknown as Record<string, Dynamic | undefined>;
  const out: Record<string, JsonValue> = {};
  const specs = { ...INLINE_UI_COMMON_PROPS, ...INLINE_UI_VIEW_CATALOG[c.component].props };
  for (const [prop, spec] of Object.entries(specs)) {
    const value = raw[prop];
    const fields = dynamicFields(spec);
    if (value === undefined || (!spec.dynamic && fields.length === 0)) continue;
    try {
      let resolved: JsonValue = spec.dynamic ? resolveDynamic(value, scope) : (value as JsonValue);
      if (fields.length && Array.isArray(resolved)) {
        resolved = resolved.map((item) => {
          if (!isJsonObject(item)) return item;
          const next: JsonObject = { ...item };
          for (const k of fields) if (item[k] !== undefined) next[k] = resolveDynamic(item[k], scope);
          return next;
        });
      }
      out[prop] = resolved;
    } catch (err) {
      throw new Error(`${prop}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
