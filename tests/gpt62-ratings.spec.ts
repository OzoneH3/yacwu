import { expect, test } from '@playwright/test';

test('new Codex models show ratings and replace older dominated picker entries', async ({ page }) => {
 const thread={id:'gpt62',cwd:'/project',status:{type:'idle'},turns:[]};
 const ids=['gpt-6-luna','gpt-6.1-terra','gpt-6.1-sol','gpt-6-astra','gpt-6.2-sol','gpt-6.2-astra'];
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/events') return route.fulfill({contentType:'text/event-stream',body:': connected\n\n'});
  let data:object={};
  if(path==='/api/threads') data={data:[thread],defaultCwd:'/project'};
  else if(path.endsWith('/model')) data={model:'gpt-6.2-sol',effort:'medium',models:ids.map(id=>({id,displayName:id.replace('gpt','GPT').replace(/-/g,' '),efforts:['low','medium','high'],defaultEffort:'low'}))};
  else if(path.endsWith('/file-access')) data={mode:'read-write',readOnlySupported:true};
  else if(path.startsWith('/api/threads/')) data={thread};
  await route.fulfill({json:data});
 });
 await page.goto('/s/gpt62');
 const picker=page.getByLabel('Model',{exact:true});
 await expect(picker.locator('option')).toHaveCount(4);
 await expect(picker.locator('option[value="gpt-6.2-sol"]')).toContainText('Cap ~97 · Very good · 4.0');
 await expect(picker.locator('option[value="gpt-6.2-astra"]')).toContainText('Cap ~100 · Good · 2.5');
 await expect(picker.locator('option[value="gpt-6.2-sol"]')).toHaveAttribute('data-yacwu-tooltip',/Provisional/);
 await expect(picker.locator('option[value="gpt-6.1-sol"]')).toHaveCount(0);
 await expect(picker.locator('option[value="gpt-6-astra"]')).toHaveCount(0);
});
