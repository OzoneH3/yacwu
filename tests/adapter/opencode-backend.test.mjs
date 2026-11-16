import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../..',import.meta.url));
test('OpenCode adapter exposes models, runs a turn, persists history and forks over app-server',{timeout:30000,skip:!existsSync(join(repo,'claude-codex/dist/src/adapter.mjs'))},async()=>{
 const root=mkdtempSync(join(tmpdir(),'yacwu-opencode-'));
 const plugin=join(root,'tools/node_modules/@cortexkit/opencode-magic-context');
 mkdirSync(plugin,{recursive:true});writeFileSync(join(plugin,'package.json'),JSON.stringify({version:'0.49.56'}));
 const child=spawn(process.execPath,[join(repo,'scripts/opencode-backend.mjs')],{env:{...process.env,YACWU_OPENCODE_HOME:root,YACWU_OPENCODE_CLI:join(repo,'tests/adapter/fake-opencode-agent.mjs')},stdio:['pipe','pipe','pipe']});
 const pending=new Map();const notes=[];let n=0,stderr='';
 child.stderr.on('data',chunk=>stderr+=chunk);
 createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);if(message.id!=null){const p=pending.get(message.id);pending.delete(message.id);message.error?p?.reject(new Error(message.error.message)):p?.resolve(message.result);}else notes.push(message);});
 const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try{
  await request('initialize',{clientInfo:{name:'test',version:'1'},capabilities:{experimentalApi:true}});
  const models=await request('model/list');assert.equal(models.data[0].id,'opencode/openai/gpt-6-luna');assert.equal(models.data[0].isDefault,true);
  const {thread}=await request('thread/start',{cwd:root,model:models.data[0].id,approvalPolicy:'never',sandbox:'danger-full-access'});
  const {turn}=await request('turn/start',{threadId:thread.id,input:[{type:'text',text:'hello'}],model:models.data[0].id,effort:'high'});
  for(let i=0;i<100&&!notes.some(n=>n.method==='turn/completed'&&n.params.turn.id===turn.id);i++)await new Promise(r=>setTimeout(r,20));
  const done=notes.find(n=>n.method==='turn/completed'&&n.params.turn.id===turn.id);assert.equal(done?.params.turn.status,'completed',stderr);
  const read=await request('thread/read',{threadId:thread.id,includeTurns:true});assert.equal(read.thread.turns.length,1);
  assert.ok(JSON.stringify(read).includes('OpenCode response'));
  const fork=await request('thread/fork',{threadId:thread.id});assert.notEqual(fork.thread.id,thread.id);
  const quota=await request('account/rateLimits/read');assert.equal(quota.rateLimits,null);
 }finally{child.stdin.end();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},3000).unref();});}
});
