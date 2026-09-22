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

Changes apply to newly started turns and agents. Existing running agents keep their current instructions. Mounted SKILL.md files are selectable too. If a selected skill is removed or becomes inaccessible, the next agent fails visibly; choose Automatic to remove the unavailable selection.

The complete skill content is retained in system context across compaction. This guarantees loading, not perfect model compliance, and adds the full skill's token cost. Skill selection does not grant tool permissions.
