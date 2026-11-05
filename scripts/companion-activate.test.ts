import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';

test('external activation launcher survives as a separate process and atomically records success or failure',()=>{
 const dir=mkdtempSync(join(tmpdir(),'companion-external-launch-'));try{
  mkdirSync(join(dir,'bin'));mkdirSync(join(dir,'scripts'));
  copyFileSync('scripts/companion-activate.mjs',join(dir,'scripts/companion-activate.mjs'));
  const file=join(dir,'receipt.json');
  writeFileSync(join(dir,'bin/octi.mjs'),'import {writeFileSync} from "node:fs";writeFileSync("launched.json",JSON.stringify(process.argv.slice(2)));');
  writeFileSync(file,JSON.stringify({id:'receipt-fixture',root:dir,status:'launched'}));
  execFileSync(process.execPath,[join(dir,'scripts/companion-activate.mjs'),file],{stdio:'ignore'});
  expect(JSON.parse(readFileSync(file,'utf8'))).toMatchObject({id:'receipt-fixture',status:'restarted'});
  expect(JSON.parse(readFileSync(join(dir,'launched.json'),'utf8'))).toEqual(['restart','web']);
  writeFileSync(join(dir,'bin/octi.mjs'),'process.exit(1)');
  writeFileSync(file,JSON.stringify({id:'receipt-failure',root:dir,status:'launched'}));
  execFileSync(process.execPath,[join(dir,'scripts/companion-activate.mjs'),file],{stdio:'ignore'});
  expect(JSON.parse(readFileSync(file,'utf8'))).toMatchObject({id:'receipt-failure',status:'failed'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
