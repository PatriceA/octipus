/** Discovery is advisory: executable names are never an access allowlist. */
export const ENVIRONMENT_INVENTORY_PROGRAM = String.raw`
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const commands=[],seen=new Set();
for(const dir of (process.env.PATH??'').split(path.delimiter).filter(Boolean)){
 let names;try{names=fs.readdirSync(dir).sort();}catch{continue;}
 for(const name of names){if(commands.length>=4096)break;if(seen.has(name))continue;
  const file=path.join(dir,name);try{if(!fs.statSync(file).isFile())continue;
   if(process.platform==='win32'){if(!(process.env.PATHEXT??'.EXE;.CMD;.BAT;.COM').split(';').some(ext=>name.toUpperCase().endsWith(ext.toUpperCase())))continue;}
   else fs.accessSync(file,fs.constants.X_OK);
   seen.add(name);commands.push({name,path:file});
  }catch{}
 }
}
const aliases=new Set();
// Read configuration as data: never ssh -G, which can execute Match exec.
try{const text=fs.readFileSync(path.join(os.homedir(),'.ssh','config'),'utf8');
 for(const line of text.split(/\r?\n/)){const m=line.match(/^\s*Host\s+(.+?)\s*(?:#.*)?$/i);if(!m)continue;
  for(const name of m[1].split(/\s+/)){if(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))aliases.add(name);}
 }
}catch{}
process.stdout.write(JSON.stringify({commands,sshAliases:[...aliases].sort(),truncated:commands.length>=4096}));`;
