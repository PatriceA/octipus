/**
 * The component catalog of a view (docs/plans/inline-ui-views-spec.md §2.6):
 * one table that the validator, the normalizer (which props hold children)
 * and the prompt text are all generated from, so they cannot disagree.
 */
import type { InlineUiComponentName } from './types';

/**
 * - `string`, `number`, `boolean`: a literal of that type.
 * - `enum`: one of `values`.
 * - `format`: a value format (`text`, `number`, `currency:EUR`, `percent`, `date`).
 * - `url`: an `https:` URL.
 * - `scalar`: a string, number or boolean.
 * - `any`: any JSON value.
 * - `rows`: a list of objects.
 * - `objects`: a list of objects whose keys are `fields`.
 * - `children`: a list of child nodes or ids, or `{ path, template }`.
 * - `child`: one child node or id.
 * - `action`: an action step or a list of steps (§2.7).
 * - `binding`: `{"@path": …}` only — where an input writes.
 */
export type PropKind = 'string' | 'number' | 'boolean' | 'enum' | 'format' | 'url' | 'scalar' | 'any' | 'rows' | 'objects' | 'children' | 'child' | 'action' | 'binding';

export interface PropSpec {
  kind: PropKind;
  required?: true;
  /** Also takes `{"@path"}`, `{"@expr"}` and, for text, `${…}` interpolation. */
  dynamic?: true;
  /** Accepted values of an `enum`. */
  values?: readonly string[];
  /** The keys of each item of an `objects` list. */
  fields?: Readonly<Record<string, PropSpec>>;
  /** The value the renderer uses when the prop is absent. */
  default?: string | number | boolean;
}

export interface ComponentSpec {
  /** `input` components write the data model or act; the streaming preview disables them. */
  group: 'layout' | 'display' | 'input';
  props: Readonly<Record<string, PropSpec>>;
}

const GAP: PropSpec = { kind: 'enum', values: ['sm', 'md', 'lg'] };
const ALIGN: PropSpec = { kind: 'enum', values: ['start', 'center', 'end', 'stretch'] };
const TONE: PropSpec = { kind: 'enum', values: ['neutral', 'good', 'warn', 'bad'], dynamic: true };
const CHILDREN: PropSpec = { kind: 'children', required: true };
const TITLED: PropSpec = { kind: 'objects', required: true, fields: { title: { kind: 'string', required: true }, child: { kind: 'child', required: true } } };
const LABEL: PropSpec = { kind: 'string', required: true };
const BINDING: PropSpec = { kind: 'binding', required: true };

/** Props every component takes besides its own. */
export const INLINE_UI_COMMON_PROPS: Readonly<Record<string, PropSpec>> = {
  visible: { kind: 'boolean', dynamic: true, default: true },
};

export const INLINE_UI_VIEW_CATALOG: Readonly<Record<InlineUiComponentName, ComponentSpec>> = {
  Column: { group: 'layout', props: { children: CHILDREN, gap: GAP, align: ALIGN } },
  Row: { group: 'layout', props: { children: CHILDREN, gap: GAP, align: ALIGN, justify: { kind: 'enum', values: ['start', 'center', 'end', 'between'] }, wrap: { kind: 'boolean', default: true } } },
  Card: { group: 'layout', props: { title: { kind: 'string', dynamic: true }, children: CHILDREN } },
  Tabs: { group: 'layout', props: { tabs: TITLED } },
  Steps: { group: 'layout', props: { steps: TITLED } },
  Divider: { group: 'layout', props: {} },
  Text: { group: 'display', props: { text: { kind: 'string', required: true, dynamic: true }, variant: { kind: 'enum', values: ['body', 'heading', 'subheading', 'caption', 'label'], default: 'body' } } },
  Stat: { group: 'display', props: { label: { kind: 'string', required: true, dynamic: true }, value: { kind: 'any', required: true, dynamic: true }, hint: { kind: 'string', dynamic: true }, tone: TONE } },
  Badge: { group: 'display', props: { text: { kind: 'string', required: true, dynamic: true }, tone: TONE } },
  Progress: { group: 'display', props: { value: { kind: 'number', required: true, dynamic: true }, max: { kind: 'number', default: 100 }, label: { kind: 'string', dynamic: true } } },
  KeyValue: { group: 'display', props: { items: { kind: 'objects', required: true, fields: { label: { kind: 'string', required: true, dynamic: true }, value: { kind: 'any', required: true, dynamic: true } } } } },
  Table: {
    group: 'display',
    props: {
      columns: {
        kind: 'objects',
        required: true,
        fields: {
          key: { kind: 'string', required: true },
          label: { kind: 'string', required: true },
          align: { kind: 'enum', values: ['start', 'center', 'end'] },
          format: { kind: 'format' },
          sortable: { kind: 'boolean' },
        },
      },
      rows: { kind: 'rows', required: true, dynamic: true },
      filter: { kind: 'boolean' },
      pageSize: { kind: 'number', default: 10 },
      selectable: { kind: 'enum', values: ['single', 'multiple'] },
      selected: { kind: 'binding' },
      rowKey: { kind: 'string' },
    },
  },
  Chart: {
    group: 'display',
    props: {
      type: { kind: 'enum', required: true, values: ['bar', 'line', 'area', 'pie'] },
      data: { kind: 'rows', required: true, dynamic: true },
      x: { kind: 'string', required: true },
      series: { kind: 'objects', required: true, fields: { key: { kind: 'string', required: true }, label: { kind: 'string' } } },
      stacked: { kind: 'boolean' },
      height: { kind: 'number' },
    },
  },
  Link: { group: 'display', props: { text: { kind: 'string', required: true, dynamic: true }, url: { kind: 'url', required: true, dynamic: true } } },
  TextField: {
    group: 'input',
    props: {
      label: LABEL,
      value: BINDING,
      variant: { kind: 'enum', values: ['short', 'long', 'number'], default: 'short' },
      placeholder: { kind: 'string' },
      min: { kind: 'number' },
      max: { kind: 'number' },
      required: { kind: 'boolean' },
    },
  },
  Slider: { group: 'input', props: { label: LABEL, value: BINDING, min: { kind: 'number', required: true }, max: { kind: 'number', required: true }, step: { kind: 'number' }, format: { kind: 'format' } } },
  CheckBox: { group: 'input', props: { label: LABEL, value: BINDING } },
  ChoicePicker: {
    group: 'input',
    props: {
      label: { kind: 'string' },
      options: { kind: 'objects', required: true, dynamic: true, fields: { label: { kind: 'string', required: true }, value: { kind: 'scalar', required: true }, description: { kind: 'string' } } },
      value: BINDING,
      multiple: { kind: 'boolean' },
      display: { kind: 'enum', values: ['radio', 'chips', 'select'] },
    },
  },
  DateTimeInput: { group: 'input', props: { label: LABEL, value: BINDING, enableDate: { kind: 'boolean', default: true }, enableTime: { kind: 'boolean' }, min: { kind: 'string' }, max: { kind: 'string' } } },
  Button: {
    group: 'input',
    props: {
      label: { kind: 'string', required: true, dynamic: true },
      action: { kind: 'action', required: true },
      variant: { kind: 'enum', values: ['primary', 'default', 'borderless', 'danger'] },
      disabled: { kind: 'boolean', dynamic: true },
    },
  },
};

export const INLINE_UI_COMPONENT_NAMES = Object.keys(INLINE_UI_VIEW_CATALOG) as InlineUiComponentName[];

export function isInlineUiComponentName(name: unknown): name is InlineUiComponentName {
  return typeof name === 'string' && Object.hasOwn(INLINE_UI_VIEW_CATALOG, name);
}

/** The spec of one prop of a component (its own or a common one), or undefined. */
export function inlineUiPropSpec(component: InlineUiComponentName, prop: string): PropSpec | undefined {
  const own = INLINE_UI_VIEW_CATALOG[component].props;
  if (Object.hasOwn(own, prop)) return own[prop];
  return Object.hasOwn(INLINE_UI_COMMON_PROPS, prop) ? INLINE_UI_COMMON_PROPS[prop] : undefined;
}

/** `seen` holds enums already spelled out: each list of values is shown once, at its first use. */
function propSignature(name: string, spec: PropSpec, seen: Set<string>): string {
  let out = `${name}${spec.required ? '' : '?'}${spec.dynamic ? '~' : ''}`;
  if (spec.kind === 'enum' && spec.values) {
    const values = spec.values.join('|');
    if (!seen.has(values)) out += `:${values}`;
    seen.add(values);
  } else if (spec.kind === 'objects' && spec.fields) {
    out += `:[{${Object.entries(spec.fields).map(([k, f]) => propSignature(k, f, seen)).join(',')}}]`;
  } else if (spec.kind === 'binding' && name !== 'value') {
    // The legend covers inputs' `value`; any other binding says so itself.
    out += ':@path';
  }
  return out;
}

/**
 * The catalog as compact signatures for the system prompt (under 1 500
 * characters, roughly 350–400 tokens): a legend, one line per component,
 * then children, formats and actions.
 */
export function inlineUiViewCatalogPrompt(): string {
  const seen = new Set<string>();
  return [
    'Components (? optional; ~ dynamic: literal, {"@path":"/a/0"}, {"@expr":"…"} or "text ${expr}"; inputs\' value is {"@path"}; all take visible?~):',
    ...INLINE_UI_COMPONENT_NAMES.map((name) => {
      const props = Object.entries(INLINE_UI_VIEW_CATALOG[name].props).map(([k, spec]) => propSignature(k, spec, seen));
      return props.length ? `${name}(${props.join(', ')})` : name;
    }),
    'children: [node…] or {"path":"/list","template":node} (inside: $item, $index, relative paths)',
    'format: text|number|currency:EUR|percent|date',
    'action, ≤4 in a list: {"set":{"path","value~"}} {"openUrl~"} {"event":{"name","context?","userMessage?~"}}',
  ].join('\n');
}
