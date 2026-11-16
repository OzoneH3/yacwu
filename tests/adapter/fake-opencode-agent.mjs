#!/usr/bin/env node
import {createInterface} from 'node:readline';
let counter=0;
const configOptions=[{id:'model',category:'model',currentValue:'openai/gpt-6-luna',options:[{value:'openai/gpt-6-luna',name:'GPT-6 Luna'}]},{id:'effort',category:'thought_level',currentValue:'medium',options:[{value:'low'},{value:'medium'},{value:'high'}]}];
const send=message=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params}=JSON.parse(line);
 if(id==null)return;
 let result={};
 if(method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true}};
 if(['session/new','session/fork','session/load'].includes(method))result={sessionId:method==='session/load'?params.sessionId:'ses_test_'+counter++,configOptions};
 if(method==='session/set_config_option')result={configOptions:configOptions.map(o=>o.id===params.configId?{...o,currentValue:params.value}:o)};
 if(method==='session/prompt'){
  send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OpenCode response'}}}});
  result={stopReason:'end_turn',usage:{inputTokens:100,outputTokens:5}};
 }
 send({id,result});
});
