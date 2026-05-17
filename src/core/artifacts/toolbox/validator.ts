/**
 * Pipeline validator — dry-runs an artifact's toolbox wiring without
 * executing any tool. Catches missing tool ids, unknown params, type
 * mismatches, and (later) bind-path resolution against transform output
 * schemas. Called from `art_toolbox_validate` and the create/update flow.
 *
 * Phase 1 scope: validate collectors only (sources). Transforms / widgets
 * arrive in Phase 2 and extend this same function.
 */

import { getToolboxRegistry } from './registry';
import type { ToolboxParamSpec } from './types';

export interface PipelineSourceSpec {
  name: string;
  /** Stable toolbox tool id, e.g. `art_collect_http_json`. */
  toolId: string;
  params: Record<string, unknown>;
  refreshSeconds?: number;
}

export interface PipelineTransformSpec {
  name: string;
  toolId: string;
  inputName: string;
  params: Record<string, unknown>;
  position?: number;
}

export interface PipelineWidgetSpec {
  slot: string;
  toolId: string;
  /** Map of widget-param-name → data-bus path. */
  bind: Record<string, string>;
  params?: Record<string, unknown>;
  position?: number;
}

export interface PipelineSpec {
  sources: PipelineSourceSpec[];
  transforms?: PipelineTransformSpec[];
  widgets?: PipelineWidgetSpec[];
  /** Reserved for phase 3 — currently ignored. */
  exports?: unknown[];
}

export interface ValidationIssue {
  /** Dotted path into the spec, e.g. `sources[2].params.url`. */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function validatePipeline(spec: PipelineSpec): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const registry = getToolboxRegistry();

  if (!Array.isArray(spec.sources) || spec.sources.length === 0) {
    errors.push({
      path: 'sources',
      message: 'pipeline must declare at least one source',
      severity: 'error',
    });
  }

  const namesSeen = new Set<string>();
  spec.sources?.forEach((source, i) => {
    const base = `sources[${i}]`;

    if (!source.name || typeof source.name !== 'string') {
      errors.push({ path: `${base}.name`, message: 'source.name is required', severity: 'error' });
    } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(source.name)) {
      errors.push({
        path: `${base}.name`,
        message: 'source.name must be a valid identifier (letters/digits/underscore, no leading digit)',
        severity: 'error',
      });
    } else if (namesSeen.has(source.name)) {
      errors.push({
        path: `${base}.name`,
        message: `duplicate source name "${source.name}"`,
        severity: 'error',
      });
    } else {
      namesSeen.add(source.name);
    }

    if (!source.toolId) {
      errors.push({
        path: `${base}.toolId`,
        message: 'source.toolId is required (use `art_toolbox_search` to find one)',
        severity: 'error',
      });
      return;
    }
    const tool = registry.get(source.toolId);
    if (!tool) {
      errors.push({
        path: `${base}.toolId`,
        message: `unknown toolbox tool "${source.toolId}" — call art_toolbox_search to discover available collectors`,
        severity: 'error',
      });
      return;
    }
    if (tool.family !== 'collect') {
      errors.push({
        path: `${base}.toolId`,
        message: `tool "${source.toolId}" belongs to family "${tool.family}" — sources require a "collect" tool`,
        severity: 'error',
      });
      return;
    }

    // Param checks.
    const params = source.params ?? {};
    for (const [key, spec] of Object.entries(tool.params)) {
      const issue = checkParam(`${base}.params.${key}`, params[key], spec);
      if (issue) (issue.severity === 'error' ? errors : warnings).push(issue);
    }
    for (const key of Object.keys(params)) {
      if (!(key in tool.params)) {
        warnings.push({
          path: `${base}.params.${key}`,
          message: `unknown parameter "${key}" for ${tool.id} — ignored at runtime`,
          severity: 'warning',
        });
      }
    }

    if (source.refreshSeconds !== undefined) {
      if (typeof source.refreshSeconds !== 'number' || source.refreshSeconds < 30) {
        errors.push({
          path: `${base}.refreshSeconds`,
          message: 'refreshSeconds must be a number ≥ 30',
          severity: 'error',
        });
      }
    }
  });

  // Transforms — same shape checks, plus inputName must resolve to a
  // declared source or an earlier transform.
  const knownNames = new Set<string>(namesSeen);
  const transformsSorted = [...(spec.transforms ?? [])]
    .map((t, i) => ({ t, originalIndex: i }))
    .sort((a, b) => (a.t.position ?? 0) - (b.t.position ?? 0));
  transformsSorted.forEach(({ t, originalIndex }) => {
    const base = `transforms[${originalIndex}]`;
    if (!t.name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t.name)) {
      errors.push({ path: `${base}.name`, message: 'transform.name must be a valid identifier', severity: 'error' });
      return;
    }
    if (knownNames.has(t.name)) {
      errors.push({ path: `${base}.name`, message: `name "${t.name}" collides with a source or earlier transform`, severity: 'error' });
    } else {
      knownNames.add(t.name);
    }
    if (!t.toolId) {
      errors.push({ path: `${base}.toolId`, message: 'transform.toolId is required', severity: 'error' });
      return;
    }
    const tool = registry.get(t.toolId);
    if (!tool) {
      errors.push({ path: `${base}.toolId`, message: `unknown toolbox tool "${t.toolId}"`, severity: 'error' });
      return;
    }
    if (tool.family !== 'transform') {
      errors.push({ path: `${base}.toolId`, message: `tool "${t.toolId}" is a ${tool.family}, expected transform`, severity: 'error' });
      return;
    }
    if (!t.inputName || !knownNames.has(t.inputName)) {
      errors.push({
        path: `${base}.inputName`,
        message: `inputName "${t.inputName}" does not resolve to a declared source or earlier transform`,
        severity: 'error',
      });
    }
    const params = t.params ?? {};
    for (const [key, spec] of Object.entries(tool.params)) {
      const issue = checkParam(`${base}.params.${key}`, params[key], spec);
      if (issue) (issue.severity === 'error' ? errors : warnings).push(issue);
    }
  });

  // Widgets — slot must be unique, bind targets must look valid, params + tool
  // must match. Bind paths are best-effort: we only check syntactic validity
  // (top-level name must exist in knownNames); deep paths resolve at render
  // time.
  const slotsSeen = new Set<string>();
  spec.widgets?.forEach((w, i) => {
    const base = `widgets[${i}]`;
    if (!w.slot || !/^[a-zA-Z0-9_-]+$/.test(w.slot)) {
      errors.push({ path: `${base}.slot`, message: 'widget.slot is required and must match [a-zA-Z0-9_-]+', severity: 'error' });
    } else if (slotsSeen.has(w.slot)) {
      errors.push({ path: `${base}.slot`, message: `duplicate slot "${w.slot}"`, severity: 'error' });
    } else {
      slotsSeen.add(w.slot);
    }
    if (!w.toolId) {
      errors.push({ path: `${base}.toolId`, message: 'widget.toolId is required', severity: 'error' });
      return;
    }
    const tool = registry.get(w.toolId);
    if (!tool) {
      errors.push({ path: `${base}.toolId`, message: `unknown toolbox tool "${w.toolId}"`, severity: 'error' });
      return;
    }
    if (tool.family !== 'widget') {
      errors.push({ path: `${base}.toolId`, message: `tool "${w.toolId}" is a ${tool.family}, expected widget`, severity: 'error' });
      return;
    }
    for (const [paramName, pathExpr] of Object.entries(w.bind ?? {})) {
      if (typeof pathExpr !== 'string') {
        errors.push({ path: `${base}.bind.${paramName}`, message: 'bind target must be a string path', severity: 'error' });
        continue;
      }
      const top = pathExpr.split('.')[0];
      if (!knownNames.has(top)) {
        warnings.push({
          path: `${base}.bind.${paramName}`,
          message: `bind path "${pathExpr}" does not resolve to a declared source/transform (top-level "${top}")`,
          severity: 'warning',
        });
      }
    }
    // Required-param check honours binds as well as static params.
    const allKeys = new Set([
      ...Object.keys(w.bind ?? {}),
      ...Object.keys(w.params ?? {}),
    ]);
    for (const [key, spec] of Object.entries(tool.params)) {
      if (spec.required && !allKeys.has(key)) {
        errors.push({
          path: `${base}.params.${key}`,
          message: `required parameter "${key}" is missing (provide in bind or params)`,
          severity: 'error',
        });
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

function checkParam(
  path: string,
  value: unknown,
  spec: ToolboxParamSpec,
): ValidationIssue | null {
  if (value === undefined || value === null) {
    if (spec.required) {
      return { path, message: `missing required parameter`, severity: 'error' };
    }
    return null;
  }
  const actual = actualType(value);
  if (actual !== spec.type) {
    return {
      path,
      message: `expected ${spec.type}, got ${actual}`,
      severity: 'error',
    };
  }
  if (spec.enum && !spec.enum.includes(value as never)) {
    return {
      path,
      message: `value must be one of: ${spec.enum.join(', ')}`,
      severity: 'error',
    };
  }
  return null;
}

function actualType(value: unknown): ToolboxParamSpec['type'] | 'null' {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object') return t;
  return 'object';
}
