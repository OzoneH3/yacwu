import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page) {
 await page.addInitScript(() => {
  const w = window as any;
  class ES {
   onopen: any; onmessage: any; onerror: any; readyState = 1;
   constructor() { w.__sse = this; setTimeout(() => { this.onopen?.({}); this.onmessage?.({data:JSON.stringify({method:'yacwu/connected',params:{}})}); }, 0); }
   addEventListener() {} close() {}
  }
  w.EventSource = ES;
  w.__emit = (msg: any) => w.__sse.onmessage({data:JSON.stringify(msg)});
 });
 const threads = ['home','bob','carol'].map(id=>({id,name:id,cwd:'/audit',host:'local',status:{type:'idle'},turns:[]}));
 await page.route('**/api/**', route => {
  const path = new URL(route.request().url()).pathname;
  if(path==='/api/threads') return route.fulfill({json:{data:threads}});
  if(path==='/api/threads/loaded') return route.fulfill({json:{data:[]}});
  if(path.endsWith('/relay')) return route.fulfill({json:{epoch:'audit',enabled:true,messages:[]}});
  if(path.endsWith('/model')) return route.fulfill({json:{model:'test',models:[]}});
  const thread=threads.find(t=>path.startsWith('/api/threads/'+t.id));
  return route.fulfill({json:thread?{thread}:{}});
 });
 await page.goto('/s/home');
 await expect(page.locator('.composer textarea')).toBeVisible();
 await expect(page.locator('a.session').filter({hasText:'bob'})).toBeVisible();
}
async function event(page: Page, id: string, status: string, turn = 't1') {
 await page.evaluate(({id,status,turn})=>(window as any).__emit({method:status==='inProgress'?'turn/started':'turn/completed',params:{threadId:id,turn:{id:turn,status}}}),{id,status,turn});
}
const marks = (p:Page) => p.locator('.session-finished-indicator');
test('unrelated clicks preserve marks and opening one session dismisses only that session',async({page})=>{
 await setup(page);
 await event(page,'bob','completed'); await event(page,'carol','completed');
 await expect(marks(page)).toHaveCount(2);
 await page.locator('.composer textarea').click();
 await expect(marks(page)).toHaveCount(2);
 await page.locator('a.session').filter({hasText:'bob'}).click();
 await expect(page.locator('a.session').filter({hasText:'carol'}).locator('.session-finished-indicator')).toHaveCount(1);
 await expect(marks(page)).toHaveCount(1);
});
test('a new background turn clears its old completion mark, including if it fails',async({page})=>{
 await setup(page);
 await event(page,'bob','completed');
 await event(page,'bob','inProgress','t2');
 await expect(marks(page)).toHaveCount(0);
 await expect(page.locator('a.session').filter({hasText:'bob'}).locator('.run-dot')).toHaveAttribute('aria-label','Running');
 await event(page,'bob','failed','t2');
 await expect(marks(page)).toHaveCount(0);
});
test('another tab dismissing a mark updates this tab',async({page})=>{
 await setup(page); await event(page,'bob','completed');
 await expect(marks(page)).toHaveCount(1);
 await page.evaluate(()=>{
  const key='yacwu-finished-session:bob';
  localStorage.removeItem(key);
  window.dispatchEvent(new StorageEvent('storage',{key,newValue:null,storageArea:localStorage}));
 });
 await expect(marks(page)).toHaveCount(0);
});
test('legacy completion marks migrate to per-session storage keys',async({page})=>{
 await setup(page);
 await page.evaluate(()=>localStorage.setItem('yacwu-finished-sessions',JSON.stringify({bob:true})));
 await page.reload();
 await expect(page.locator('a.session').filter({hasText:'bob'}).locator('.session-finished-indicator')).toHaveCount(1);
 await expect.poll(()=>page.evaluate(()=>localStorage.getItem('yacwu-finished-session:bob'))).toBe('true');
 await expect.poll(()=>page.evaluate(()=>localStorage.getItem('yacwu-finished-sessions'))).toBeNull();
});
test('a late relay response cannot overwrite a streamed completion',async({page})=>{
 await setup(page);
 let release!:()=>void;
 let requested!:()=>void;
 const pending=new Promise<void>(r=>requested=r);
 await page.route('**/api/threads/bob/relay/deliver',async route=>{
  requested(); await new Promise<void>(r=>release=r);
  await route.fulfill({json:{turn:{id:'relay-turn',status:'inProgress'}}});
 });
 // Enable via saved preference and reload; the setting is read on mount.
 await page.evaluate(()=>localStorage.setItem('yacwu-settings',JSON.stringify({autoSendRelayMessages:true})));
 await page.reload();
 await expect(page.locator('.composer textarea')).toBeVisible();
 await page.evaluate(()=>(window as any).__emit({method:'yacwu/relay/update',params:{epoch:'audit',message:{id:'msg-audit',from:{host:'local',thread:'carol'},to:{host:'local',thread:'bob'},text:'hello',state:'queued',reason:'',submission:'',turnId:'',createdAt:1,version:1,ack:'backend'}}}));
 await pending;
 await event(page,'bob','inProgress','relay-turn');
 await event(page,'bob','completed','relay-turn');
 await expect(page.locator('a.session').filter({hasText:'bob'}).locator('.run-dot')).toHaveAttribute('aria-label','Idle');
 release();
 await expect(page.locator('a.session').filter({hasText:'bob'}).locator('.run-dot')).toHaveAttribute('aria-label','Idle');
 await expect(marks(page)).toHaveCount(1);
});
test('a selected session completed while the tab is hidden gets a mark',async({page})=>{
 await setup(page);
 await page.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}));
 await event(page,'home','inProgress'); await event(page,'home','completed');
 await expect(page.locator('a.session').filter({hasText:'home'}).locator('.session-finished-indicator')).toHaveCount(0);
 expect(await page.evaluate(()=>localStorage.getItem('yacwu-finished-session:home'))).toBe('true');
});
test('runtime recovery of a missed successful completion creates a mark',async({page})=>{
 await setup(page);
 let reads=0;
 const thread={id:'bob',status:{type:'idle'},turns:[{id:'missed',status:'completed',items:[]}]};
 await page.route('**/api/threads/bob/runtime',route=>{reads++;return route.fulfill({json:{thread}})});
 await page.route('**/api/threads/bob?turns=1',route=>route.fulfill({json:{thread}}));
 await page.evaluate(()=>localStorage.setItem('yacwu-running-tasks',JSON.stringify({bob:'bob'})));
 await page.reload();
 await expect.poll(()=>reads).toBeGreaterThan(0);
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('yacwu-running-tasks')??'{}'))).toEqual({});
 await expect(marks(page)).toHaveCount(1);
});
