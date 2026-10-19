import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from './server.js';
import { workbookPath, hasWorkbook } from './test-fixture.js';

if (!hasWorkbook) throw new Error('Set WORKBOOK_FIXTURE to the analyzed Excel workbook before running browser acceptance tests.');
const directory=await mkdtemp(join(tmpdir(),'schedule-browser-')),artifacts=resolve('test-results');
await mkdir(artifacts,{recursive:true});
let app=createApp({dbPath:join(directory,'workspace.sqlite')}), browser;
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const port=app.server.address().port,base=`http://127.0.0.1:${port}`;
const sourceHash=createHash('sha256').update(await readFile(workbookPath)).digest('hex');
const failures=[];
try {
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL || (process.platform==='win32'?'msedge':'chromium')});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  context.setDefaultTimeout(10000);
  const page=await context.newPage();page.on('pageerror',error=>failures.push(error.message));
  await page.goto(base);await expect(page.locator('#wb-empty')).toBeVisible();
  const originalDemo=await page.evaluate(async()=>{const {seed}=await import('/model.js');const raw=JSON.stringify({version:1,shifts:seed('2026-10-19'),showWelcome:false});localStorage.setItem('connecteam-local-v1',raw);return raw;});
  await page.reload();await expect(page.locator('#wb-empty')).toBeVisible();
  await page.locator('#wb-file').setInputFiles(workbookPath);await page.getByRole('button',{name:'Import workbook',exact:true}).click();
  await expect(page.locator('#wb-loaded')).toBeVisible({timeout:30000});await expect(page.locator('#wb-message')).toContainText('Imported all 10 sheets');
  await expect(page.locator('.wb-overview')).toContainText('6,503');await expect(page.locator('.wb-overview')).toContainText('733');
  const imported=(await (await page.request.get(base+'/api/imports')).json()).imports;assert.equal(imported.length,1);const id=imported[0].id;
  const snapshot=await (await page.request.get(`${base}/api/imports/${id}`)).json();assert.equal(snapshot.workbook.stats.cells,6503);
  console.log(`PASS browser upload: ${snapshot.workbook.stats.sheets} sheets, ${snapshot.workbook.stats.cells} cells, ${snapshot.workbook.issues.length} review items.`);

  await page.locator('#wb-date').fill('2026-01-12');await page.locator('#wb-date').press('Tab');
  const strike=snapshot.workbook.records.find(r=>r.sheet==='2026 Sch'&&r.address==='F14');
  await page.locator(`[data-record="${strike.id}"]`).click();await page.getByRole('button',{name:/Struck out: Bolt/}).click();
  await page.locator('#wb-review-form select[name="action"]').selectOption('exclude');
  await page.locator('#wb-review-form textarea').fill('Browser test: confirm cancelled source entry, original retained.');
  await page.getByRole('button',{name:'Save review',exact:true}).click();await expect(page.locator('#wb-dialog')).not.toBeVisible();
  await expect(page.locator(`[data-record="${strike.id}"]`)).toHaveCount(0);
  await page.locator('#wb-status').selectOption('excluded');await expect(page.locator(`[data-record="${strike.id}"]`)).toContainText('Excluded');
  await page.reload();await expect(page.locator('#wb-loaded')).toBeVisible();
  let saved=await (await page.request.get(`${base}/api/imports/${id}`)).json();assert.equal(saved.decisions[strike.entryIssue].action,'exclude');
  console.log('PASS struck-out review: excluded from the active calendar, retained in source and after reload.');

  await page.getByRole('button',{name:/Review queue/}).click();await page.locator('#wb-review-type').selectOption('identity');
  const alias=snapshot.workbook.issues.find(i=>i.type==='identity'&&i.label==='Rosales');
  await page.locator('#wb-review-search').fill('Identify “Rosales”');await page.locator(`[data-issue="${alias.id}"]`).click();
  const person=snapshot.workbook.staff.find(p=>p.name==='Villamizar Rosales');
  await page.locator('#wb-review-form select[name="person"]').selectOption(person.id);await page.locator('#wb-review-form textarea').fill('Browser test: confirmed full roster name.');
  await page.getByRole('button',{name:'Save review',exact:true}).click();await expect(page.locator('#wb-dialog')).not.toBeVisible();
  saved=await (await page.request.get(`${base}/api/imports/${id}`)).json();assert.equal(saved.decisions[alias.id].staffId,person.id);
  await page.getByRole('button',{name:'Schedule',exact:true}).click();await page.locator('#wb-date').fill('2026-01-12');await page.locator('#wb-date').press('Tab');
  await page.locator('#wb-staff').selectOption(person.id);await expect(page.locator('.wb-calendar')).toContainText('Villamizar Rosales');
  console.log('PASS identity mapping: roster name appears in schedule and person filter.');

  await page.getByRole('button',{name:/Review queue/}).click();await page.locator('#wb-review-search').fill('');await page.locator('#wb-review-type').selectOption('overlap');
  const overlap=snapshot.workbook.issues.find(i=>i.type==='overlap'&&i.date==='2026-01-03');await page.locator(`[data-issue="${overlap.id}"]`).click();
  await page.locator('#wb-review-form select[name="sheet"]').selectOption('2026 Sch');await page.locator('#wb-review-form textarea').fill('Browser test: current-year sheet selected; previous source preserved.');
  await page.getByRole('button',{name:'Save review',exact:true}).click();await expect(page.locator('#wb-dialog')).not.toBeVisible();

  await page.getByRole('button',{name:'All sheets',exact:true}).click();
  const expected=['2026 Sch','Staff 2026 #s','Sheet1','2026 RD changes','2025 First Half','2025 second half','Staff 2025 #s','Swap Tracker','FTE Calc','Moonligiting avaibility '];
  for(const sheet of expected){await page.locator(`[data-sheet="${sheet}"]`).click();await expect(page.locator('#wb-source-table')).toBeVisible();}
  await page.locator('[data-sheet="2025 First Half"]').click();await page.locator('#wb-source-search').fill('G333');await expect(page.locator('#wb-source-table')).toContainText('Barron was on Consults');
  await page.locator('[data-sheet="Moonligiting avaibility "]').click();await expect(page.locator('#wb-source-table')).toContainText('September');
  console.log('PASS all-sheet explorer: ten sheets opened, sparse G333 note and moonlighting source visible.');

  await page.getByRole('button',{name:'Source workload',exact:true}).click();await expect(page.locator('#wb-content')).toContainText('243');await expect(page.locator('#wb-content')).toContainText('148');
  await page.getByRole('button',{name:/Target total excludes listed staff/}).click();await page.locator('#wb-review-form textarea').fill('Browser test: record omitted target row, preserve reported values for confirmation.');
  await page.getByRole('button',{name:'Save review',exact:true}).click();await expect(page.locator('#wb-dialog')).not.toBeVisible();
  console.log('PASS workload review: inclusive targets shown separately from source totals, interpretation saved.');

  await page.locator('#wb-file').setInputFiles(workbookPath);await page.getByRole('button',{name:'Import workbook',exact:true}).click();await expect(page.locator('#wb-message')).toContainText('already imported',{timeout:30000});
  assert.equal((await (await page.request.get(base+'/api/imports')).json()).imports.length,1);
  saved=await (await page.request.get(`${base}/api/imports/${id}`)).json();assert.equal(saved.revision,4);assert.equal(Object.keys(saved.decisions).length,4);
  assert.equal(await page.evaluate(()=>localStorage.getItem('connecteam-local-v1')),originalDemo);
  console.log('PASS duplicate import: no duplicate workbook, all four review decisions and original demo retained.');

  const originalDownload=page.waitForEvent('download');await page.getByRole('link',{name:'Download original',exact:true}).click();const original=await originalDownload;
  assert.equal(createHash('sha256').update(await readFile(await original.path())).digest('hex'),sourceHash);
  const backupDownload=page.waitForEvent('download');await page.getByRole('link',{name:'Export review backup',exact:true}).click();const backup=await backupDownload;
  const exported=JSON.parse(await readFile(await backup.path(),'utf8'));assert.equal(exported.events.length,4);assert.equal(exported.workbook.stats.cells,6503);
  await page.getByRole('button',{name:'Schedule',exact:true}).click();await page.locator('#wb-date').fill('2026-10-19');await page.locator('#wb-date').press('Tab');
  const csvDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Export this week',exact:true}).click();const csv=await csvDownload;const text=await readFile(await csv.path(),'utf8');assert(text.includes('Source sheet'));assert(text.includes('2026-10-19'));assert(!text.includes('09:00'));
  console.log('PASS downloads: exact original file hash, review audit backup, and date-only schedule CSV.');

  await page.getByRole('button',{name:'Original demo',exact:true}).click();await expect(page.locator('#demo-workspace')).toBeVisible();await expect(page.locator('#calendar')).toContainText('Alex Morgan');
  await page.getByRole('button',{name:'Workbook workspace',exact:true}).click();await expect(page.locator('#wb-loaded')).toBeVisible();
  await page.screenshot({path:join(artifacts,'workbook-schedule-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(artifacts,'workbook-schedule-mobile.png'),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2),'The page should not overflow horizontally; the calendar has its own scroll region.');
  await page.getByRole('button',{name:/Review queue/}).click();await page.locator('#wb-review-type').selectOption('strikethrough');await page.locator('#wb-review-state').selectOption('reviewed');await page.locator(`[data-issue="${strike.entryIssue}"]`).click();
  await page.locator('#wb-review-form textarea').fill('Browser test: reopen after verifying the review workflow.');await page.getByRole('button',{name:'Reopen this item',exact:true}).click();await expect(page.locator('#wb-dialog')).not.toBeVisible();
  saved=await (await page.request.get(`${base}/api/imports/${id}`)).json();assert.equal(saved.decisions[strike.entryIssue],undefined);assert.equal(saved.revision,5);
  console.log('PASS mobile viewport, preserved demo workspace, and reopening review.');

  const dbPath=join(directory,'workspace.sqlite');await app.close();app=createApp({dbPath});await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  await page.reload();await expect(page.locator('#wb-loaded')).toBeVisible({timeout:10000});saved=await (await page.request.get(`${base}/api/imports/${id}`)).json();assert.equal(saved.revision,5);assert.equal(saved.decisions[alias.id].staffId,person.id);
  assert.deepEqual(failures,[]);assert.equal(createHash('sha256').update(await readFile(workbookPath)).digest('hex'),sourceHash);
  console.log('PASS server restart: workbook and decisions persist; no browser exceptions; source workbook unchanged.');
} catch(error) { console.error(error);const page=browser?.contexts()[0]?.pages()[0];if(page)await page.screenshot({path:join(artifacts,'browser-failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1; }
finally {
  await browser?.close();await app.close();
  assert(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('schedule-browser-'));
  await rm(directory,{recursive:true,force:true});
}
