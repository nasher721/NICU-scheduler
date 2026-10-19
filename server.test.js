import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './server.js';
import { smallWorkbook, workbookPath, hasWorkbook } from './test-fixture.js';

async function start(t) {
  const app=createApp({dbPath:':memory:'});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`,list=await (await fetch(base+'/api/imports')).json();
  const request=(path,options={})=>fetch(base+path,{...options,headers:{'X-Workspace-Token':list.token,...options.headers}});
  return {app,base,request};
}
test('HTTP upload, source download, review, duplicate upload and export work end-to-end',async t=>{
  const {request}=await start(t),bytes=await smallWorkbook();
  const upload=()=>request('/api/imports',{method:'POST',headers:{'X-Filename':'test.xlsx'},body:bytes});
  const response=await upload();assert.equal(response.status,200);const snapshot=await response.json();
  const issue=snapshot.workbook.issues.find(i=>i.type==='strikethrough');
  const save=await request(`/api/imports/${snapshot.id}/review/${issue.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,decision:{action:'exclude',note:'Confirmed cancellation'}})});
  assert.equal(save.status,200);assert.equal((await save.json()).revision,1);
  const duplicate=await (await upload()).json();assert.equal(duplicate.duplicate,true);assert.equal(duplicate.revision,1);
  assert.equal((await (await request(`/api/imports/${snapshot.id}`)).json()).decisions[issue.id].action,'exclude');
  assert.deepEqual(Buffer.from(await (await request(`/api/imports/${snapshot.id}/source`)).arrayBuffer()),bytes);
  const backup=await (await request(`/api/imports/${snapshot.id}/backup`)).json();assert.equal(backup.events.length,1);
  const invalid=await request(`/api/imports/${snapshot.id}/review/${issue.id}`,{method:'POST',body:JSON.stringify({revision:1,decision:{action:'source',note:'wrong type'}})});assert.equal(invalid.status,400);
  assert.equal((await (await request(`/api/imports/${snapshot.id}`)).json()).revision,1);
});
test('HTTP protects private files and rejects cross-origin, stale, malformed, and oversized writes',async t=>{
  const {base,request}=await start(t);
  assert.equal((await request('/.data/workspace.sqlite')).status,404);
  assert.equal((await request('/workbook-store.js')).status,404);
  assert.equal((await fetch(base+'/api/imports',{method:'POST'})).status,403);
  assert.equal((await request('/api/imports',{method:'POST',headers:{Origin:'https://elsewhere.example'}})).status,403);
  assert.equal((await request('/api/imports',{method:'POST',headers:{'X-Filename':'bad.xlsx'},body:'bad zip'})).status,400);
  assert.equal((await request('/api/imports',{method:'POST',headers:{'X-Filename':'large.xlsx'},body:Buffer.alloc(10*1024*1024+1)})).status,413);
  assert.equal((await (await request('/api/imports')).json()).imports.length,0);
});
test('real workbook passes the bounded worker and HTTP persistence boundary',{skip:!hasWorkbook},async t=>{
  const {request}=await start(t),bytes=await readFile(workbookPath);
  const response=await request('/api/imports',{method:'POST',headers:{'X-Filename':encodeURIComponent('MASTER_NEW_CALENDAR_NICU_Staff_SCHEDULE 2.xlsx')},body:bytes});
  assert.equal(response.status,200);const data=await response.json();assert.equal(data.workbook.stats.cells,6503);assert.equal(data.workbook.sheets.length,10);
  const ledger=data.workbook.issues.find(i=>i.title==='Target total excludes listed staff');
  const saved=await request(`/api/imports/${data.id}/review/${ledger.id}`,{method:'POST',body:JSON.stringify({revision:0,decision:{action:'acknowledge',note:'Niv excluded in the source total; preserve both values for confirmation.'}})});
  assert.equal(saved.status,200);const stale=await request(`/api/imports/${data.id}/review/${ledger.id}`,{method:'POST',body:JSON.stringify({revision:0,decision:{action:'reopen',note:'Stale review'}})});assert.equal(stale.status,409);
});
