import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkbook } from './workbook-import.js';
import { createStore } from './workbook-store.js';
import { createApp } from './server.js';
import { validateDecision } from './workbook-model.js';
import { creditLedger, candidates, validatePolicy, validateDraft, validateCredit, reviewGroups, parsePeople, scheduleView, emptyWorkspace } from './scheduling.js';
import { workbookPath, hasWorkbook } from './test-fixture.js';

const p1='a'.repeat(24),p2='b'.repeat(24),approx=(a,b)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function fixture() {
  const w={hash:'c'.repeat(64),filename:'credits.xlsx',staff:[{id:p1,name:'Lee'},{id:p2,name:'Villamizar Rosales'}],issues:[],records:[],targets:[{staffId:p1,sheet:'Staff 2026 #s',weeks:10,weekends:4,reportedWeeks:3,reportedWeekends:2,sources:['name1']}],sheets:[{name:'Staff 2026 #s',cells:[{id:'name1',row:3,col:1,value:'Lee'},...Array.from({length:8},(_,i)=>({id:'component'+i,row:3,col:i+2,value:i+1}))]}]};
  const add=(id,date,service,people=[p1],other={})=>w.records.push({id,sourceId:id,date,service,kind:service==='Vacations'?'availability':'assignment',people,raw:people.map(id=>w.staff.find(p=>p.id===id).name).join(' & '),issues:[],period:'unspecified',classification:'unspecified',sheet:'2026 Sch',address:id,...other});
  for(let day=5;day<=9;day++)add('weekday'+day,'2026-01-0'+day,'G20');
  add('sat','2026-01-10','G20');add('sun','2026-01-11','G20');
  add('split','2026-01-12','G20',[p1,p2],{shares:[.25,.75]});
  add('paid','2026-01-15','G20',[p2],{classification:'moonlighting'});
  add('cdi','2026-01-16','CDI');add('old','2025-12-31','G20');add('future','2027-01-01','G20');
  add('unallocated','2026-01-19','G20',[p1,p2]);
  add('unresolved','2026-01-20','G20',[p1],{issues:['issue'],entryIssue:'issue'});
  w.issues.push({id:'issue',type:'strikethrough',recordId:'unresolved',sources:[]});
  add('night','2026-01-05','Nights',[p2]);add('weekendnight','2026-01-09','Nights',[p2]);
  return {id:w.hash,revision:0,workbook:w,decisions:{},workspace:emptyWorkspace()};
}
const rules=[{category:'g20',days:[1,2,3,4,5],daysPerCredit:5,moonlightingCredit:false},{category:'mainWeekends',days:[0,6],daysPerCredit:2,moonlightingCredit:false},{category:'weekdayNights',days:[1,2,3],daysPerCredit:3,moonlightingCredit:false},{category:'weekendNights',days:[4,5,6,0],daysPerCredit:4,moonlightingCredit:false}];

test('ledger uses approved rates, partial shares, explicit night weekdays and year scope; unresolved entries never earn credit',()=>{
  const s=fixture();assert.equal(creditLedger(s,2026).rows[0].remainingWeeks,null);
  s.workspace.policies[2026]=validatePolicy(s.workbook,{year:2026,rules,note:'Test approval of calendar-day fractions and night categories'});
  const ledger=creditLedger(s,2026),lee=ledger.rows.find(r=>r.staffId===p1),rosales=ledger.rows.find(r=>r.staffId===p2);
  approx(lee.scheduledWeeks,1.05);approx(lee.scheduledWeekends,1);approx(rosales.scheduledWeeks,.15+1/3);approx(rosales.scheduledWeekends,.25);
  approx(rosales.moonlightingWeeks,.2);approx(lee.remainingWeeks,8.95);
  assert.equal(lee.exposure.CDI,1);assert.equal(lee.reported.akronWeekends,7);assert.equal(ledger.unvalued.length,2);
  assert(!ledger.details.some(d=>['old','future','unresolved','unallocated'].includes(d.recordId)));
  assert.equal(ledger.details.find(d=>d.recordId==='paid').obligation,0);
  s.decisions.issue={action:'exclude',note:'Cancelled'};assert.equal(creditLedger(s,2026).unvalued.length,1);
  assert.throws(()=>validatePolicy(s.workbook,{year:2026,rules:[rules[0],{...rules[1],days:[1]}],note:'Invalid overlap'}),/two categories/);
  assert.throws(()=>validatePolicy(s.workbook,{year:2026,rules:[{...rules[0],daysPerCredit:0}],note:'Invalid'}));
  assert.throws(()=>validatePolicy(s.workbook,{year:2026,rules:[{...rules[0],days:[1,1]}],note:'Invalid'}));
  s.workbook.records.push({...s.workbook.records[0],id:'duplicate',sourceId:'duplicate'});
  const duplicate=creditLedger(s,2026);assert(!duplicate.details.some(d=>['duplicate','weekday5'].includes(d.recordId)));assert(duplicate.unvalued.some(i=>i.reason.includes('Duplicate')));
  s.workbook.records.find(r=>r.id==='night').period='home call';assert(!creditLedger(s,2026).details.some(d=>d.recordId==='night'));
});

test('split review requires positive shares summing to one and identities can represent several real people',()=>{
  const s=fixture(),w=s.workbook;w.issues.push({id:'identity',type:'identity'});
  assert.deepEqual(validateDecision(w,{},'identity',{action:'identify',people:[p1,p2],note:'Two distinct people'}).people,[p1,p2]);
  const decision={action:'include',people:[p1,p2],service:'G20',period:'day',classification:'unspecified',note:'Split cover',shares:[.5,.5]};
  assert.deepEqual(validateDecision(w,{},'issue',decision).shares,[.5,.5]);
  for(const shares of [[1,1],[0,1],[.2],[.5,NaN]])assert.throws(()=>validateDecision(w,{},'issue',{...decision,shares}));
  assert.equal(parsePeople('Lee & Villamizar Rosales',w).complete,true);
  assert.equal(parsePeople('Lee & unknown',w).complete,false);
});

test('explicit scoped credit works with conversions pending, prevents double credit and invalidates when source evidence changes',()=>{
  const s=fixture(),input={year:2026,category:'g20',staffId:p1,recordIds:['weekday5','weekday6','weekday7','weekday8','weekday9'],quantity:.75,countsTowardObligation:true,confirm:true,note:'Clinically approved .75-week block, not a general daily rate'};
  const approval=validateCredit(s,input);approval.id='credit-test';s.workspace.credits[approval.id]=approval;
  let ledger=creditLedger(s,2026);assert.equal(ledger.policy,null);assert.equal(ledger.approved.length,1);approx(ledger.rows[0].scheduledWeeks,.75);approx(ledger.rows[0].remainingWeeks,9.25);
  const comparison=candidates(s,{date:'2026-01-22',service:'G20',period:'day',classification:'unspecified',comparisonCategory:'g20'}).find(c=>c.staffId===p1);approx(comparison.remaining,9.25);assert.equal(comparison.impact,null);
  assert(!ledger.unvalued.some(i=>input.recordIds.includes(i.record.id)));assert.throws(()=>validateCredit(s,input),/already has/);
  s.workspace.policies[2026]=validatePolicy(s.workbook,{year:2026,rules,note:'Separate test approval of daily rates'});
  ledger=creditLedger(s,2026);approx(ledger.rows[0].scheduledWeeks,.8);assert.equal(ledger.details.filter(d=>d.explicit).length,1);assert(!ledger.details.some(d=>!d.explicit&&input.recordIds.includes(d.recordId)));
  const changed=structuredClone(s);changed.workbook.records.find(r=>r.id==='weekday5').people=[p2];assert.equal(creditLedger(changed,2026).invalidApprovals.length,1);
  assert.throws(()=>validateCredit(fixture(),{...input,quantity:6}),/quantity/);
  assert.throws(()=>validateCredit(fixture(),{...input,recordIds:['unresolved']}),/reviewed/);
  assert.throws(()=>validateCredit(fixture(),{...input,countsTowardObligation:false}),/moonlighting/);
  assert.throws(()=>validateCredit(fixture(),{...input,confirm:false}),/Explicitly approve/);
  assert.throws(()=>validateCredit(fixture(),{...input,recordIds:['unallocated'],quantity:.25}),/participant shares/);
});

test('explicit approvals and individual strikethrough preference persist with audit and reject bulk cancellation',()=>{
  const s=fixture(),w=s.workbook;w.issues.push({id:'issue2',type:'strikethrough',sources:[]});const store=createStore(':memory:');
  try{
    store.import(w,Buffer.from('source'));store.updateWorkspace(w.hash,0,{kind:'reviewPreferences',input:{strikes:'individual',note:'Scheduler requested individual review'}});
    assert.throws(()=>store.reviewMany(w.hash,1,['issue','issue2'].map(issueId=>({issueId,decision:{action:'exclude',note:'Not allowed as a batch'}}))),/one at a time/);
    assert.equal(store.get(w.hash).revision,1);assert.equal(store.events(w.hash).length,0);
    assert(!reviewGroups(store.get(w.hash)).some(g=>g.key.startsWith('strike:')));
    let saved=store.updateWorkspace(w.hash,1,{kind:'credit',input:{year:2026,category:'g20',staffId:p1,recordIds:['weekday5'],quantity:.2,countsTowardObligation:true,confirm:true,note:'Explicit approved date credit'}});
    const credit=Object.values(saved.workspace.credits)[0];assert.equal(creditLedger(saved,2026).rows[0].scheduledWeeks,.2);assert.equal(store.workspaceEvents(w.hash).length,2);
    assert.equal(store.import(w,Buffer.from('source')).workspace.credits[credit.id].quantity,.2);
    saved=store.updateWorkspace(w.hash,2,{kind:'removeCredit',input:{id:credit.id,note:'Withdraw approval'}});assert.equal(creditLedger(saved,2026).hasCredit,false);assert.equal(store.workspaceEvents(w.hash).length,3);
  }finally{store.close();}
});

test('assistance blocks confirmed leave, inactive dates, ineligible services and duplicate work; unknown policy remains explicit',()=>{
  const s=fixture(),proposal={date:'2026-01-21',service:'G20',period:'day',classification:'unspecified'};
  let result=candidates(s,proposal).find(c=>c.staffId===p1);assert.equal(result.blocked.length,0);assert(result.warnings.some(w=>w.includes('eligibility')));
  const sourceComparison=candidates(s,{...proposal,comparisonCategory:'g20'}).find(c=>c.staffId===p1);assert.equal(sourceComparison.remaining,7);assert.equal(sourceComparison.impact,null);assert(sourceComparison.remainingBasis.includes('Imported reported'));
  s.workspace.profiles[p1]={from:'2026-01-01',to:'2026-12-31',services:['G20']};
  s.workbook.records.push({id:'leave',date:proposal.date,service:'Vacations',kind:'availability',people:[p1],raw:'Lee',issues:[],period:'unspecified',classification:'unspecified'});
  result=candidates(s,proposal).find(c=>c.staffId===p1);assert(result.blocked.some(w=>w.includes('Vacations')));
  assert.throws(()=>validateDraft(s,{...proposal,staffId:p1,note:'No override allowed',acknowledgeWarnings:true}),/Vacations/);
  assert(candidates(s,{...proposal,service:'Nights'}).find(c=>c.staffId===p1).blocked.some(w=>w.includes('eligibility')));
  assert(candidates(s,{...proposal,date:'2027-01-21'}).find(c=>c.staffId===p1).blocked.some(w=>w.includes('active')));
  assert(candidates(s,{...proposal,date:'2026-01-05'}).find(c=>c.staffId===p1).blocked.some(w=>w.includes('Already assigned')));
  assert.throws(()=>validateDraft(s,{...proposal,staffId:p2,note:'Missing acknowledgement'}),/acknowledge/);
  assert.equal(validateDraft(s,{...proposal,staffId:p2,note:'Reviewed incomplete checks',acknowledgeWarnings:true}).staffId,p2);
  assert.throws(()=>candidates(s,{...proposal,date:'2026-02-30'}),/valid date/);
  assert.throws(()=>validateDraft(s,{...proposal,id:'__proto__',staffId:p2,note:'Bad identifier',acknowledgeWarnings:true}));
});

test('batch review rollback, revision conflicts, durable rules/drafts and source restoration share one audit boundary',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'scheduling-phase2-')),path=join(directory,'workspace.sqlite');let store;
  try{
    const s=fixture(),w=s.workbook;store=createStore(path);store.import(w,Buffer.from('original'));
    assert.throws(()=>store.reviewMany(w.hash,0,[{issueId:'issue',decision:{action:'exclude',note:'Valid'}},{issueId:'missing',decision:{action:'exclude',note:'Invalid'}}]));
    assert.equal(store.get(w.hash).revision,0);assert.equal(store.events(w.hash).length,0);
    store.updateWorkspace(w.hash,0,{kind:'policy',input:{year:2026,rules,note:'Approved test rules'}});
    assert.throws(()=>store.review(w.hash,'issue',0,{action:'exclude',note:'Stale'}),e=>e.status===409);
    let current=store.updateWorkspace(w.hash,1,{kind:'draft',input:{sourceId:'weekday5',date:'2026-01-05',service:'G20',period:'day',classification:'unspecified',staffId:p2,note:'Replace source with an app draft',acknowledgeWarnings:true}});
    assert.equal(scheduleView(current).records.find(r=>r.id==='weekday5').people[0],p2);approx(creditLedger(current,2026).rows.find(r=>r.staffId===p1).scheduledWeeks,.85);
    assert.equal(w.records.find(r=>r.id==='weekday5').people[0],p1);
    store.close();store=createStore(path);current=store.get(w.hash);assert.equal(current.revision,2);assert.equal(store.workspaceEvents(w.hash).length,2);
    assert.equal(store.import(w,Buffer.from('original')).workspace.policies[2026].rules.length,4);
    const changed=structuredClone(current);changed.workspace.profiles[p2]={from:'2026-01-01',to:'2026-12-31',services:['Nights']};
    assert.equal(scheduleView(changed).records.find(r=>r.id==='weekday5').status,'review');assert(!creditLedger(changed,2026).details.some(d=>d.recordId==='weekday5'));
    const reinterpreted=structuredClone(current);reinterpreted.workbook.records.find(r=>r.id==='weekday5').service='Recovery';
    assert.equal(scheduleView(reinterpreted).records.find(r=>r.id==='weekday5').status,'review');
    store.updateWorkspace(w.hash,2,{kind:'removeDraft',input:{id:'weekday5',note:'Restore original'}});current=store.get(w.hash);
    assert.equal(scheduleView(current).records.find(r=>r.id==='weekday5').people[0],p1);approx(creditLedger(current,2026).rows.find(r=>r.staffId===p1).scheduledWeeks,1.05);
  }finally{store?.close();await rm(directory,{recursive:true,force:true});}
});

test('real workbook grouped proposals preserve every unresolved ambiguity and source category totals',{skip:!hasWorkbook},async()=>{
  const w=await parseWorkbook(await readFile(workbookPath),'real.xlsx'),s={workbook:w,decisions:{},workspace:emptyWorkspace()};
  const groups=reviewGroups(s),aliases=groups.find(g=>g.key==='aliases');assert.equal(aliases.items.length,5);
  assert.equal(groups.filter(g=>g.key.startsWith('strike:')).reduce((n,g)=>n+g.items.length,0),53);
  assert.equal(groups.find(g=>g.key==='overlap').items.length,4);
  assert(groups.some(g=>g.key.startsWith('availability:')));assert(!groups.some(g=>g.items.some(i=>w.issues.find(x=>x.id===i.issueId)?.label==='Mutaz')));
  assert.equal(Object.keys(s.decisions).length,0);
  const ledger=creditLedger(s,2026);assert.equal(ledger.rows.reduce((n,r)=>n+(r.reportedWeeks??0),0),221);assert.equal(ledger.rows.reduce((n,r)=>n+(r.targetWeeks??0),0),243);
  assert(ledger.rows.every(r=>r.remainingWeeks===null));
  for(const row of ledger.rows.filter(r=>r.targetWeeks!==null))approx(['g20','h22','weekdayNights','akron','consults'].reduce((n,key)=>n+(row.reported[key]??0),0),row.reportedWeeks);
});

test('new HTTP operations enforce tokens, all-or-nothing review and stale draft rejection',async t=>{
  const app=createApp({dbPath:':memory:'});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port,{token}=await(await fetch(base+'/api/imports')).json(),s=fixture();app.store.import(s.workbook,Buffer.from('source'));
  const post=(action,data,auth=true)=>fetch(base+'/api/imports/'+s.id+'/'+action,{method:'POST',headers:auth?{'X-Workspace-Token':token}:{},body:JSON.stringify(data)});
  assert.equal((await post('workspace',{revision:0,operation:{kind:'policy',input:{year:2026,rules,note:'Approved'}}},false)).status,403);
  assert.equal((await post('reviews',{revision:0,items:[{issueId:'issue',decision:{action:'exclude',note:'Cancel'}}]})).status,200);
  assert.equal((await post('workspace',{revision:0,operation:{kind:'policy',input:{year:2026,rules,note:'Stale'}}})).status,409);
  assert.equal((await post('workspace',{revision:1,operation:{kind:'policy',input:{year:2026,rules,note:'Approved'}}})).status,200);
  const backup=await(await fetch(base+'/api/imports/'+s.id+'/backup')).json();assert.equal(backup.workspaceEvents.length,1);assert.equal(backup.events.length,1);
});
