import { afterEach, expect, test } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '@/config';
import { inspectCliKubeconfig, withCliKubeconfig } from './cli-kubeconfig';
import { LocalShellOperations } from '@/tools/shell/local-operations';
const directories: string[] = [];
afterEach(() => { getConfig().security.cliKubeconfigs = []; getConfig().security.shellSandbox = 'off'; for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-kube-')); directories.push(dir);
  const path = join(dir, 'config');
  const data = { 'current-context':'test-context', contexts:[{name:'test-context',context:{cluster:'test-cluster',user:'test-user'}}], clusters:[{name:'test-cluster',cluster:{server:'https://cluster.example.test'}}], users:[{name:'test-user',user:{token:'synthetic-secret'}}] };
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  return { path, dir, data };
}
test('inspection exposes only path/context metadata and rejects incomplete or external credential sources', () => {
  const { path, data } = fixture();
  expect(inspectCliKubeconfig(path)).toEqual({path,resolvedPath:path,context:'test-context'});
  expect(JSON.stringify(inspectCliKubeconfig(path))).not.toContain('synthetic-secret');
  writeFileSync(path, JSON.stringify({...data,users:[{name:'test-user',user:{'client-key':'/private/key'}}]}));
  expect(() => inspectCliKubeconfig(path)).toThrow('embedded credentials');
  writeFileSync(path, 'invalid:\n token: synthetic-secret\n  malformed');
  try { inspectCliKubeconfig(path); throw new Error('Expected refusal'); } catch (error) { expect(String(error)).not.toContain('synthetic-secret'); }
});
test('only the selected owner receives the file and environment; spaces, other users and anonymous jobs do not', () => {
  const { path } = fixture();
  getConfig().security.cliKubeconfigs = [{ ...inspectCliKubeconfig(path), userId:'alice' }];
  const options = { env:{EXAMPLE:'keep'},extraReadOnly:['/example'] };
  expect(withCliKubeconfig({userId:'alice'},options)).toEqual({env:{EXAMPLE:'keep',KUBECONFIG:path},extraReadOnly:['/example',path]});
  for (const caller of [undefined,{userId:'bob'},{userId:'alice',space:{workspaceId:'shared'}},{userId:'alice',trigger:'remote'},{userId:'alice',audienceFederated:true}]) expect(withCliKubeconfig(caller,options)).toBe(options);
});
test('selected context changes require reselection rather than silently switching identity', () => {
  const { path, data } = fixture();
  getConfig().security.cliKubeconfigs = [{ ...inspectCliKubeconfig(path), userId:'alice' }];
  const renamed = { ...data,'current-context':'other',contexts:[{name:'other',context:{cluster:'test-cluster',user:'test-user'}}] };
  writeFileSync(path,JSON.stringify(renamed));
  expect(() => withCliKubeconfig({userId:'alice'},{})).toThrow('select it again');
});
test.skipIf(!existsSync('/usr/bin/bwrap'))('the actual sandbox can read the selected owner kubeconfig read-only without exposing adjacent files', async () => {
  const { path, dir } = fixture();
  mkdirSync(join(dir, 'workspace'));
  writeFileSync(join(dir,'adjacent-private'),'private');
  getConfig().security.cliKubeconfigs = [{ ...inspectCliKubeconfig(path), userId:'alice' }];
  getConfig().security.shellSandbox = 'required';
  const code = "const fs=require('fs');const p=process.env.KUBECONFIG;if(!p||!fs.readFileSync(p,'utf8').includes('synthetic-secret'))process.exit(1);try{fs.appendFileSync(p,'x');process.exit(2)}catch{};if(fs.existsSync(p.replace(/config$/,'adjacent-private')))process.exit(3);console.log('identity-readable-readonly')";
  const result = await new LocalShellOperations().exec(`node -e "${code}"`,join(dir,'workspace'),withCliKubeconfig({userId:'alice'},{timeout:5000}));
  expect(result.exitCode).toBe(0); expect(result.stdout.trim()).toBe('identity-readable-readonly'); expect(result.stderr).toBe('');
});
