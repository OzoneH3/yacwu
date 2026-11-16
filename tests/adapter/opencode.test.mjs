import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeRuntime, pickerModels, openCodeEnvironment } from '../../scripts/opencode-backend.mjs';

test('OpenCode models retain provider identity and actual default', () => {
 const models = pickerModels({current:'openai/gpt-6-luna',models:[{id:'openai/gpt-6-luna',name:'Luna'},{id:'anthropic/claude-opus-5-5',name:'Opus'}]});
 assert.equal(models[0].id,'opencode/openai/gpt-6-luna');
 assert.equal(models[0].isDefault,true);
 assert.equal(models[1].isDefault,false);
});
test('OpenCode pins Magic Context and disables competing compaction', () => {
 const env=openCodeEnvironment('/project/.workspace/opencode','/tools/plugin',{YACWU_OPENCODE_MODEL:'openai/gpt-6-luna'});
 const config=JSON.parse(env.OPENCODE_CONFIG_CONTENT);
 assert.equal(config.compaction.auto,false);
 assert.equal(config.compaction.prune,false);
 assert.equal(config.plugins[0].package,'file:///tools/plugin');
 assert.equal(env.XDG_DATA_HOME,'/project/.workspace/opencode/data');
});
test('OpenCode selects provider/model and offered effort without Copilot assumptions',async()=>{
 const runtime=new OpenCodeRuntime({command:['unused']});const calls=[];
 runtime.open.set('s',{options:[{id:'model',category:'model',currentValue:'openai/gpt-6-luna',options:[{value:'openai/gpt-6-luna'},{value:'anthropic/claude-opus-5-5'}]},{id:'effort',category:'thought_level',currentValue:'low',options:[{value:'low'},{value:'high'}]}],cwd:'/project',instructions:null,models:null});
 await runtime.configure({request:async(method,params)=>{calls.push({method,params});return {};}},'s',{model:'opencode/anthropic/claude-opus-5-5',effort:'high'});
 assert.deepEqual(calls.map(c=>c.params),[{sessionId:'s',configId:'model',value:'anthropic/claude-opus-5-5'},{sessionId:'s',configId:'effort',value:'high'}]);
 await assert.rejects(runtime.configure({request:async()=>{}},'s',{model:'opencode/missing/model'}),/unavailable/);
});
test('OpenCode fork preserves source history',async()=>{
 const runtime=new OpenCodeRuntime({command:['unused']});const calls=[],events=[];
 const id=await runtime.session({request:async(method,params)=>{calls.push({method,params});return {sessionId:'fork',configOptions:[]};}},{threadId:'t',claudeSessionId:'source',forkSession:true,cwd:'/project'},{onEvent:async e=>events.push(e)});
 assert.equal(id,'fork');assert.equal(calls[0].method,'session/fork');assert.equal(calls[0].params.sessionId,'source');assert.equal(events[0].claudeSessionId,'fork');
});
test('OpenCode rejects unsupported read-only rather than approving writes',async()=>{
 await assert.rejects(new OpenCodeRuntime({command:['unused']}).runTurn({sandboxMode:'read-only'},{}),/read-only/i);
});
test('OpenCode errors retain their actual cause',()=>{
 assert.equal(new OpenCodeRuntime({command:['unused']}).explain(new Error('model unavailable')),'model unavailable');
});

test('OpenCode questions map typed choices into the existing question cards',async()=>{
 const runtime=new OpenCodeRuntime({command:['unused']});
 runtime.bySession.set('s',{cancelled:false,permissions:new Set(),handlers:{onUserInputRequest:async e=>{assert.equal(e.questions[0].options[0].label,'Bun');return {answers:{pm:{answers:['Bun']}}};}}});
 assert.deepEqual(await runtime.agentRequest('elicitation/create',{sessionId:'s',toolCallId:'q',message:'Choose',requestedSchema:{properties:{pm:{type:'string',oneOf:[{const:'bun',title:'Bun'}]}}}}),{action:'accept',content:{pm:'bun'}});
});
