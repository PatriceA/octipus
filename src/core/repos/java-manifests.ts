import type { RepoDependency } from '@db/schema/workspace-repos';
import { DOMParser, ParseError, type Document, type Element } from '@xmldom/xmldom';
import type { ParsedManifest } from './manifests';

const MAVEN_MANIFEST = 'pom.xml';
const MAVEN_MAX_BYTES = 1_000_000;
const PROPERTY_RESOLUTION_LIMIT = 10;
const PROPERTY_EXPANSION_LIMIT = 16_384;
const PROPERTY_WORK_LIMIT = 200_000;
const GRADLE_LIMIT_WARNING =
  'Static Gradle scan includes standard configurations with literal module dependencies only; custom configurations, version catalogs, project dependencies, applied scripts, and dynamic expressions are not evaluated.';

interface ResolutionBudget {
  remaining: number;
}

export interface GradleManifestOptions {
  /** settings.gradle(.kts), used only for a literal rootProject.name assignment. */
  settingsContent?: string;
  /** Directory name used when settings does not declare rootProject.name. */
  defaultProjectName?: string;
  /** gradle.properties, used for bounded literal `$property` interpolation. */
  gradleProperties?: string;
}

/** Parse the raw Maven project model without loading parents, profiles, or plugins. */
export function parseMavenPom(content: string): ParsedManifest | null {
  if (!content.trim() || Buffer.byteLength(content, 'utf8') > MAVEN_MAX_BYTES) return null;
  // xmldom does not fetch external resources, but rejecting declarations also
  // prevents internal entity expansion and makes that guarantee explicit.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(content)) return null;

  const errors: string[] = [];
  let document: Document;
  try {
    document = new DOMParser({
      onError: (_level, message) => { errors.push(message); },
    }).parseFromString(content, 'application/xml');
  } catch (error) {
    // xmldom 0.9 throws for malformed XML even when onError records it.
    if (error instanceof ParseError) return null;
    throw error;
  }
  if (errors.length || !document.documentElement || elementName(document.documentElement) !== 'project') return null;

  const project = document.documentElement;
  const parent = directChild(project, 'parent');
  const properties = new Map<string, string>();
  const propertiesElement = directChild(project, 'properties');
  if (propertiesElement) {
    for (const property of directChildren(propertiesElement)) {
      const value = elementText(property);
      if (value) properties.set(elementName(property), value);
    }
  }

  const rawParentGroup = directText(parent, 'groupId');
  const rawParentVersion = directText(parent, 'version');
  const rawGroup = directText(project, 'groupId') ?? rawParentGroup;
  const rawArtifact = directText(project, 'artifactId');
  const rawVersion = directText(project, 'version') ?? rawParentVersion;
  addMavenAliases(properties, {
    groupId: rawGroup,
    artifactId: rawArtifact,
    version: rawVersion,
    parentGroupId: rawParentGroup,
    parentVersion: rawParentVersion,
  });

  const warnings = new Set<string>();
  const resolutionBudget = { remaining: PROPERTY_WORK_LIMIT };
  if (parent) {
    warnings.add('Static Maven scan does not load the parent POM; inherited dependencies may be omitted.');
  }
  const profiles = directChild(project, 'profiles');
  if (profiles && hasDescendant(profiles, 'dependencies')) {
    warnings.add('Maven profile dependencies are omitted because profile activation is not evaluated.');
  }

  const group = resolveMavenValue(rawGroup, properties, resolutionBudget);
  const artifact = resolveMavenValue(rawArtifact, properties, resolutionBudget);
  if (group.unresolved || artifact.unresolved) {
    warnings.add('Some Maven properties could not be resolved statically.');
  }
  const packageName = usableCoordinate(group.value) && usableCoordinate(artifact.value)
    ? `${group.value}:${artifact.value}`
    : undefined;

  const dependencies: RepoDependency[] = [];
  const seen = new Set<string>();
  const dependencyContainer = directChild(project, 'dependencies');
  if (dependencyContainer) {
    for (const dependency of directChildren(dependencyContainer, 'dependency')) {
      const depGroup = resolveMavenValue(directText(dependency, 'groupId'), properties, resolutionBudget);
      const depArtifact = resolveMavenValue(directText(dependency, 'artifactId'), properties, resolutionBudget);
      const depVersion = resolveMavenValue(directText(dependency, 'version'), properties, resolutionBudget);
      if (depGroup.unresolved || depArtifact.unresolved || depVersion.unresolved) {
        warnings.add('Some Maven properties could not be resolved statically.');
      }
      if (!usableCoordinate(depGroup.value) || !usableCoordinate(depArtifact.value)) continue;
      const name = `${depGroup.value}:${depArtifact.value}`;
      if (seen.has(name)) continue;
      seen.add(name);
      dependencies.push({
        name,
        version: depVersion.unresolved ? '*' : depVersion.value || '*',
        manifest: MAVEN_MANIFEST,
      });
    }
  }

  return {
    manifest: MAVEN_MANIFEST,
    packageName,
    language: 'java',
    dependencies,
    ...(warnings.size ? { warnings: [...warnings] } : {}),
  };
}

interface MavenAliases {
  groupId?: string;
  artifactId?: string;
  version?: string;
  parentGroupId?: string;
  parentVersion?: string;
}

function addMavenAliases(properties: Map<string, string>, aliases: MavenAliases): void {
  const builtIns: Array<[string, string | undefined]> = [
    ['groupId', aliases.groupId],
    ['artifactId', aliases.artifactId],
    ['version', aliases.version],
    ['project.groupId', aliases.groupId],
    ['pom.groupId', aliases.groupId],
    ['project.artifactId', aliases.artifactId],
    ['pom.artifactId', aliases.artifactId],
    ['project.version', aliases.version],
    ['pom.version', aliases.version],
    ['parent.groupId', aliases.parentGroupId],
    ['project.parent.groupId', aliases.parentGroupId],
    ['pom.parent.groupId', aliases.parentGroupId],
    ['parent.version', aliases.parentVersion],
    ['project.parent.version', aliases.parentVersion],
    ['pom.parent.version', aliases.parentVersion],
  ];
  for (const [name, value] of builtIns) {
    if (value) properties.set(name, value);
  }
}

interface ResolvedValue {
  value?: string;
  unresolved: boolean;
}

function resolveMavenValue(
  raw: string | undefined,
  properties: Map<string, string>,
  budget: ResolutionBudget,
  depth = 0,
  resolving = new Set<string>(),
): ResolvedValue {
  if (!raw) return { unresolved: false };
  if (depth >= PROPERTY_RESOLUTION_LIMIT) return { unresolved: true };
  const pattern = /\$\{([^}]+)\}/g;
  let cursor = 0;
  let value = '';
  let unresolved = false;
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    const literal = raw.slice(cursor, match.index);
    if (!appendWithinBudget(literal, value, budget)) return { unresolved: true };
    value += literal;
    const propertyName = match[1].trim();
    const replacement = properties.get(propertyName);
    if (!replacement || resolving.has(propertyName)) {
      unresolved = true;
      if (!appendWithinBudget(match[0], value, budget)) return { unresolved: true };
      value += match[0];
      cursor = pattern.lastIndex;
      continue;
    }
    const nextResolving = new Set(resolving).add(propertyName);
    const resolved = resolveMavenValue(replacement, properties, budget, depth + 1, nextResolving);
    unresolved ||= resolved.unresolved;
    const resolvedValue = resolved.value ?? match[0];
    if (!appendWithinBudget(resolvedValue, value, budget)) return { unresolved: true };
    value += resolvedValue;
    cursor = pattern.lastIndex;
  }
  const tail = raw.slice(cursor);
  if (!appendWithinBudget(tail, value, budget)) return { unresolved: true };
  value = `${value}${tail}`.trim();
  unresolved ||= /\$\{[^}]+\}/.test(value);
  return { value: value || undefined, unresolved };
}

function appendWithinBudget(part: string, current: string, budget: ResolutionBudget): boolean {
  if (part.length > budget.remaining || current.length + part.length > PROPERTY_EXPANSION_LIMIT) {
    budget.remaining = Math.max(0, budget.remaining - part.length);
    return false;
  }
  budget.remaining -= part.length;
  return true;
}

function usableCoordinate(value: string | undefined): value is string {
  return Boolean(value && !/[${}\s:]/.test(value));
}

/** Parse static dependency declarations from a Gradle Groovy or Kotlin build script. */
export function parseGradleBuild(
  filename: 'build.gradle' | 'build.gradle.kts',
  content: string,
  options: GradleManifestOptions = {},
): ParsedManifest {
  const properties = parseGradleProperties(options.gradleProperties);
  const warnings = new Set<string>([GRADLE_LIMIT_WARNING]);
  const resolutionBudget = { remaining: PROPERTY_WORK_LIMIT };
  const settingsName = gradleSettingsProjectName(options.settingsContent ?? '');
  const projectName = settingsName.present
    ? settingsName.value
    : cleanValue(options.defaultProjectName);
  const group = parseGradleGroup(content, properties, resolutionBudget);
  const dependencies: RepoDependency[] = [];
  const seen = new Set<string>();

  for (const block of topLevelBlocks(content, 'dependencies')) {
    for (const statement of topLevelStatements(block)) {
      const parsed = parseGradleDependencyStatement(statement, properties, resolutionBudget);
      if (parsed === 'dynamic') continue;
      if (!parsed || seen.has(parsed.name)) continue;
      seen.add(parsed.name);
      dependencies.push({ ...parsed, manifest: filename });
    }
  }

  return {
    manifest: filename,
    packageName: usableGradlePart(group) && usableGradlePart(projectName) ? `${group}:${projectName}` : undefined,
    language: 'java',
    dependencies,
    warnings: [...warnings],
  };
}

/** Extract a literal root project name without evaluating the settings script. */
export function parseGradleSettingsProjectName(content: string): string | undefined {
  return gradleSettingsProjectName(content).value;
}

interface StaticAssignment {
  present: boolean;
  value?: string;
}

function gradleSettingsProjectName(content: string): StaticAssignment {
  let result: StaticAssignment = { present: false };
  for (const statement of topLevelStatements(content)) {
    const trimmed = stripGradleComments(statement).trim();
    if (!/^rootProject\.name\s*=/.test(trimmed)) continue;
    result = { present: true };
    const match = trimmed.match(/^rootProject\.name\s*=\s*(['"])(.*?)\1\s*$/s);
    if (match && !match[2].includes('$')) result.value = cleanValue(match[2]);
  }
  return result;
}

function parseGradleGroup(
  content: string,
  properties: Map<string, string>,
  budget: ResolutionBudget,
): string | undefined {
  let assignment: StaticAssignment = { present: false };
  for (const statement of topLevelStatements(content)) {
    const trimmed = stripGradleComments(statement).trim();
    if (!/^group\s*=/.test(trimmed)) continue;
    assignment = { present: true };
    const match = trimmed.match(/^group\s*=\s*(['"])(.*?)\1\s*$/s);
    if (match) assignment.value = resolveGradleValue(match[2], properties, budget);
  }
  return assignment.present ? assignment.value : resolveGradleValue(properties.get('group'), properties, budget);
}

function parseGradleProperties(content: string | undefined): Map<string, string> {
  const properties = new Map<string, string>();
  if (!content) return properties;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const match = line.match(/^([^:=\s]+)(?:\s*(?:=|:)\s*|\s+)(.*)$/);
    if (match) properties.set(match[1].trim(), match[2].trim());
  }
  return properties;
}

function resolveGradleValue(
  raw: string | undefined,
  properties: Map<string, string>,
  budget: ResolutionBudget,
  depth = 0,
  resolving = new Set<string>(),
): string | undefined {
  if (!raw) return undefined;
  if (depth >= PROPERTY_RESOLUTION_LIMIT) return undefined;
  const pattern = /\$\{([A-Za-z_][\w.]*)\}|\$([A-Za-z_][\w.]*)/g;
  let cursor = 0;
  let value = '';
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    const literal = raw.slice(cursor, match.index);
    if (!appendWithinBudget(literal, value, budget)) return undefined;
    value += literal;
    const propertyName = match[1] || match[2];
    const replacement = properties.get(propertyName);
    if (replacement === undefined || resolving.has(propertyName)) return undefined;
    const resolved = resolveGradleValue(
      replacement,
      properties,
      budget,
      depth + 1,
      new Set(resolving).add(propertyName),
    );
    if (resolved === undefined || !appendWithinBudget(resolved, value, budget)) return undefined;
    value += resolved;
    cursor = pattern.lastIndex;
  }
  const tail = raw.slice(cursor);
  if (!appendWithinBudget(tail, value, budget)) return undefined;
  return cleanValue(`${value}${tail}`);
}

type GradleDependency = Omit<RepoDependency, 'manifest'>;

function parseGradleDependencyStatement(
  rawStatement: string,
  properties: Map<string, string>,
  budget: ResolutionBudget,
): GradleDependency | 'dynamic' | null {
  const statement = stripGradleComments(rawStatement).trim();
  if (!statement || statement.startsWith('constraints')) return null;
  const call = statement.match(/^([A-Za-z_][\w]*)\s*([\s\S]+)$/);
  if (!call) return null;
  const expression = stripGradleDependencyClosure(call[2].trim());
  if (!isKnownGradleConfiguration(call[1]) || !expression) return expression ? 'dynamic' : null;

  const platformNotation = expression.match(
    /^(?:\(\s*)?(?:platform|enforcedPlatform)\s*\(\s*(['"])(.*?)\1\s*\)\s*\)?$/s,
  );
  if (platformNotation) return gradleCoordinate(platformNotation[2], properties, budget);
  const stringNotation = expression.match(/^(?:\(\s*)?(['"])(.*?)\1\s*\)?$/s);
  if (stringNotation) return gradleCoordinate(stringNotation[2], properties, budget);

  const group = namedGradleArgument(expression, 'group');
  const name = namedGradleArgument(expression, 'name');
  if (group && name && onlyNamedGradleArguments(expression)) {
    const resolvedGroup = resolveGradleValue(group, properties, budget);
    const resolvedName = resolveGradleValue(name, properties, budget);
    if (!usableGradlePart(resolvedGroup) || !usableGradlePart(resolvedName)) return 'dynamic';
    const version = resolveGradleValue(namedGradleArgument(expression, 'version'), properties, budget) ?? '*';
    return { name: `${resolvedGroup}:${resolvedName}`, version };
  }

  return expression ? 'dynamic' : null;
}

function namedGradleArgument(expression: string, name: string): string | undefined {
  const match = expression.match(new RegExp(`(?:^|[,\\s(])${name}\\s*(?::|=)\\s*(['"])(.*?)\\1`, 's'));
  return match?.[2];
}

function onlyNamedGradleArguments(expression: string): boolean {
  const withoutArguments = expression.replace(
    /(?:group|name|version)\s*(?::|=)\s*(['"])(.*?)\1/gs,
    '',
  );
  return !withoutArguments.replace(/[(),\s]/g, '');
}

function isKnownGradleConfiguration(name: string): boolean {
  return /^(?:api|implementation|compileOnly|runtimeOnly|annotationProcessor|compile|runtime|testCompile|testRuntime|classpath|developmentOnly|testAndDevelopmentOnly|kapt(?:Test|AndroidTest|Debug|Release)?|ksp(?:Test|AndroidTest|Debug|Release)?|coreLibraryDesugaring|lintChecks|[A-Za-z][\w]*(?:Api|Implementation|CompileOnly|RuntimeOnly|AnnotationProcessor|Kapt|Ksp))$/.test(name);
}

function stripGradleDependencyClosure(expression: string): string {
  const mask = structuralMask(expression);
  let parentheses = 0;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] === '(') parentheses++;
    else if (mask[index] === ')') parentheses = Math.max(0, parentheses - 1);
    else if (mask[index] === '{' && parentheses === 0) {
      const close = matchingBrace(mask, index);
      if (close !== -1 && !mask.slice(close + 1).trim()) return expression.slice(0, index).trim();
    }
  }
  return expression;
}

function gradleCoordinate(
  raw: string,
  properties: Map<string, string>,
  budget: ResolutionBudget,
): GradleDependency | 'dynamic' {
  const fullyResolved = resolveGradleValue(raw, properties, budget);
  const parts = (fullyResolved ?? raw).split(':');
  if (parts.length < 2) return 'dynamic';
  const group = resolveGradleValue(parts[0], properties, budget);
  const artifact = resolveGradleValue(parts[1], properties, budget);
  if (!usableGradlePart(group) || !usableGradlePart(artifact)) return 'dynamic';
  const rawVersion = parts.slice(2).join(':');
  const version = resolveGradleValue(rawVersion, properties, budget) ?? '*';
  return { name: `${group}:${artifact}`, version };
}

function usableGradlePart(value: string | undefined): value is string {
  return Boolean(value && !/[\s:]/.test(value));
}

function cleanValue(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

/** Return the bodies of named brace blocks declared at script top level. */
function topLevelBlocks(content: string, blockName: string): string[] {
  const mask = structuralMask(content);
  const controlBodyStarts = unbracedControlBodyStarts(content);
  const blocks: string[] = [];
  let depth = 0;
  let parentheses = 0;
  let statementStart = 0;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] === '{') {
      depth++;
      continue;
    }
    if (mask[index] === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (mask[index] === '(') {
      parentheses++;
      continue;
    }
    if (mask[index] === ')') {
      parentheses = Math.max(0, parentheses - 1);
      continue;
    }
    if (depth === 0 && parentheses === 0 && (mask[index] === '\n' || mask[index] === ';')) {
      statementStart = index + 1;
      continue;
    }
    if (depth !== 0 || parentheses !== 0 || !mask.startsWith(blockName, index)) continue;
    const before = index === 0 ? '' : mask[index - 1];
    const afterName = mask[index + blockName.length] ?? '';
    if (/\w/.test(before) || /\w/.test(afterName)) continue;
    let previous = index - 1;
    while (previous >= 0 && /\s/.test(mask[previous])) previous--;
    if (mask[previous] === '.') continue;
    if (mask.slice(statementStart, index).trim()) continue;
    if (controlBodyStarts.has(statementStart)) continue;
    let open = index + blockName.length;
    while (/\s/.test(mask[open] ?? '')) open++;
    if (mask[open] !== '{') continue;
    const close = matchingBrace(mask, open);
    if (close === -1) continue;
    blocks.push(content.slice(open + 1, close));
    index = close;
  }
  return blocks;
}

function unbracedControlBodyStarts(content: string): Set<number> {
  const starts = new Set<number>();
  let previous = '';
  for (const range of topLevelStatementRanges(content)) {
    const statement = stripGradleComments(content.slice(range.start, range.end)).trim();
    if (!statement) continue;
    if (/^(?:(?:if|for|while|when)\s*\([\s\S]*\)|else|do)\s*$/.test(previous)) {
      starts.add(range.start);
    }
    previous = statement;
  }
  return starts;
}

function matchingBrace(mask: string, open: number): number {
  let depth = 0;
  for (let index = open; index < mask.length; index++) {
    if (mask[index] === '{') depth++;
    else if (mask[index] === '}' && --depth === 0) return index;
  }
  return -1;
}

/** Split script text at top-level newlines/semicolons, preserving nested calls/closures. */
function topLevelStatements(content: string): string[] {
  return topLevelStatementRanges(content).map(range => content.slice(range.start, range.end));
}

interface TextRange {
  start: number;
  end: number;
}

function topLevelStatementRanges(content: string): TextRange[] {
  const mask = structuralMask(content);
  const statements: TextRange[] = [];
  let start = 0;
  let braces = 0;
  let parentheses = 0;
  for (let index = 0; index < mask.length; index++) {
    const char = mask[index];
    if (char === '{') braces++;
    else if (char === '}') braces = Math.max(0, braces - 1);
    else if (char === '(') parentheses++;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    if ((char === '\n' || char === ';') && braces === 0 && parentheses === 0) {
      statements.push({ start, end: index });
      start = index + 1;
    }
  }
  statements.push({ start, end: content.length });
  return statements;
}

/** Mask strings and comments while retaining offsets and structural characters. */
function structuralMask(content: string): string {
  return lexGradle(content, true);
}

function stripGradleComments(content: string): string {
  return lexGradle(content, false);
}

function lexGradle(content: string, maskStrings: boolean): string {
  // split('') keeps UTF-16 code-unit offsets aligned with String.slice().
  const chars = content.split('');
  const out = content.split('');
  let index = 0;
  while (index < chars.length) {
    if (chars[index] === '/' && chars[index + 1] === '/') {
      while (index < chars.length && chars[index] !== '\n') out[index++] = ' ';
      continue;
    }
    if (chars[index] === '/' && chars[index + 1] === '*') {
      out[index++] = ' ';
      out[index++] = ' ';
      while (index < chars.length && !(chars[index] === '*' && chars[index + 1] === '/')) {
        if (chars[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < chars.length) {
        out[index++] = ' ';
        out[index++] = ' ';
      }
      continue;
    }
    const quote = chars[index];
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      index++;
      continue;
    }
    const triple = chars[index + 1] === quote && chars[index + 2] === quote;
    const width = triple ? 3 : 1;
    if (maskStrings) {
      for (let offset = 0; offset < width; offset++) out[index + offset] = ' ';
    }
    index += width;
    while (index < chars.length) {
      if (!triple && chars[index] === '\\') {
        if (maskStrings) out[index] = ' ';
        index++;
        if (index < chars.length) {
          if (maskStrings) out[index] = ' ';
          index++;
        }
        continue;
      }
      const closes = triple
        ? chars[index] === quote && chars[index + 1] === quote && chars[index + 2] === quote
        : chars[index] === quote;
      if (closes) {
        if (maskStrings) {
          for (let offset = 0; offset < width; offset++) out[index + offset] = ' ';
        }
        index += width;
        break;
      }
      if (maskStrings) out[index] = ' ';
      index++;
    }
  }
  return out.join('');
}

function directChild(parent: Element | null, name: string): Element | null {
  if (!parent) return null;
  for (const child of directChildren(parent)) {
    if (elementName(child) === name) return child;
  }
  return null;
}

function directChildren(parent: Element, name?: string): Element[] {
  const children: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (!name || elementName(element) === name) children.push(element);
  }
  return children;
}

function directText(parent: Element | null, name: string): string | undefined {
  const child = directChild(parent, name);
  return child ? elementText(child) : undefined;
}

function elementText(element: Element): string | undefined {
  return cleanValue(element.textContent ?? undefined);
}

function elementName(element: Element): string {
  return element.localName || element.nodeName.split(':').pop() || element.nodeName;
}

function hasDescendant(parent: Element, name: string): boolean {
  for (const child of directChildren(parent)) {
    if (elementName(child) === name || hasDescendant(child, name)) return true;
  }
  return false;
}
