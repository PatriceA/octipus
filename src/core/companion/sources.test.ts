import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {WorkspaceFS} from '@/security/workspace-fs';
import {companionSourceFiles} from './sources';

test('relative attachment refs are canonicalized in their source scope before delegation',()=>{
 const source=mkdtempSync(join(tmpdir(),'companion-canonical-source-'));try{
  writeFileSync(join(source,'README.md'),'Owner source');
  const refs=companionSourceFiles(WorkspaceFS.withRoot(source),[{path:'README.md',protectionLevel:4}]);
  expect(refs).toEqual([{path:join(source,'README.md'),protectionLevel:4}]);
  expect(()=>companionSourceFiles(WorkspaceFS.withRoot(source),[{path:'../unapproved.txt'}])).toThrow();
 }finally{rmSync(source,{recursive:true,force:true});}
});
