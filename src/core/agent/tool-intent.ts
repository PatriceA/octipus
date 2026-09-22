/**
 * Which of a role's core tool groups this turn actually advertises.
 *
 * Lazy tool discovery already splits a role's tools into an advertised core and
 * a long tail reachable through `list_tools`/`describe_tool`. The split was per
 * ROLE — one hand-maintained list per role, identical on every turn — so a
 * dev-mode turn that only ever touches files and a shell still paid for the
 * user's notes, to-do list, knowledge base, chat channels, repo registry and
 * web search on every single call. Measured on the arena's model: those six
 * groups are 6,377 tokens by the chars/4 heuristic and nearer 8.5k as the
 * provider counts them, against 1,791 for the three a coding turn uses.
 *
 * So the core set becomes a property of the MESSAGE, the way odysseus picks its
 * sixteen tools per request instead of fifty-seven per role. Two rules keep the
 * failure mode survivable:
 *
 *  - It can only SHRINK a role's own core list. Nothing new is ever granted, so
 *    this cannot widen what an agent may reach; the role's `toolIds` remains the
 *    permission boundary and every dropped group stays registered and callable.
 *  - It FAILS OPEN. A group with no entry in the table below is always kept, so
 *    adding a tool group cannot silently lose it — only a group we have
 *    deliberately given triggers can be dropped, and only when the message says
 *    nothing about it.
 *
 * What is dropped is still named in the role prompt's TOOLS section and still
 * listed by `list_tools`, which ranks semantically. That prose index is the
 * reason this is safe: the model is told the tool exists even on a turn where
 * its schema is not shipped.
 */

/**
 * Groups every turn keeps, whatever the message says.
 *
 * `filesystem` and `shell` because the root is what answers "run this command"
 * and "read that file", and a capability the user names directly must not
 * depend on the model choosing to go looking for it — measured: with `shell` in
 * the tail the model asserted the tool did not exist and stopped. `skill-distill`
 * for the same reason, measured the same way, and it is 172 tokens.
 */
export const CORE_TOOL_FLOOR: readonly string[] = ['filesystem', 'shell', 'skill-distill'];

/**
 * A group is dropped when it has an entry here and the message does not match
 * it. A false keep costs tokens on every call; a false drop costs ONE discovery
 * round trip, and that path is real — measured: "write down that the deploy is
 * on Friday" and "remind me to renew the domain next week" both reached their
 * toolbox through `list_tools` on a turn where it was not advertised. So the
 * patterns are phrases, not bare nouns: `task` and `note` are ordinary words,
 * and the worker path matches against a task BRIEF, which contains the word
 * "task" nearly every time.
 *
 * Only the expensive groups have entries. Everything else fails open.
 */
const INTENT: Record<string, RegExp> = {
  websearch: /\b(search|google|web|online|internet|latest|news|look\s*up|lookup|browse|url|https?:)\b/i,
  knowledge: /\b(knowledge|kb|rag|embedding|prior\s+work|what\s+do\s+we\s+know|documentation|docs)\b/i,
  // Not a bare `note`: "note that", "worth noting" and "please note" are
  // ordinary English and would keep this group on most messages. The phrases
  // that mean the user's notes are the ones listed, plus the two ways a request
  // asks for one without the word ("write down", "don't forget").
  notes: /\b(my\s+notes?|a\s+note|the\s+note|notes?\s+(app|tab|file)|note\s+(it|this|that)?\s*down|write\s+(it|this|that)?\s*down|jot|memo|wiki|do\s*n[o']?t\s+forget)\b|\[\[/i,
  // Not a bare `task`: the worker path passes the child's task BRIEF through
  // here, and a brief says "your task is to…" almost every time — the word
  // would pin this group to every spawn.
  tasks: /\b(to-?do|todo|task\s+(list|board|tab)|backlog|checklist|track\s+(this|that|it)|remind\s+me)\b/i,
  messaging: /\b(message|messages|slack|teams|discord|chat|channel|notify|dm|send\s+(a|this|it|them))\b/i,
  repo_registry: /\b(repo|repos|repository|repositories|registry|clone|check\s*out|remote|origin)\b/i,
};

/**
 * The core groups to advertise for this message.
 *
 * `coreToolIds` is the role's own list; the result is always a subset of it.
 */
export function selectCoreToolIds(message: string, coreToolIds: readonly string[]): string[] {
  const text = message ?? '';
  return coreToolIds.filter((id) => {
    if (CORE_TOOL_FLOOR.includes(id)) return true;
    const trigger = INTENT[id];
    return trigger === undefined || trigger.test(text);
  });
}
