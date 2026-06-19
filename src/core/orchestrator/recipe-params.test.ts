import { describe, expect, test } from 'bun:test';
import type { RecipeParameter } from '@/db/schema/pipeline-templates';
import {
  paramTemplateVars,
  resolveRecipeParams,
  validateRecipeParameterDefs,
} from './recipe-params';

describe('validateRecipeParameterDefs', () => {
  test('accepts valid defs', () => {
    const defs = [
      { key: 'repo', inputType: 'string', requirement: 'required' },
      { key: 'env', inputType: 'select', requirement: 'optional', options: ['dev', 'prod'], default: 'dev' },
    ];
    expect(validateRecipeParameterDefs(defs)).toHaveLength(2);
  });

  test('rejects an invalid key', () => {
    expect(() => validateRecipeParameterDefs([{ key: '1bad', inputType: 'string', requirement: 'required' }])).toThrow();
  });

  test('rejects a select param without options', () => {
    expect(() => validateRecipeParameterDefs([{ key: 'env', inputType: 'select', requirement: 'optional' }])).toThrow(/options/);
  });

  test('rejects an unknown inputType', () => {
    expect(() => validateRecipeParameterDefs([{ key: 'x', inputType: 'json', requirement: 'optional' }])).toThrow();
  });

  test('rejects duplicate keys', () => {
    expect(() =>
      validateRecipeParameterDefs([
        { key: 'a', inputType: 'string', requirement: 'optional' },
        { key: 'a', inputType: 'number', requirement: 'optional' },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe('resolveRecipeParams', () => {
  const defs: RecipeParameter[] = [
    { key: 'repo', inputType: 'string', requirement: 'required' },
    { key: 'count', inputType: 'number', requirement: 'optional', default: '3' },
    { key: 'env', inputType: 'select', requirement: 'optional', options: ['dev', 'prod'] },
    { key: 'reviewer', inputType: 'string', requirement: 'user_prompt' },
  ];

  test('resolves provided + defaults', () => {
    const r = resolveRecipeParams(defs, { repo: 'octipus', reviewer: 'alice' });
    expect(r).toEqual({ repo: 'octipus', count: '3', reviewer: 'alice' });
  });

  test('missing required ⇒ throws', () => {
    expect(() => resolveRecipeParams(defs, { reviewer: 'alice' })).toThrow(/missing required recipe parameter: repo/);
  });

  test('missing user_prompt ⇒ throws (caller must supply the answer)', () => {
    expect(() => resolveRecipeParams(defs, { repo: 'x' })).toThrow(/reviewer/);
  });

  test('unknown key ⇒ throws', () => {
    expect(() => resolveRecipeParams(defs, { repo: 'x', reviewer: 'a', bogus: 'y' })).toThrow(/unknown recipe parameter: bogus/);
  });

  test('number coercion validates', () => {
    expect(() => resolveRecipeParams(defs, { repo: 'x', reviewer: 'a', count: 'notnum' })).toThrow(/must be a number/);
  });

  test('select validates against options', () => {
    expect(() => resolveRecipeParams(defs, { repo: 'x', reviewer: 'a', env: 'staging' })).toThrow(/must be one of/);
    expect(resolveRecipeParams(defs, { repo: 'x', reviewer: 'a', env: 'prod' }).env).toBe('prod');
  });

  test('boolean coercion validates', () => {
    const bdefs: RecipeParameter[] = [{ key: 'flag', inputType: 'boolean', requirement: 'optional' }];
    expect(resolveRecipeParams(bdefs, { flag: 'true' }).flag).toBe('true');
    expect(() => resolveRecipeParams(bdefs, { flag: 'yes' })).toThrow(/true.*false/);
  });

  test('optional with no default + not provided ⇒ omitted', () => {
    const r = resolveRecipeParams(defs, { repo: 'x', reviewer: 'a' });
    expect('env' in r).toBe(false);
  });
});

describe('paramTemplateVars', () => {
  test('prefixes keys with param.', () => {
    expect(paramTemplateVars({ repo: 'octipus', count: '3' })).toEqual({ 'param.repo': 'octipus', 'param.count': '3' });
  });
});
