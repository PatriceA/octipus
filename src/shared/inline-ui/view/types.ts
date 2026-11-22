/**
 * Types of a declarative view, the second kind of interactive answer
 * (docs/plans/inline-ui-views-spec.md). Shared by the server and the web:
 * type-only, no runtime imports.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

// ── Dynamic values (§2.4) ───────────────────────────────────────────────

/** JSON Pointer into the data model; without a leading `/` it is relative to the template item. */
export interface PathRef { '@path': string }
/** An expression (§2.5). */
export interface ExprRef { '@expr': string }
/**
 * A dynamic prop: a literal, a path, an expression, or (for strings) a text
 * with `${…}` interpolations. Resolution is shallow: a literal list or object
 * is returned as written (its own dynamic fields, where the catalog declares
 * any, are resolved one by one).
 */
export type Dynamic<T extends JsonValue = JsonValue> = T | PathRef | ExprRef;

// ── Actions (§2.7) ──────────────────────────────────────────────────────

export interface SetStep { set: { path: string; value: Dynamic } }
export interface OpenUrlStep { openUrl: Dynamic<string> }
export interface EventStepBody {
  name: string;
  context?: Record<string, Dynamic>;
  userMessage?: Dynamic<string>;
}
export interface EventStep { event: EventStepBody }
/** One step of a component's `action`. */
export type InlineUiActionStep = SetStep | OpenUrlStep | EventStep;
/** An `action` prop: one step or a list of at most four, run in order. */
export type InlineUiActionProp = InlineUiActionStep | InlineUiActionStep[];

// ── Children ────────────────────────────────────────────────────────────

/** One copy of `template` per item of the list at `path`. */
export interface TemplateChildren<C> { path: string; template: C }
/** `children`: a list of child references, or a template. */
export type ChildList<C> = C[] | TemplateChildren<C>;
export interface TitledChild<C> { title: string; child: C }

// ── Catalog (§2.6) ──────────────────────────────────────────────────────
// `C` is how a child is referenced: an id in the stored view, a node or an
// id in an authored document.

export type Gap = 'sm' | 'md' | 'lg';
export type Align = 'start' | 'center' | 'end' | 'stretch';
export type Justify = 'start' | 'center' | 'end' | 'between';
export type Tone = 'neutral' | 'good' | 'warn' | 'bad';
export type TextVariant = 'body' | 'heading' | 'subheading' | 'caption' | 'label';
/** `text`, `number`, `currency:<ISO 4217 code>`, `percent` (a ratio: 0.25 is 25 %) or `date`. */
export type ValueFormat = 'text' | 'number' | `currency:${string}` | 'percent' | 'date';

/** Props every component takes. */
export interface CommonProps { visible?: Dynamic<boolean> }

export interface ColumnProps<C> extends CommonProps { children: ChildList<C>; gap?: Gap; align?: Align }
export interface RowProps<C> extends CommonProps { children: ChildList<C>; gap?: Gap; align?: Align; justify?: Justify; wrap?: boolean }
export interface CardProps<C> extends CommonProps { title?: Dynamic<string>; children: ChildList<C> }
export interface TabsProps<C> extends CommonProps { tabs: TitledChild<C>[] }
export interface StepsProps<C> extends CommonProps { steps: TitledChild<C>[] }
export type DividerProps = CommonProps;

export interface TextProps extends CommonProps { text: Dynamic<string>; variant?: TextVariant }
export interface StatProps extends CommonProps { label: Dynamic<string>; value: Dynamic; hint?: Dynamic<string>; tone?: Dynamic<Tone> }
export interface BadgeProps extends CommonProps { text: Dynamic<string>; tone?: Dynamic<Tone> }
export interface ProgressProps extends CommonProps { value: Dynamic<number>; max?: number; label?: Dynamic<string> }
export interface KeyValueProps extends CommonProps { items: Array<{ label: Dynamic<string>; value: Dynamic }> }
export interface TableColumn { key: string; label: string; align?: 'start' | 'center' | 'end'; format?: ValueFormat; sortable?: boolean }
export interface TableProps extends CommonProps {
  columns: TableColumn[];
  rows: Dynamic<JsonObject[]>;
  filter?: boolean;
  pageSize?: number;
  selectable?: 'single' | 'multiple';
  /** Receives the selected row (single) or rows (multiple). */
  selected?: PathRef;
  rowKey?: string;
}
export interface ChartProps extends CommonProps {
  type: 'bar' | 'line' | 'area' | 'pie';
  data: Dynamic<JsonObject[]>;
  x: string;
  series: Array<{ key: string; label?: string }>;
  stacked?: boolean;
  height?: number;
}
export interface LinkProps extends CommonProps { text: Dynamic<string>; url: Dynamic<string> }

export interface TextFieldProps extends CommonProps {
  label: string;
  value: PathRef;
  variant?: 'short' | 'long' | 'number';
  placeholder?: string;
  min?: number;
  max?: number;
  required?: boolean;
}
export interface SliderProps extends CommonProps { label: string; value: PathRef; min: number; max: number; step?: number; format?: ValueFormat }
export interface CheckBoxProps extends CommonProps { label: string; value: PathRef }
// A type alias, not an interface, so it is assignable to JsonValue.
export type ChoiceOption = { label: string; value: string | number | boolean; description?: string };
export interface ChoicePickerProps extends CommonProps {
  label?: string;
  options: Dynamic<ChoiceOption[]>;
  value: PathRef;
  multiple?: boolean;
  display?: 'radio' | 'chips' | 'select';
}
export interface DateTimeInputProps extends CommonProps {
  label: string;
  value: PathRef;
  enableDate?: boolean;
  enableTime?: boolean;
  /** ISO 8601 date or date-time. */
  min?: string;
  max?: string;
}
export interface ButtonProps extends CommonProps {
  label: Dynamic<string>;
  action: InlineUiActionProp;
  variant?: 'primary' | 'default' | 'borderless' | 'danger';
  disabled?: Dynamic<boolean>;
}

/** Props of each catalog component, by name. */
export interface InlineUiComponentProps<C> {
  Column: ColumnProps<C>;
  Row: RowProps<C>;
  Card: CardProps<C>;
  Tabs: TabsProps<C>;
  Steps: StepsProps<C>;
  Divider: DividerProps;
  Text: TextProps;
  Stat: StatProps;
  Badge: BadgeProps;
  Progress: ProgressProps;
  KeyValue: KeyValueProps;
  Table: TableProps;
  Chart: ChartProps;
  Link: LinkProps;
  TextField: TextFieldProps;
  Slider: SliderProps;
  CheckBox: CheckBoxProps;
  ChoicePicker: ChoicePickerProps;
  DateTimeInput: DateTimeInputProps;
  Button: ButtonProps;
}
export type InlineUiComponentName = keyof InlineUiComponentProps<string>;

/** A stored component: children are ids. Narrow on `component`. */
export type InlineUiViewComponent = {
  [K in InlineUiComponentName]: { id: string; component: K } & InlineUiComponentProps<string>[K];
}[InlineUiComponentName];
/** The stored component of one kind. */
export type InlineUiViewComponentOf<K extends InlineUiComponentName> = Extract<InlineUiViewComponent, { component: K }>;

// ── Documents ───────────────────────────────────────────────────────────

// One interface per component (not a mapped type): interfaces resolve lazily,
// which the recursion through `AuthoredChild` needs.
export interface AuthoredColumn extends ColumnProps<AuthoredChild> { id?: string; component: 'Column' }
export interface AuthoredRow extends RowProps<AuthoredChild> { id?: string; component: 'Row' }
export interface AuthoredCard extends CardProps<AuthoredChild> { id?: string; component: 'Card' }
export interface AuthoredTabs extends TabsProps<AuthoredChild> { id?: string; component: 'Tabs' }
export interface AuthoredSteps extends StepsProps<AuthoredChild> { id?: string; component: 'Steps' }
export interface AuthoredDivider extends DividerProps { id?: string; component: 'Divider' }
export interface AuthoredText extends TextProps { id?: string; component: 'Text' }
export interface AuthoredStat extends StatProps { id?: string; component: 'Stat' }
export interface AuthoredBadge extends BadgeProps { id?: string; component: 'Badge' }
export interface AuthoredProgress extends ProgressProps { id?: string; component: 'Progress' }
export interface AuthoredKeyValue extends KeyValueProps { id?: string; component: 'KeyValue' }
export interface AuthoredTable extends TableProps { id?: string; component: 'Table' }
export interface AuthoredChart extends ChartProps { id?: string; component: 'Chart' }
export interface AuthoredLink extends LinkProps { id?: string; component: 'Link' }
export interface AuthoredTextField extends TextFieldProps { id?: string; component: 'TextField' }
export interface AuthoredSlider extends SliderProps { id?: string; component: 'Slider' }
export interface AuthoredCheckBox extends CheckBoxProps { id?: string; component: 'CheckBox' }
export interface AuthoredChoicePicker extends ChoicePickerProps { id?: string; component: 'ChoicePicker' }
export interface AuthoredDateTimeInput extends DateTimeInputProps { id?: string; component: 'DateTimeInput' }
export interface AuthoredButton extends ButtonProps { id?: string; component: 'Button' }
/** A node as an agent writes it: children inline (or as ids), `id` optional. */
export type AuthoredNode =
  | AuthoredColumn
  | AuthoredRow
  | AuthoredCard
  | AuthoredTabs
  | AuthoredSteps
  | AuthoredDivider
  | AuthoredText
  | AuthoredStat
  | AuthoredBadge
  | AuthoredProgress
  | AuthoredKeyValue
  | AuthoredTable
  | AuthoredChart
  | AuthoredLink
  | AuthoredTextField
  | AuthoredSlider
  | AuthoredCheckBox
  | AuthoredChoicePicker
  | AuthoredDateTimeInput
  | AuthoredButton;
export type AuthoredChild = AuthoredNode | string;

/**
 * The view as written in the fence (§2.2): the nested form (`root`), or the
 * A2UI flat form (`components`, children as ids, the root has id `root`).
 * Both may be combined: nodes in `components` can be referenced by id.
 */
export interface AuthoredView {
  data?: JsonObject;
  computed?: Record<string, string>;
  root?: AuthoredNode;
  components?: AuthoredNode[];
}

/**
 * The stored view (§2.3): an adjacency list in depth-first order, the root
 * first, every id unique, every component reachable from the root exactly
 * once. Unknown props are already dropped.
 */
export interface InlineUiView {
  version: 1;
  /** Id of the root component (also `components[0].id`). */
  root: string;
  components: InlineUiViewComponent[];
  data: JsonObject;
  computed: Record<string, string>;
}

// ── Answers (§4) ────────────────────────────────────────────────────────

/** The `inlineUi.action` payload of `chat.send`. */
export interface InlineUiViewAction {
  blockId: string;
  name: string;
  /** Id of the component that carries the event (a template's copies share it). */
  componentId: string;
  /** The event's context, every value resolved at the click. */
  context: JsonObject;
}

/** `inline_ui_blocks.state` of a view: the last answer. */
export interface InlineUiViewState {
  /** The data model at the click. */
  data: JsonObject;
  action: { name: string; componentId: string; /** ISO 8601 time. */ at: string };
}
