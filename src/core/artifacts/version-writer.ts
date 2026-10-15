/**
 * Writing an artifact version: the one path for the agent tool and the REST
 * API alike (create, edit, restore).
 *
 * The REST routes used to store the template as given. Its inline `<script>`
 * and `on*=` handlers then could not run under the embed CSP, an edit that
 * changed only the CSS dropped the previous bundle, and a restore pointed at
 * a bundle file that was never copied — the page silently lost its behaviour.
 *
 * Threat note: lifting scripts for REST callers lets them run nothing the
 * agent tool does not already run for them. Who may write is unchanged (the
 * workspace's artifact store, `write` in a space), and the bundle only ever
 * runs in the embed: an opaque origin, by the frames' `sandbox` and, since
 * the embed CSP header carries `sandbox allow-scripts`, wherever it is opened.
 */
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import type { ArtifactVersion } from '@/db/schema/artifact-versions';
import { buildAndStoreBundle, copyBundle } from './bundler';
import { publishArtifactVersionUpdated } from './events';
import { artifactLifecycleBus } from './lifecycle-bus';
import { extractInteractiveScript } from './render';

/** Does this template carry `data-octi-h` markers, i.e. bindings a bundle owns? */
function hasBoundHandlers(template: string): boolean {
  return /\sdata-octi-h\s*=/.test(template);
}

/**
 * Write a new version, lifting the template's own JS into a CSP-pinned bundle.
 *
 * Inline `<script>` and `on*=` handlers cannot run under the embed CSP, so
 * `extractInteractiveScript` moves them into one source string which is built
 * to `bundle.js` and served from the artifact's own origin. A build failure
 * (syntax error, disallowed import) is NOT fatal: the version still lands, the
 * page renders without behaviour, and the caller gets the compiler message —
 * losing the whole edit because one handler had a typo is worse.
 */
export async function writeVersion(opts: {
  artifactId: string;
  template: string;
  css: string;
  changeSummary: string;
  userId: string;
  /** Current version, whose bundle may need to follow the template forward. */
  previousVersionId?: string | null;
  /** False when `template` was defaulted from the stored version, not supplied. */
  templateProvided: boolean;
  /** Script to bundle after the template's own (a saved interactive answer's). */
  script?: string;
}): Promise<{ versionId: string; warnings: string[] }> {
  const extracted = extractInteractiveScript(opts.template);
  const warnings = [...extracted.warnings];
  const source = [extracted.source, opts.script ?? ''].filter((s) => s.trim()).join('\n;\n');

  const version = await artifactsRepository.createVersion({
    artifactId: opts.artifactId,
    htmlTemplate: extracted.template,
    css: opts.css,
    changeSummary: opts.changeSummary,
    createdByUserId: opts.userId,
  });
  await artifactsRepository.setCurrentVersion(opts.artifactId, version.id);

  if (source) {
    try {
      await buildAndStoreBundle({
        artifactId: opts.artifactId,
        versionId: version.id,
        source,
      });
    } catch (err) {
      warnings.push(
        `The page's JavaScript did not build, so it will render without behaviour: ${(err as Error).message}. Fix the script and save the page again.`,
      );
    }
  } else if (opts.previousVersionId && (!opts.templateProvided || hasBoundHandlers(extracted.template))) {
    // Nothing new to build, but the page still needs its behaviour. Two ways in:
    // the caller changed only the CSS, or it round-tripped the STORED template
    // (get_live_artifact → edit → update), which by then holds `data-octi-h`
    // markers and no `<script>` — so extraction finds nothing and, without this,
    // every handler on the page would go dead with no warning.
    await copyBundle(opts.artifactId, opts.previousVersionId, version.id);
  }

  return { versionId: version.id, warnings };
}

/**
 * A new current version holding an earlier one's template, CSS and bundle.
 * The bundle file is per version, so it is copied, not just referenced.
 */
export async function restoreVersion(opts: {
  artifactId: string;
  target: ArtifactVersion;
  userId: string;
}): Promise<{ versionId: string }> {
  const version = await artifactsRepository.createVersion({
    artifactId: opts.artifactId,
    htmlTemplate: opts.target.htmlTemplate,
    css: opts.target.css,
    jsBundleSha256: opts.target.jsBundleSha256,
    schemaJson: opts.target.schemaJson,
    changeSummary: `restore from ${opts.target.id}`,
    createdByUserId: opts.userId,
  });
  await artifactsRepository.setCurrentVersion(opts.artifactId, version.id);
  await copyBundle(opts.artifactId, opts.target.id, version.id);
  return { versionId: version.id };
}

/** Tell open viewers and listeners that the page changed. */
export function announceVersion(artifactId: string, versionId: string): void {
  publishArtifactVersionUpdated(artifactId, versionId);
  artifactLifecycleBus.emitEvent({ type: 'artifact:updated', artifactId, versionId });
}
