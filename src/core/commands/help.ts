import { registerCommand, getAllCommands } from './registry';

registerCommand({
  name: 'help',
  description: 'Show available commands',
  async execute() {
    const cmds = getAllCommands();
    const rows = cmds.map(c => `| \`/${c.name}\` | ${c.description} |`).join('\n');
    return {
      response: [
        '**Available Commands**\n',
        '| Command | Description |',
        '|---------|-------------|',
        rows,
        '',
        'Type `/cancel` at any time to abort a multi-step command.',
      ].join('\n'),
    };
  },
});
