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

export interface PipelineSpec {
  sources: PipelineSourceSpec[];
  /** Reserved for phase 2/3 — currently ignored. */
  transforms?: unknown[];
  widgets?: unknown[];
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
