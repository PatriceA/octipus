/**
 * What a command is allowed to be, independent of who is running it.
 *
 * Extracted from `ShellTool` so there is ONE denylist rather than one per
 * caller. It was private to the tool, which was fine while the tool was the
 * only way a command reached a process; the `command_exit_zero` scorer is a
 * second way in, and a second copy of these rules is a copy that goes stale
 * exactly when it matters.
 *
 * This is the *content* policy — is this string a dangerous command. It is not
 * the permission layer (who may run commands at all) and not the execution
 * sandbox; those stay with their own owners, and a caller outside `ShellTool`
 * has to satisfy them separately.
 */

/** Commands refused outright, whoever asks. */
export const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  'mkfs',
  ':(){:|:&};:',
  'dd if=/dev/random',
  'chmod -R 777 /',
  'chmod 777 /',
  // Data exfiltration / reverse shell tools
  'nc ',
  'nc -',
  'ncat ',
  'ncat -',
  'netcat ',
  'netcat -',
  // Process management — prevent agents from killing Octipus or other processes
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
];

/** Commands that require the DENY-by-default `execute_elevated` permission. */
export const ELEVATED_COMMANDS = [
  'sudo',
  'su',
  'chown',
  'chmod',
  'systemctl',
  'service',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pacman',
  'docker',
  'podman',
  'mount',
  'umount',
  'iptables',
  'ip6tables',
  'nft',
  // Process management — prevent accidental self-kill
  'kill',
  'pkill',
  'killall',
  'xkill',
];

const INJECTION_PATTERNS = [
  /;\s*rm\s+/i,
  /\|\s*rm\s+/i,
  /`.*rm.*`/i,
  /\$\(.*rm.*\)/i,
  />\s*\/dev\/sd/i,
  />\s*\/dev\/hd/i,
  // Data exfiltration: piping output to network tools
  /\|\s*curl\s+/i,
  /\|\s*wget\s+/i,
  /\|\s*nc\s+/i,
  /\|\s*ncat\s+/i,
  /\|\s*netcat\s+/i,
  // Suspicious backtick command substitution (nested command execution)
  /`[^`]*`.*`[^`]*`/i,
  // Suspicious $(...) expansion piping to network tools
  /\$\(.*\).*\|\s*(curl|wget|nc|ncat|netcat)\s/i,
];

/**
 * The elevated keyword a command invokes at the start of the line or after a
 * pipe / `;` / `&&` separator, else null.
 */
export function matchElevatedCommand(command: string): string | null {
  for (const elevated of ELEVATED_COMMANDS) {
    const patterns = [
      new RegExp(`^${elevated}\\b`, 'i'),
      new RegExp(`\\|\\s*${elevated}\\b`, 'i'),
      new RegExp(`;\\s*${elevated}\\b`, 'i'),
      new RegExp(`&&\\s*${elevated}\\b`, 'i'),
    ];
    if (patterns.some((p) => p.test(command))) return elevated;
  }
  return null;
}

/**
 * Why this command may not run, or null when the content policy permits it.
 *
 * Returns a reason rather than throwing, because one caller wants an exception
 * and the other wants a failed gate. Whitespace runs are normalized first so
 * trivial evasions (`rm -rf  /`, tabs, a newline between tokens) still match.
 */
export function commandPolicyViolation(command: string): string | null {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ');

  for (const blocked of BLOCKED_COMMANDS) {
    if (normalized.includes(blocked.toLowerCase())) {
      return `Blocked command detected: ${blocked}`;
    }
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(command)) return 'Potential command injection detected';
  }

  return null;
}
