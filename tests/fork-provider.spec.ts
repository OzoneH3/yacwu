import {expect,test} from '@playwright/test';

test('/fork provider sends the destination and navigates using its backend',async({page})=>{
 const source={id:'source',name:'Source',cwd:'/project',status:{type:'idle'},turns:[]};
 const destination={...source,id:'destination',name:'Fork'};
 let body:Record<string,unknown>|null=null;
 let created=false;
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());
  const path=url.pathname;
  if(path==='/api/events')return route.fulfill({contentType:'text/event-stream',body:': connected\n\n'});
  let data:unknown={};
  if(path==='/api/hosts')data={hosts:[{name:'local',kind:'local',provider:'codex',state:'connected'},{name:'oc',kind:'backend',provider:'opencode',state:'connected'}]};
  else if(path==='/api/threads/source/fork'){
   created=true;body=route.request().postDataJSON();data={thread:destination,host:'oc',transfer:'transcript'};
  }else if(path==='/api/threads')data={data:url.searchParams.get('host')==='oc'?(created?[destination]:[]):[source],defaultCwd:'/project'};
  else if(path.endsWith('/open'))data={thread:path.includes('/destination/')?destination:source};
  else if(path.endsWith('/file-access'))data={mode:'read-write',readOnlySupported:true};
  else if(path.endsWith('/model'))data={model:'gpt-6-luna',effort:'medium',choices:[],efforts:[]};
  else if(path.endsWith('/history'))data={turns:[],cursor:null};
  else if(path.startsWith('/api/threads/'))data={thread:path.includes('/destination')?destination:source};
  await route.fulfill({json:data});
 });
 await page.goto('/s/source');
 const composer=page.locator('.composer textarea');
 await composer.fill('/fork opencode');await page.locator('button.send').click();
 await expect.poll(()=>body).toEqual({provider:'opencode'});
 await expect(page).toHaveURL(/\/s\/destination\?host=oc/);
});

test('the fork API rejects unknown and disabled providers instead of silently forking locally',async({request})=>{
 const response=await request.post('/api/threads',{data:{cwd:process.cwd()}});
 expect(response.ok()).toBe(true);
 const {thread}=await response.json();
 for(const provider of ['not-a-provider','claude']){
  const fork=await request.post(`/api/threads/${thread.id}/fork`,{data:{provider}});
  expect(fork.status(),await fork.text()).toBe(400);
 }
});
