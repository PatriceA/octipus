/**
 * `imagegen` (docs/MEDIA.md → Tools): draw images with the Image generation
 * lane. Offered only when a model is bound there (`requires: ['draw']`).
 * Images are saved in the workspace and shown to the person with the answer
 * (web chat, channels); the agent looks at one with vision__view_image.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { addTurnMedia } from '@/core/media/turn-media';
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import type { AgentContext, ToolManifest } from '@/core/types';
import { WorkspaceFS, WorkspaceFsError } from '@/security/workspace-fs';
import { BaseTool, createParameterSchema } from '../base-tool';

export const MAX_IMAGES = 4;
export const MAX_REFERENCES = 4;
export const MAX_PROMPT_CHARS = 4000;

function workspaceOf(context: AgentContext): WorkspaceFS {
  const fs = WorkspaceFS.forAgent(context);
  fs.ensureRootSync();
  return fs;
}

/** A path inside the workspace itself (not an extra allowed root), writable there. */
async function workspacePath(fs: WorkspaceFS, path: string): Promise<string> {
  let target: string;
  try {
    target = fs.resolve(path);
    fs.assertWritable(target);
  } catch (err) {
    if (err instanceof WorkspaceFsError) throw new ToolNotExecutedError('imagegen', err.code === 'AGENT_CONFIG' ? err.message : `Path '${path}' is outside allowed workspace directories`);
    throw err;
  }
  const { realpathSync } = await import('node:fs');
  const { isInside } = await import('@/security/workspace-fs');
  let root = fs.root;
  try { root = realpathSync(fs.root); } catch { /* not created yet */ }
  if (!isInside(root, target) && !isInside(fs.root, target)) throw new ToolNotExecutedError('imagegen', `Path '${path}' is outside allowed workspace directories`);
  return target;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export class ImageGenTool extends BaseTool {
  readonly id = 'imagegen';
  readonly name = 'Image generation';
  readonly version = '1.0.0';
  readonly description = 'Create images from a description, or edit images with one.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [{ action: 'generate', description: 'Create an image', defaultLevel: 'ALLOW' }],
      tools: [{
        name: 'generate_image',
        description: 'Create images from a prompt (saved in the workspace and shown to the person).',
        parameters: {
          prompt: { type: 'string', description: 'What to draw', required: true },
          aspect_ratio: { type: 'string', description: 'square | landscape | portrait' },
          n: { type: 'number', description: 'How many (1–4)' },
          reference_images: { type: 'array', description: 'Workspace images to edit or follow (models that take references)' },
          output_path: { type: 'string', description: 'Workspace path for the (first) image' },
        },
        returns: '{ images: [{ path, mimeType, width, height }], model, revisedPrompt? }',
      }],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'generate_image',
      'Create images from a prompt with the Image generation model. Put any text that must appear in the image in quotes in the prompt. The images are saved in the workspace and shown to the person with your answer; to check one yourself, call vision__view_image with its path. `reference_images` (workspace paths) edits or follows given images, on models that take them.',
      createParameterSchema({
        prompt: { type: 'string', description: `What to draw (at most ${MAX_PROMPT_CHARS} characters)`, required: true },
        aspect_ratio: { type: 'string', description: 'Shape of the image', enum: ['square', 'landscape', 'portrait'], default: 'square' },
        n: { type: 'number', description: `How many images (1–${MAX_IMAGES})`, default: 1 },
        reference_images: { type: 'array', description: 'Workspace paths of images to edit or follow', items: { type: 'string' } },
        output_path: { type: 'string', description: 'Workspace path for the image (a new file); default .octipus/media/generated/<id>.png' },
      }),
      async (args, context) => this.generate(args, context),
      { requiresPermission: true, permissionAction: 'generate', requires: ['draw'] },
    );
  }

  private async generate(args: Record<string, unknown>, context: AgentContext): Promise<unknown> {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) throw new ToolNotExecutedError(this.id, 'prompt is required');
    if (prompt.length > MAX_PROMPT_CHARS) throw new ToolNotExecutedError(this.id, `prompt is ${prompt.length} characters; at most ${MAX_PROMPT_CHARS}.`);
    const aspect = args.aspect_ratio === 'landscape' || args.aspect_ratio === 'portrait' ? args.aspect_ratio : 'square';
    const n = Math.min(MAX_IMAGES, Math.max(1, Math.floor(Number(args.n) || 1)));
    const fs = workspaceOf(context);

    // Everything that can be refused is refused before anything is paid for.
    const requested = typeof args.output_path === 'string' && args.output_path.trim() ? args.output_path.trim() : null;
    const requestedTarget = requested ? await workspacePath(fs, requested) : null;
    if (requestedTarget && await stat(requestedTarget).catch(() => null)) throw new ToolNotExecutedError(this.id, `'${requested}' already exists; generate_image writes new files only.`);
    const refPaths = Array.isArray(args.reference_images) ? (args.reference_images as unknown[]).map(String).filter(Boolean) : [];
    if (refPaths.length > MAX_REFERENCES) throw new ToolNotExecutedError(this.id, `At most ${MAX_REFERENCES} reference images.`);
    const { imageGenerationTakesReferences, generateImageWithLane } = await import('@/models/image-generation');
    if (refPaths.length && !(await imageGenerationTakesReferences())) {
      throw new ToolNotExecutedError(this.id, 'The bound image model does not take reference images; describe the image instead.');
    }
    const { sniffImageType, MAX_SOURCE_IMAGE_BYTES } = await import('@/core/media/normalize');
    const references: Array<{ data: Buffer; mimeType: string }> = [];
    for (const ref of refPaths) {
      let abs: string;
      try { abs = fs.resolve(ref); } catch { throw new ToolNotExecutedError(this.id, `Path '${ref}' is outside allowed workspace directories`); }
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile()) throw new ToolNotExecutedError(this.id, `No image at '${ref}'.`);
      if (info.size > MAX_SOURCE_IMAGE_BYTES) throw new ToolNotExecutedError(this.id, `'${ref}' is too large.`);
      const data = await readFile(abs);
      const mimeType = sniffImageType(data);
      if (!mimeType) throw new ToolNotExecutedError(this.id, `'${ref}' is not an image.`);
      references.push({ data, mimeType });
    }

    const result = await generateImageWithLane(prompt, { n, aspect, references }, {
      userId: context.userId, sessionId: context.sessionId, agentId: context.id,
      workspaceId: context.workspaceId ?? null, funding: context.funding,
    });

    const { default: sharp } = await import('sharp');
    const images: Array<{ path: string; mimeType: string; width?: number; height?: number }> = [];
    for (const [index, image] of result.images.entries()) {
      const ext = EXT[image.mimeType] ?? 'png';
      let rel: string;
      let target: string;
      if (index === 0 && requested && requestedTarget) {
        rel = requested;
        target = requestedTarget;
      } else {
        rel = requested
          ? join(dirname(requested), `${requested.slice(dirname(requested).length + 1).replace(extname(requested), '')}-${index + 1}.${ext}`)
          : `.octipus/media/generated/${randomUUID()}.${ext}`;
        target = await workspacePath(fs, rel);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, image.data, { flag: 'wx', mode: 0o600 });
      const meta = await sharp(image.data).metadata().catch(() => ({ width: undefined, height: undefined }));
      images.push({ path: rel, mimeType: image.mimeType, width: meta.width, height: meta.height });
      addTurnMedia({ kind: 'image', path: target, mimeType: image.mimeType, deliver: 'attach', filename: rel.split('/').pop() });
    }
    return {
      images,
      model: result.model,
      ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
      note: 'Saved and shown to the person with your answer. To check an image yourself, call vision__view_image with its path.',
    };
  }
}

export const imageGenTool = new ImageGenTool();
