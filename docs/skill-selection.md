# Selecting skills

The WebUI, TUI and TUI Editor share the same saved skill selection.

- **Automatic:** normal discovery; the agent loads relevant skills on demand.
- **Always:** your personal default for every chat. The full skill is loaded into the main agent and subagents, with instructions to apply it when relevant.
- **This session:** loads the full skill only in this conversation. It survives restarts, compaction and `/clear`.

In the WebUI, open **Skills** above the chat timeline to select skills for the current session. Open **Skills** on the Skills management page to edit your defaults. Selecting Automatic in a chat overrides an Always default only for that chat; selecting Always clears that chat's override. Other sessions keep their explicit overrides.

The same commands work in all three chat clients:

```text
/skills
/skills technical-writing session
/skills technical-writing always
/skills technical-writing auto
/skills technical-writing auto --global
```

Use the id shown by `/skills`, or an unambiguous skill name. `auto --global` removes the Always default; `auto` in a chat changes only that session. TUI clients can select skills before their first message.

Changes apply to newly started turns and agents. Existing running agents keep their current instructions. Mounted SKILL.md files are selectable too. If a selected skill disappears from its source or becomes inaccessible, the next agent fails visibly; choose Automatic to remove the unavailable selection.

On the Skills page, **Remove from Octipus** removes a mounted or shared skill from your personal catalog and clears its saved selections. The exclusion survives rescans and restarts; source files and other users' catalogs are unaffected. **Delete** permanently deletes your own database skill. Removed skills are excluded from discovery prompts and skill-loading tools for new agents.

Multiple paths to the same physical SKILL.md (including junctions/symlinks) are combined, with all sources shown on the expanded card. Identical standalone copies are combined too. Same-name variants and separate directories with supporting assets remain distinct. Old source IDs remain aliases, so existing selections continue to work.

The complete skill content is retained in system context across compaction. This guarantees loading, not perfect model compliance, and adds the full skill's token cost. Skill selection does not grant tool permissions.

## Skills for pipeline steps

A pipeline step can force skills onto the agent that runs it. Open a template on the **Pipelines** page, expand a step and add skills under **Skills**. Their full content goes into that step's agent prompt. This works for API-model agents and for CLI agents (Claude Code, Codex, …). Without this, those agents only see the one-line skill index and must call `get_skill` themselves, which they often skip. If a selected skill is deleted or becomes inaccessible, the step fails visibly. It never runs without the skill.

**Let the decision model add skills for each task** goes further. Before each run of the step, the model bound to the **Decision** topic looks at the skills discovery found for the task (at most 8). It judges each one separately and loads only the skills it is confident the task needs: probability and confidence must both be at least 0.8. The task text can include workspace code, so this decision site (`skills.select`) is `secret` and runs only on a local decision model with no data retention. If no such model is bound, nothing is added and the index stays as before. The chat shows which skills a step loaded and which ones the decision model picked.
