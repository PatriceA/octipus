import { parse } from 'acorn';

interface Syntax { type: string; start: number; end: number; [key: string]: unknown }
const node = (value: unknown): Syntax | undefined => value && typeof value === 'object' && 'type' in value ? value as Syntax : undefined;
const identifier = (value: unknown, name: string) => node(value)?.type === 'Identifier' && node(value)?.name === name;
const unawait = (value: unknown): Syntax | undefined => node(value)?.type === 'AwaitExpression' ? node(node(value)?.argument) : node(value);

/** Verify const mkdtemp ownership and its finally cleanup from syntax, never from quoted text. */
export function withoutOwnedTempCleanup(source: string): string {
  let root: Syntax;
  try { root = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as Syntax; }
  catch { return source; } // Unparseable code retains the conservative guard.
  const nodes: Syntax[] = [];
  const parents = new Map<Syntax, Syntax>();
  const visit = (n: Syntax, parent?: Syntax) => {
    nodes.push(n); if (parent) parents.set(n, parent);
    for (const value of Object.values(n)) for (const child of Array.isArray(value) ? value : [value]) {
      const parsed = node(child); if (parsed) visit(parsed, n);
    }
  };
  visit(root);
  const fsModules = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
  // This exemption is a proof for small built-in-only probes, not a JS sandbox.
  // Unknown code, indirect module access, mutation and shadowed bindings retain
  // the normal deletion approval: they could replace mkdtemp with an old path.
  const safeModules = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'os', 'node:os', 'path', 'node:path']);
  const safeFunctions = new Set(['mkdtemp', 'mkdtempSync', 'rm', 'rmSync', 'writeFile', 'writeFileSync',
    'readFile', 'readFileSync', 'mkdir', 'mkdirSync', 'stat', 'statSync', 'lstat', 'lstatSync',
    'readdir', 'readdirSync', 'existsSync', 'join', 'resolve', 'tmpdir']);
  const safeNamespaces = new Set<string>();
  const safeNamed = new Set<string>();
  const moduleCalls = new Set<Syntax>();
  const declarations = new Set<string>();
  const register = (id: unknown, named: boolean) => {
    const binding = node(id);
    if (binding?.type !== 'Identifier' || declarations.has(String(binding.name)) || binding.name === 'require') return false;
    declarations.add(String(binding.name));
    (named ? safeNamed : safeNamespaces).add(String(binding.name));
    return true;
  };
  for (const n of nodes) {
    if (['AssignmentExpression', 'UpdateExpression', 'FunctionDeclaration', 'FunctionExpression',
      'ArrowFunctionExpression', 'ClassDeclaration', 'ClassExpression', 'ImportExpression', 'NewExpression',
      'TaggedTemplateExpression', 'WithStatement'].includes(n.type) || n.type === 'UnaryExpression' && n.operator === 'delete') return source;
    if (n.type === 'ImportDeclaration') {
      if (!safeModules.has(String(node(n.source)?.value))) return source;
      for (const specifier of n.specifiers as Syntax[]) {
        const named = specifier.type === 'ImportSpecifier';
        if (named && !safeFunctions.has(String(node(specifier.imported)?.name))) return source;
        if (!register(specifier.local, named)) return source;
      }
    }
    if (n.type !== 'VariableDeclarator') continue;
    if (parents.get(n)?.kind !== 'const') return source;
    const init = node(n.init);
    if (init?.type === 'CallExpression' && identifier(init.callee, 'require')) {
      const args = init.arguments as unknown[];
      if (args.length !== 1 || !safeModules.has(String(node(args[0])?.value))) return source;
      moduleCalls.add(init);
      if (node(n.id)?.type === 'Identifier') {
        if (!register(n.id, false)) return source;
      } else if (node(n.id)?.type === 'ObjectPattern') {
        for (const property of node(n.id)?.properties as Syntax[]) {
          if (property.type !== 'Property' || property.computed || !safeFunctions.has(String(node(property.key)?.name))
            || !register(property.value, true)) return source;
        }
      } else return source;
    } else {
      const id = node(n.id);
      if (id?.type !== 'Identifier' || declarations.has(String(id.name)) || id.name === 'require') return source;
      declarations.add(String(id.name));
    }
  }
  for (const n of nodes) {
    if (n.type === 'Identifier' && n.name === 'require' && !(parents.get(n)?.type === 'CallExpression'
      && parents.get(n)?.callee === n && moduleCalls.has(parents.get(n)!))) return source;
    if (n.type !== 'CallExpression' || moduleCalls.has(n)) continue;
    const callee = node(n.callee);
    if (callee?.type === 'Identifier' && safeNamed.has(String(callee.name))) continue;
    if (callee?.type === 'MemberExpression' && !callee.computed && safeNamespaces.has(String(node(callee.object)?.name))
      && safeFunctions.has(String(node(callee.property)?.name))) continue;
    return source;
  }

  const namespaces = new Set<string>();
  const functions = new Map<string, string>();
  const bindingNodes = new Set<Syntax>();
  const add = (local: unknown, imported?: string) => {
    const id = node(local); if (id?.type !== 'Identifier') return;
    bindingNodes.add(id);
    if (imported) functions.set(String(id.name), imported); else namespaces.add(String(id.name));
  };
  for (const n of nodes) {
    if (n.type === 'ImportDeclaration' && fsModules.has(String(node(n.source)?.value))) {
      for (const specifier of n.specifiers as Syntax[]) {
        if (specifier.type === 'ImportSpecifier') {
          add(specifier.local, String(node(specifier.imported)?.name));
          const imported = node(specifier.imported); if (imported) bindingNodes.add(imported);
        } else add(specifier.local);
      }
    }
    if (n.type === 'VariableDeclarator' && parents.get(n)?.kind === 'const' && node(n.init)?.type === 'CallExpression'
      && identifier(node(n.init)?.callee, 'require') && fsModules.has(String(node((node(n.init)?.arguments as unknown[])?.[0])?.value))) {
      if (node(n.id)?.type === 'Identifier') add(n.id);
      if (node(n.id)?.type === 'ObjectPattern') for (const property of node(n.id)?.properties as Syntax[]) {
        if (property.type === 'Property' && !property.computed) {
          add(property.value, String(node(property.key)?.name));
          const key = node(property.key); if (key) bindingNodes.add(key);
        }
      }
    }
  }
  const member = (value: unknown, name: string) => {
    const n = node(value);
    return n?.type === 'MemberExpression' && !n.computed && namespaces.has(String(node(n.object)?.name)) && identifier(n.property, name);
  };
  const calls = (value: unknown, names: string[]) => {
    const n = unawait(value); if (n?.type !== 'CallExpression') return false;
    return names.some(name => member(n.callee, name) || node(n.callee)?.type === 'Identifier' && functions.get(String(node(n.callee)?.name)) === name);
  };
  // A copied/replaced namespace or function would invalidate the ownership proof.
  for (const n of nodes) {
    if (n.type !== 'Identifier' || bindingNodes.has(n)) continue;
    const parent = parents.get(n);
    if (namespaces.has(String(n.name)) && !(parent?.type === 'MemberExpression' && parent.object === n && !parent.computed
      && parents.get(parent)?.type === 'CallExpression' && parents.get(parent)?.callee === parent)) return source;
    if (functions.has(String(n.name)) && !(parent?.type === 'CallExpression' && parent.callee === n)) return source;
  }
  const scope = (value: Syntax): Syntax | undefined => {
    let parent = parents.get(value);
    while (parent && !['Program', 'BlockStatement'].includes(parent.type)) parent = parents.get(parent);
    return parent;
  };
  const ranges: Array<[number, number]> = [];
  for (const declaration of nodes.filter(n => n.type === 'VariableDeclarator' && parents.get(n)?.kind === 'const'
    && node(n.id)?.type === 'Identifier' && calls(n.init, ['mkdtempSync', 'mkdtemp']))) {
    const name = String(node(declaration.id)?.name);
    if (nodes.filter(n => n.type === 'VariableDeclarator' && identifier(n.id, name)).length !== 1) continue;
    for (const call of nodes.filter(n => n.type === 'CallExpression' && calls(n, ['rmSync', 'rm']))) {
      const args = call.arguments as unknown[];
      if (!identifier(args[0], name) || args.length !== 2 || node(args[1])?.type !== 'ObjectExpression') continue;
      const properties = node(args[1])?.properties as Syntax[];
      if (properties.length !== 2 || !['recursive', 'force'].every(key => properties.some(p => p.type === 'Property'
        && !p.computed && identifier(p.key, key) && node(p.value)?.value === true))) continue;
      const expression = parents.get(call)?.type === 'AwaitExpression' ? parents.get(call)! : call;
      const statement = parents.get(expression), block = statement && parents.get(statement), attempt = block && parents.get(block);
      if (statement?.type === 'ExpressionStatement' && block?.type === 'BlockStatement' && attempt?.type === 'TryStatement'
        && attempt.finalizer === block && scope(attempt) === scope(declaration) && declaration.end < call.start) ranges.push([call.start, call.end]);
    }
  }
  // Named imports are not destructive calls. Hide only cleanup bindings whose every use was proven above.
  for (const [name, imported] of functions) if (['rmSync', 'rm'].includes(imported)) {
    const uses = nodes.filter(n => identifier(n, name) && !bindingNodes.has(n));
    if (uses.length && uses.every(n => ranges.some(([start, end]) => start <= n.start && n.end <= end))) {
      for (const binding of bindingNodes) if (identifier(binding, name) || identifier(binding, imported)) ranges.push([binding.start, binding.end]);
    }
  }
  const unique = [...new Map(ranges.map(range => [range.join(':'), range])).values()];
  for (const [start, end] of unique.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + 'void 0' + source.slice(end);
  return source;
}
