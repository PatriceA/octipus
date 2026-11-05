/** Classification is a hint for investigation, never proof of an underlying cause. */
export function classifyCompanionBlocker(text: string): string {
  if (/unknown outcome|receipt.*interrupt|uncertain|suspected_command_outcome/i.test(text)) return 'unknown_outcome';
  if (/permission denied \(publickey\)|missing or incomplete configuration|unauthorized|authentication/i.test(text)) return 'authentication';
  if (/flow.guard|approval|outside.*profile|policy|consent/i.test(text)) return 'authorization';
  if (/sdk location|read.only file system|no such file|not found|bwrap|device|adb|gradle.*lock/i.test(text)) return 'environment';
  if (/model.*unavailable|no local model|model.*bound/i.test(text)) return 'model';
  if (/test.*fail|assertion|FAIL|expected.*received/i.test(text)) return 'test';
  return 'execution';
}
