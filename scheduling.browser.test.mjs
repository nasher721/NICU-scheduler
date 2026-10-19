import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from './server.js';
import { reviewGroups, creditLedger, candidates, scheduleView } from './scheduling.js';
import { workbookPath, hasWorkbook } from './test-fixture.js';

if(!hasWorkbook)throw new Error('The actual audited workbook is required. Set WORKBOOK_FIXTURE.');
const directory=await mkdtemp(join(tmpdir(),'scheduling-browser-')),dbPath=join(directory,'workspace.sqlite'),artifacts=resolve('test-results');
await mkdir(artifacts,{recursive:true});
let app=createApp({dbPath}),browser;
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const port=app.server.address().port,base='http://127.0.0.1:'+port,errors=[],originalHash=createHash('sha256').update(await readFile(workbookPath)).digest('hex');
try{
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':'chromium')});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});context.setDefaultTimeout(15000);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.locator('#wb-file').setInputFiles(workbookPath);await page.getByRole('button',{name:'Import workbook',exact:true}).click();await expect(page.locator('#wb-loaded')).toBeVisible({timeout:30000});
  const id=(await(await page.request.get(base+'/api/imports')).json()).imports[0].id;
  const load=async()=>await(await page.request.get(`${base}/api/imports/${id}`)).json();
  let saved=await load();
  assert.equal(saved.revision,0);await page.getByRole('button',{name:'Clinical credits',exact:true}).click();await expect(page.locator('#wb-content')).toContainText('No day-to-credit conversion is approved');
  await expect(page.locator('#wb-credit-table')).toContainText('243');await expect(page.locator('#wb-credit-table')).toContainText('221');
  await page.getByRole('button',{name:'Scheduling assistance',exact:true}).click();await page.locator('#wb-proposal select[name="comparisonCategory"]').selectOption('g20');await page.getByRole('button',{name:'Compare candidates',exact:true}).click();await expect(page.locator('#wb-candidates')).toContainText('Imported reported ledger; not recomputed');
  await page.getByRole('button',{name:/Review queue/}).click();
  async function applyGroup(group) {
    const before=await load(),count=Object.keys(before.decisions).length;
    await page.locator('.wb-review-groups > details > summary').click();
    const index=reviewGroups(before).findIndex(g=>g.key===group.key);assert(index>=0);
    await page.locator(`[data-review-group="${index}"]`).click();
    await expect(page.locator('#wb-group-form input[name="items"]')).toHaveCount(group.items.length);
    await page.locator('#wb-group-form textarea').fill('Isolated browser test approval: '+group.title);
    await page.getByRole('button',{name:'Apply selected decisions',exact:true}).click();await expect(page.locator('#wb-dialog')).not.toBeVisible();
    const after=await load();assert.equal(after.revision,before.revision+1);assert.equal(Object.keys(after.decisions).length,count+group.items.length);return after;
  }
  saved=await applyGroup(reviewGroups(saved).find(g=>g.key==='aliases'));
  for(const group of reviewGroups(saved).filter(g=>g.key.startsWith('strike:')))saved=await applyGroup(group);
  saved=await applyGroup(reviewGroups(saved).find(g=>g.key==='overlap'));
  const availability=reviewGroups(saved).find(g=>g.key.startsWith('availability:Vacations:'));assert(availability);
  saved=await applyGroup(availability);
  assert.equal(saved.workbook.issues.length,270);assert.equal(Object.keys(saved.decisions).length,62+availability.items.length);
  console.log(`PASS grouped reviews: ${Object.keys(saved.decisions).length} individually audited decisions saved in six atomic groups.`);

  // Explicit credit is useful even while every general conversion remains pending.
  const explicitRecord=scheduleView(saved).records.find(r=>r.date.startsWith('2026-')&&r.service==='G20'&&r.people.length===1&&!['review','excluded'].includes(r.status));assert(explicitRecord);
  await page.getByRole('button',{name:'Clinical credits',exact:true}).click();await page.getByRole('button',{name:'Approve credit for specific dates',exact:true}).click();
  await page.locator('#wb-explicit-credit-form select[name="staffId"]').selectOption(explicitRecord.people[0]);
  await page.locator('#wb-explicit-credit-form input[name="from"]').fill(explicitRecord.date);await page.locator('#wb-explicit-credit-form input[name="to"]').fill(explicitRecord.date);
  await page.locator(`#wb-explicit-credit-form input[name="recordIds"][value="${explicitRecord.id}"]`).check();
  await page.locator('#wb-explicit-credit-form input[name="quantity"]').fill('0.35');await page.locator('#wb-explicit-credit-form textarea').fill('ISOLATED TEST ONLY: approve .35 weeks for this exact source; all general conversions remain pending.');
  await page.locator('#wb-explicit-credit-form input[name="confirm"]').check();await page.getByRole('button',{name:'Save explicit credit approval',exact:true}).click();await expect(page.locator('#wb-dialog')).not.toBeVisible();
  saved=await load();assert.equal(Object.keys(saved.workspace.policies).length,0);const manualApproval=Object.values(saved.workspace.credits)[0];assert(manualApproval);assert.equal(creditLedger(saved,2026).rows.find(r=>r.staffId===explicitRecord.people[0]).scheduledWeeks,.35);
  await expect(page.locator('#wb-content')).toContainText('0 approved category conversions · 1 explicit block approvals');
  console.log('PASS explicit credit with conversions pending: .35 weeks booked for a selected source date with provenance.');

  await page.getByRole('button',{name:'Clinical credits',exact:true}).click();await page.getByRole('button',{name:'Configure credit rules',exact:true}).click();
  for(const [category,rate] of [['g20','5'],['mainWeekends','2'],['weekdayNights','3'],['weekendNights','4']]){
    await page.locator(`#wb-policy-form input[name="rule"][value="${category}"]`).check();await page.locator(`[name="rate-${category}"]`).fill(rate);
  }
  for(const day of [1,2,3])await page.locator(`[name="days-weekdayNights"][value="${day}"]`).check();
  for(const day of [0,4,5,6])await page.locator(`[name="days-weekendNights"][value="${day}"]`).check();
  await page.locator('#wb-policy-form textarea').fill('ISOLATED TEST ONLY: approve weekday G20 /5, weekend /2, night Mon–Wed /3 and Thu–Sun /4. Not department policy.');
  await page.locator('#wb-policy-form input[name="confirm"]').check();await page.getByRole('button',{name:'Save approved credit rules',exact:true}).click();await expect(page.locator('#wb-dialog')).not.toBeVisible();
  saved=await load();assert.equal(saved.workspace.policies[2026].rules.length,4);await expect(page.locator('#wb-content')).toContainText('4 approved category conversions');
  assert(!creditLedger(saved,2026).details.some(d=>!d.explicit&&d.recordId===explicitRecord.id));

  // Source B243 is a Saturday split; the explicit 50/50 allocation yields .25 weekend units each.
  const split=saved.workbook.records.find(r=>r.sheet==='2026 Sch'&&r.address==='B243');
  await page.getByRole('button',{name:/Review queue/}).click();await page.locator('#wb-review-search').fill('Gosami/Bolt');
  await page.locator(`[data-issue="${split.entryIssue}"]`).click();await page.locator('#wb-review-form select[name="action"]').selectOption('include');
  const participants=saved.workbook.staff.filter(p=>['Goswami','Bolt'].includes(p.name));
  for(const p of participants)await page.locator(`#wb-review-form input[name="people"][value="${p.id}"]`).check();
  await page.locator('#wb-review-form details').filter({hasText:'Optional split credit allocation'}).locator('summary').click();
  for(const p of participants)await page.locator(`[name="share-${p.id}"]`).fill('0.5');
  await page.locator('#wb-review-form textarea').fill('ISOLATED TEST ONLY: two participants, half of the source date each.');
  await page.getByRole('button',{name:'Save review',exact:true}).click();await expect(page.locator('#wb-dialog')).not.toBeVisible();
  saved=await load();const splitDetails=creditLedger(saved,2026).details.filter(d=>d.recordId===split.id);assert.equal(splitDetails.length,2);assert(splitDetails.every(d=>d.obligation===.25));
  console.log('PASS clinical credit: four explicit rules, split Saturday credits .25 + .25, no automatic night/partial policy adoption.');

  const proposed={date:'2026-12-15',service:'G20',period:'day',classification:'unspecified'};
  const candidate=candidates(saved,proposed).find(c=>!c.blocked.length);assert(candidate);
  await page.getByRole('button',{name:'Scheduling assistance',exact:true}).click();await page.getByRole('button',{name:'Confirm staff eligibility / active dates',exact:true}).click();
  await page.locator('#wb-profile-form select[name="staffId"]').selectOption(candidate.staffId);
  await page.locator('#wb-profile-form input[name="from"]').fill('2026-01-01');await page.locator('#wb-profile-form input[name="to"]').fill('2026-12-31');
  await page.locator('#wb-profile-form input[name="services"][value="G20"]').check();await page.locator('#wb-profile-form textarea').fill('ISOLATED TEST ONLY: confirmed active interval and G20 eligibility.');
  await page.getByRole('button',{name:'Save eligibility profile',exact:true}).click();await expect(page.locator('#wb-dialog')).not.toBeVisible();
  await page.locator('#wb-proposal input[name="date"]').fill(proposed.date);await page.getByRole('button',{name:'Compare candidates',exact:true}).click();
  await page.locator(`[data-candidate="${candidate.staffId}"]`).click();await expect(page.locator('#wb-draft-form')).toContainText('Exact shift overlap');
  await page.locator('#wb-draft-form textarea').fill('ISOLATED TEST ONLY: reviewed timing checks before adding draft coverage.');await page.locator('#wb-draft-form input[name="acknowledge"]').check();
  const before=await load(),beforeCredit=creditLedger(before,2026).rows.find(r=>r.staffId===candidate.staffId).scheduledWeeks;
  await page.getByRole('button',{name:'Save draft assignment',exact:true}).click();await expect(page.locator('#wb-message')).toContainText('Draft saved');
  saved=await load();const draft=Object.values(saved.workspace.drafts)[0];assert(draft);assert(Math.abs(creditLedger(saved,2026).rows.find(r=>r.staffId===candidate.staffId).scheduledWeeks-beforeCredit-.2)<1e-8);
  await page.getByRole('button',{name:'Schedule',exact:true}).click();await page.locator('#wb-date').fill(proposed.date);await page.locator('#wb-date').press('Tab');await expect(page.locator(`[data-record="${draft.id}"]`)).toContainText('App draft');
  await page.locator(`[data-record="${draft.id}"]`).click();await page.getByRole('button',{name:'Remove app draft / restore source',exact:true}).click();
  await page.locator('#wb-remove-form textarea').fill('Isolated test: remove proposed coverage');await page.getByRole('button',{name:'Remove draft',exact:true}).click();await expect(page.locator('#wb-dialog')).not.toBeVisible();
  saved=await load();assert.equal(Object.keys(saved.workspace.drafts).length,0);assert(Math.abs(creditLedger(saved,2026).rows.find(r=>r.staffId===candidate.staffId).scheduledWeeks-beforeCredit)<1e-8);
  console.log('PASS scheduling assistance: eligible candidate selected, unknown checks acknowledged, saved draft adds .2 credit, removal reverses it.');

  const leaveRecord=saved.workbook.records.find(r=>availability.items.some(i=>i.issueId===r.entryIssue));
  await page.getByRole('button',{name:'Scheduling assistance',exact:true}).click();await page.locator('#wb-proposal input[name="date"]').fill(leaveRecord.date);await page.getByRole('button',{name:'Compare candidates',exact:true}).click();
  await expect(page.locator(`[data-candidate="${availability.items[0].decision.people[0]}"]`)).toBeDisabled();await expect(page.locator('#wb-candidates')).toContainText('Confirmed Vacations');

  // Replace a resolved imported G20 source, keeping its cell and restoring it on removal.
  const source=scheduleView(saved).records.find(r=>r.date==='2026-12-15'&&r.service==='G20'&&r.status!=='review');assert(source);
  await page.getByRole('button',{name:'Schedule',exact:true}).click();await page.locator('#wb-date').fill(source.date);await page.locator('#wb-date').press('Tab');await page.locator(`[data-record="${source.id}"]`).click();await page.getByRole('button',{name:'Compare replacements',exact:true}).click();
  await page.getByRole('button',{name:'Compare candidates',exact:true}).click();
  const replacement=candidates(await load(),{date:source.date,service:source.service,period:source.period,classification:source.classification,sourceId:source.id}).find(c=>!c.blocked.length&&!source.people.includes(c.staffId));assert(replacement);
  await page.locator(`[data-candidate="${replacement.staffId}"]`).click();await page.locator('#wb-draft-form textarea').fill('Isolated test: source replacement with warning review.');await page.locator('#wb-draft-form input[name="acknowledge"]').check();await page.getByRole('button',{name:'Save draft assignment',exact:true}).click();await expect(page.locator('#wb-message')).toContainText('Draft saved');
  saved=await load();assert.equal(saved.workspace.drafts[source.id].sourceId,source.id);assert.deepEqual(saved.workbook.records.find(r=>r.id===source.id).people,source.people);
  await page.getByRole('button',{name:'Clinical credits',exact:true}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export credit evidence',exact:true}).click();const exported=JSON.parse(await readFile(await(await download).path(),'utf8'));assert.equal(exported.revision,saved.revision);assert(exported.details.some(d=>d.recordId===source.id&&d.staffId===replacement.staffId&&d.draft));
  await page.screenshot({path:join(artifacts,'clinical-credit-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(artifacts,'clinical-credit-mobile.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2));
  await page.getByRole('button',{name:/Review queue/}).click();await page.screenshot({path:join(artifacts,'grouped-review-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'Scheduling assistance',exact:true}).click();await page.screenshot({path:join(artifacts,'scheduling-assistance-desktop.png'),fullPage:true});
  await page.locator('#wb-file').setInputFiles(workbookPath);await page.getByRole('button',{name:'Import workbook',exact:true}).click();await expect(page.locator('#wb-message')).toContainText('already imported',{timeout:30000});assert.deepEqual((await load()).workspace,saved.workspace);
  await browser.close();browser=null;await app.close();app=createApp({dbPath});await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':'chromium')});const restartedPage=await browser.newPage();restartedPage.on('pageerror',error=>errors.push(error.message));await restartedPage.goto(base);await expect(restartedPage.locator('#wb-loaded')).toBeVisible();const restored=await(await restartedPage.request.get(`${base}/api/imports/${id}`)).json();assert.deepEqual(restored.workspace,saved.workspace);
  const beforeRemoval=creditLedger(restored,2026).rows.find(r=>r.staffId===manualApproval.staffId).scheduledWeeks;
  await restartedPage.getByRole('button',{name:'Clinical credits',exact:true}).click();await restartedPage.locator(`[data-credit-approval="${manualApproval.id}"]`).click();await expect(restartedPage.locator('#wb-dialog-body')).toContainText('0.35 weeks');
  await restartedPage.locator('#wb-credit-remove-form textarea').fill('Isolated test: withdraw explicit approval and restore daily-rate calculation.');await restartedPage.getByRole('button',{name:'Remove credit approval',exact:true}).click();await expect(restartedPage.locator('#wb-dialog')).not.toBeVisible();
  const afterRemoval=await(await restartedPage.request.get(`${base}/api/imports/${id}`)).json();assert.equal(Object.keys(afterRemoval.workspace.credits).length,0);assert(Math.abs(creditLedger(afterRemoval,2026).rows.find(r=>r.staffId===manualApproval.staffId).scheduledWeeks-beforeRemoval+.15)<1e-8);
  assert.deepEqual(errors,[]);assert.equal(createHash('sha256').update(await readFile(workbookPath)).digest('hex'),originalHash);
  console.log('PASS confirmed-leave blocking, source replacement, evidence export, mobile layout, duplicate import, restart persistence, unchanged source and no browser exceptions.');
}catch(error){console.error(error);const page=browser?.contexts()[0]?.pages()[0];if(page)await page.screenshot({path:join(artifacts,'scheduling-browser-failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await browser?.close();await app.close();assert(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('scheduling-browser-'));await rm(directory,{recursive:true,force:true});}
