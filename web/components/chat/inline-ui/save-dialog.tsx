'use client';

/**
 * "Save as artifact" for an interactive answer (docs/plans/inline-ui-spec.md
 * §7): a title, a slug, private or for the workspace. The copy is static and
 * reaches no network; when the answer's script uses `octi`, the dialog says
 * those buttons will answer "not available here".
 */
import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { ARTIFACT_SLUG_RE, slugFromTitle } from '../../../../src/shared/artifacts';
import { usesOctiBridge } from '../../../../src/shared/inline-ui/bridge';
import type { InlineUiBlockData, SaveAsArtifactInput, SaveAsArtifactResult } from './context';

const inputClass = 'w-full px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface focus:outline-none focus:border-primary';

export function SaveAsArtifactDialog({ block, open, onClose, save }: {
  block: InlineUiBlockData;
  open: boolean;
  onClose: () => void;
  save: (input: SaveAsArtifactInput) => Promise<SaveAsArtifactResult>;
}) {
  const [title, setTitle] = useState(block.title);
  const [slug, setSlug] = useState(() => slugFromTitle(block.title));
  const [slugEdited, setSlugEdited] = useState(false);
  const [visibility, setVisibility] = useState<SaveAsArtifactInput['visibility']>('private');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SaveAsArtifactResult | null>(null);
  const bridge = block.scripts && usesOctiBridge(block.js);
  const slugOk = ARTIFACT_SLUG_RE.test(slug);

  const submit = async () => {
    if (!title.trim() || !slugOk || pending) return;
    setPending(true);
    setError(null);
    try {
      setSaved(await save({ title: title.trim(), slug, visibility }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Save as artifact">
      {saved ? (
        <div className="p-3 space-y-3 text-[12px]" data-testid="inline-ui-saved">
          <p className="text-on-surface">Saved as an artifact.</p>
          {saved.warnings.map((w) => <p key={w} role="status" className="px-2 py-1 border border-warning/40 bg-warning/10 rounded-xs text-warning">{w}</p>)}
          <div className="flex justify-end gap-2">
            <a href={saved.appUrl} className="px-2.5 py-1 rounded-xs bg-primary text-on-primary hover:bg-primary-dim">open it</a>
            <button type="button" onClick={onClose} className="px-2.5 py-1 rounded-xs border border-outline-variant/60 text-on-surface-variant hover:text-on-surface cursor-pointer">close</button>
          </div>
        </div>
      ) : (
        <form className="p-3 space-y-3 text-[12px]" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-testid="inline-ui-save-dialog">
          {error && <p role="alert" className="px-2 py-1 border border-error/40 bg-error/10 rounded-xs text-error">! {error}</p>}
          <p className="text-on-surface-variant">A static copy — no data refresh, and it reaches no network.</p>
          {bridge && (
            <p role="note" className="px-2 py-1 border border-warning/40 bg-warning/10 rounded-xs text-warning">
              Its buttons that send a message or open a link work only here in the chat; in the copy they say “not available here”.
            </p>
          )}
          <label className="block space-y-1">
            <span className="text-on-surface-variant">title</span>
            <input
              autoFocus
              value={title}
              maxLength={200}
              aria-label="Artifact title"
              className={inputClass}
              onChange={(e) => { setTitle(e.target.value); if (!slugEdited) setSlug(slugFromTitle(e.target.value)); }}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-on-surface-variant">slug</span>
            <input
              value={slug}
              maxLength={64}
              aria-label="Artifact slug"
              aria-invalid={!slugOk}
              className={inputClass}
              onChange={(e) => { setSlug(e.target.value); setSlugEdited(true); }}
            />
            {!slugOk && <span className="text-error">lowercase letters, digits and dashes</span>}
          </label>
          <fieldset className="space-y-1">
            <legend className="text-on-surface-variant">who can see it</legend>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="inline-ui-visibility" checked={visibility === 'private'} onChange={() => setVisibility('private')} />
              only me
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="inline-ui-visibility" checked={visibility === 'workspace'} onChange={() => setVisibility('workspace')} />
              everyone in this workspace
            </label>
          </fieldset>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-2.5 py-1 rounded-xs border border-outline-variant/60 text-on-surface-variant hover:text-on-surface cursor-pointer">cancel</button>
            <button type="submit" disabled={!title.trim() || !slugOk || pending} className="px-2.5 py-1 rounded-xs bg-primary text-on-primary hover:bg-primary-dim disabled:opacity-50 cursor-pointer">
              save
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
