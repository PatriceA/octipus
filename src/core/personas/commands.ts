import { getPersonaProfileRepository } from './repository';
import { getPersonaRegistry } from './registry';
import { resolvePersonaForUser } from './resolver';
import { PersonaNarration, PersonaTone } from './types';

/**
 * Handle `/persona [subcommand] [args...]` from the gateway command
 * registry. Returns plain text shown to the user.
 *
 * Subcommands:
 *   /persona                          → show current persona
 *   /persona name <X>                 → rename to X
 *   /persona tone <tone>              → set tone
 *   /persona narration <off|min|chat> → set narration volume
 *   /persona say <fact>               → append a free-form self-fact
 *   /persona reset                    → restore Octipus default
 *   /persona personas                 → list available preset YAMLs
 *   /persona use <preset_id>          → switch to a different preset
 */

export interface PersonaCommandCtx {
  userId: string;
  /** The entire arg string after `/persona ` — preserves spaces. */
  rawArgs: string;
}

export interface PersonaCommandResult {
  text: string;
}

async function ensureProfile(userId: string): Promise<{ id: string; name: string }> {
  const repo = getPersonaProfileRepository();
  const existing = await repo.findForUser(userId);
  if (existing) return { id: existing.id, name: existing.name };
  await getPersonaRegistry().ensureLoaded();
  const base = getPersonaRegistry().getDefault();
  const created = await repo.create(userId, base.name, {
    presetId: base.id,
    pronouns: base.pronouns,
    tone: base.tone,
    narration: base.defaults.narration,
    extras: [],
  });
  return { id: created.id, name: created.name };
}

export async function handlePersonaCommand(ctx: PersonaCommandCtx): Promise<PersonaCommandResult> {
  const args = ctx.rawArgs.trim();
  if (!args || args === 'show') {
    return showPersona(ctx.userId);
  }

  const [sub] = args.split(/\s+/);
  const subRaw = args.slice(sub.length).trim();

  switch (sub.toLowerCase()) {
    case 'name':
      return renamePersona(ctx.userId, subRaw);
    case 'tone':
      return setTone(ctx.userId, subRaw);
    case 'narration':
      return setNarration(ctx.userId, subRaw);
    case 'say':
      return addFact(ctx.userId, subRaw);
    case 'reset':
      return resetPersona(ctx.userId);
    case 'personas':
    case 'list':
      return listPresets();
    case 'use':
      return usePreset(ctx.userId, subRaw);
    default:
      return {
        text:
          `Unknown persona subcommand: \`${sub}\`. Available:\n` +
          '  `/persona`                — show current persona\n' +
          '  `/persona name <X>`       — rename\n' +
          '  `/persona tone <tone>`    — set tone (dry|playful|neutral|professional|terse|verbose)\n' +
          '  `/persona narration <X>`  — off | minimal | chatty\n' +
          '  `/persona say <fact>`     — add a self-fact\n' +
          '  `/persona reset`          — restore Octipus default\n' +
          '  `/persona personas`       — list available presets\n' +
          '  `/persona use <preset>`   — switch to a different preset',
      };
  }
}

async function showPersona(userId: string): Promise<PersonaCommandResult> {
  await ensureProfile(userId);
  const persona = await resolvePersonaForUser(userId);
  const lines = [
    `**Active persona**: ${persona.name} (${persona.presetId})`,
    `Tone: ${persona.tone}   Narration: ${persona.narration}   Pronouns: ${persona.pronouns}`,
  ];
  if (persona.userFacts.length > 0) {
    lines.push('', 'Self-facts you added:');
    for (const f of persona.userFacts) lines.push(`  • ${f}`);
  }
  return { text: lines.join('\n') };
}

async function renamePersona(userId: string, name: string): Promise<PersonaCommandResult> {
  const clean = name.trim().replace(/^["']|["']$/g, '');
  if (!clean) return { text: 'Provide a new name. Example: `/persona name Adam`' };
  if (clean.length > 40) return { text: 'Name too long (max 40 chars).' };
  const profile = await ensureProfile(userId);
  const updated = await getPersonaProfileRepository().updateName(profile.id, clean);
  if (!updated) return { text: 'Rename failed — profile vanished mid-call. Try again.' };
  return { text: `Renamed to **${clean}**. The arms remain unchanged. Continue.` };
}

async function setTone(userId: string, value: string): Promise<PersonaCommandResult> {
  const clean = value.trim().toLowerCase();
  const parsed = PersonaTone.safeParse(clean);
  if (!parsed.success) {
    return { text: `Unknown tone "${clean}". Valid: dry | playful | neutral | professional | terse | verbose.` };
  }
  const profile = await ensureProfile(userId);
  await getPersonaProfileRepository().upsertFact(profile.id, 'tone', parsed.data);
  return { text: `Tone set to **${parsed.data}**.` };
}

async function setNarration(userId: string, value: string): Promise<PersonaCommandResult> {
  const clean = value.trim().toLowerCase();
  // Accept "min" / "chat" shorthand.
  const expand = clean === 'min' ? 'minimal' : clean === 'chat' ? 'chatty' : clean;
  const parsed = PersonaNarration.safeParse(expand);
  if (!parsed.success) {
    return { text: `Unknown narration value "${clean}". Valid: off | minimal | chatty.` };
  }
  const profile = await ensureProfile(userId);
  await getPersonaProfileRepository().upsertFact(profile.id, 'narration', parsed.data);
  return { text: `Narration set to **${parsed.data}**.` };
}

async function addFact(userId: string, fact: string): Promise<PersonaCommandResult> {
  const clean = fact.trim();
  if (clean.length < 4) return { text: 'Provide a longer fact. Example: `/persona say always answer in bullets`' };
  if (clean.length > 280) return { text: 'Fact too long (max 280 chars). Split into multiple `/persona say` calls.' };
  const profile = await ensureProfile(userId);
  await getPersonaProfileRepository().addExtraFact(profile.id, clean);
  return { text: 'Noted. The fact has been added to the persona.' };
}

async function resetPersona(userId: string): Promise<PersonaCommandResult> {
  const profile = await ensureProfile(userId);
  await getPersonaProfileRepository().reset(profile.id);
  return { text: 'Persona reset to Octipus default. Tone: dry. Narration: minimal.' };
}

async function listPresets(): Promise<PersonaCommandResult> {
  await getPersonaRegistry().ensureLoaded();
  const presets = getPersonaRegistry().list();
  const lines = presets.map(p => `  • **${p.id}** — ${p.display_name} (tone: ${p.tone})${p.is_default ? '  _default_' : ''}`);
  return { text: `Available personas:\n${lines.join('\n')}` };
}

async function usePreset(userId: string, presetId: string): Promise<PersonaCommandResult> {
  const clean = presetId.trim();
  if (!clean) return { text: 'Provide a preset id. Example: `/persona use mentor`. Use `/persona personas` to list.' };
  await getPersonaRegistry().ensureLoaded();
  const preset = getPersonaRegistry().get(clean);
  if (!preset) return { text: `Preset "${clean}" not found. Use \`/persona personas\` to list.` };
  const profile = await ensureProfile(userId);
  // Switch preset + adopt its defaults. Keep user's current name unless
  // they explicitly reset; that way switching presets doesn't undo a rename.
  await getPersonaProfileRepository().upsertFact(profile.id, 'preset_id', preset.id);
  await getPersonaProfileRepository().upsertFact(profile.id, 'tone', preset.tone);
  await getPersonaProfileRepository().upsertFact(profile.id, 'pronouns', preset.pronouns);
  await getPersonaProfileRepository().upsertFact(profile.id, 'narration', preset.defaults.narration);
  return { text: `Switched to preset **${preset.id}** (${preset.display_name}).` };
}

