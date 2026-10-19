import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { parseWorkbook, MAX_UPLOAD } from './workbook-import.js';
import { materialize, validateDecision } from './workbook-model.js';
import { createStore } from './workbook-store.js';
import { smallWorkbook, workbookPath, hasWorkbook } from './test-fixture.js';

test('raw import keeps all sheets, hidden notes, styles and formulas without assigning sidebars',async()=>{
  const w=await parseWorkbook(await smallWorkbook(),'fixture.xlsx');
  assert.equal(w.sheets.length,4);assert.equal(w.stats.uniqueDates,2);assert.equal(w.stats.dateRows,3);assert.equal(w.stats.formulas,2);
  assert.equal(w.stats.strikethrough,1);assert(w.sheets.at(-1).cells.some(c=>c.address==='A100'&&c.value.includes('<img')));
  assert(w.records.every(r=>r.address!=='O3'));assert(w.issues.some(i=>i.type==='overlap'));
  const r=materialize(w).records.find(r=>r.sheet==='2026 Sch'&&r.address==='B3');assert.equal(r.status,'review');
  assert.equal(materialize(w).records.filter(r=>r.date==='2026-01-01'&&r.service==='G20').length,1);
});
test('reviews map identities, interpret entries, choose sources, and leave audit source unchanged',async()=>{
  const w=await parseWorkbook(await smallWorkbook(),'fixture.xlsx'), decisions={};
  const alias=w.issues.find(i=>i.type==='identity'),person=w.staff.find(p=>p.name==='Villamizar Rosales');
  decisions[alias.id]=validateDecision(w,decisions,alias.id,{action:'identify',staffId:person.id,note:'Confirmed full name'});
  const overlap=w.issues.find(i=>i.type==='overlap');decisions[overlap.id]=validateDecision(w,decisions,overlap.id,{action:'source',sheet:'2026 Sch',note:'Current year source'});
  const strike=w.issues.find(i=>i.type==='strikethrough');decisions[strike.id]=validateDecision(w,decisions,strike.id,{action:'exclude',note:'Cancelled in source'});
  const records=materialize(w,decisions).records;assert.equal(records.find(r=>r.address==='B3').status,'excluded');assert.deepEqual(records.find(r=>r.address==='C3').people,[person.id]);
  assert.equal(w.records.find(r=>r.address==='B3').raw,'Lee');assert.equal(w.records.find(r=>r.address==='B3').strike,true);
  assert.throws(()=>validateDecision(w,decisions,alias.id,{action:'identify',staffId:'made-up',note:'test'}));
  assert.throws(()=>validateDecision(w,decisions,strike.id,{action:'include',people:[person.id],service:'G20',period:'unknown',classification:'unspecified',note:'test'}));
  assert.throws(()=>validateDecision(w,decisions,strike.id,{action:'exclude',note:''}));
});
test('SQLite import is idempotent and reviews persist with stale-write rejection and reopen audit',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'schedule-store-')),path=join(dir,'test.sqlite'),bytes=await smallWorkbook();let store;
  try {
    const w=await parseWorkbook(bytes,'fixture.xlsx');store=createStore(path);assert.equal(store.import(w,bytes).duplicate,false);
    const issue=w.issues.find(i=>i.type==='strikethrough');const saved=store.review(w.hash,issue.id,0,{action:'exclude',note:'Test reason'});assert.equal(saved.revision,1);
    assert.throws(()=>store.review(w.hash,issue.id,0,{action:'reopen',note:'Stale tab'}),error=>error.status===409);
    assert.equal(store.import(w,bytes).duplicate,true);assert.equal(store.list().length,1);store.close();store=createStore(path);
    assert.equal(store.get(w.hash).decisions[issue.id].action,'exclude');assert.equal(store.get(w.hash).revision,1);
    assert.deepEqual(Buffer.from(store.original(w.hash)),bytes);store.review(w.hash,issue.id,1,{action:'reopen',note:'Revisit'});
    assert.equal(store.get(w.hash).decisions[issue.id],undefined);assert.equal(store.events(w.hash).length,2);
  } finally {store?.close();assert(resolve(dir).startsWith(resolve(tmpdir())+sep)&&basename(dir).startsWith('schedule-store-'));await rm(dir,{recursive:true,force:true});}
});
test('rejects invalid and oversized files without interpreting them as workbooks',async()=>{
  await assert.rejects(parseWorkbook(Buffer.from('not a zip'),'bad.xlsx'),/archive/i);
  await assert.rejects(parseWorkbook(Buffer.from('x'),'bad.xlsm'),/xlsx/);
  await assert.rejects(parseWorkbook(Buffer.alloc(MAX_UPLOAD+1),'large.xlsx'),/10 MB/);
});
test('real workbook matches all ten sheets and the independently audited source counts',{skip:!hasWorkbook},async()=>{
  const w=await parseWorkbook(await readFile(workbookPath),'MASTER_NEW_CALENDAR_NICU_Staff_SCHEDULE 2.xlsx');
  assert.equal(w.hash,'e1c97bf4ff21db8deeee887ea0c49ea6470dcab858f45e4091130940c1a3cfde');
  assert.deepEqual([w.stats.sheets,w.stats.cells,w.stats.formulas,w.stats.strikethrough,w.stats.dateRows,w.stats.uniqueDates],[10,6503,497,53,737,733]);
  assert.equal(w.issues.filter(i=>i.type==='overlap').length,4);assert.equal(w.issues.filter(i=>i.type==='strikethrough').length,53);
  assert.equal(w.swaps.filter(s=>!s.example).length,18);assert(w.swaps.some(s=>s.sources.some(id=>w.sheets.find(s=>s.name==='Swap Tracker').cells.find(c=>c.id===id)?.address==='B13')));
  assert.equal(w.sheets.find(s=>s.name==='2025 First Half').cells.find(c=>c.address==='G333').disposition,'source note');
  assert(w.sheets.find(s=>s.name==='Moonligiting avaibility ').cells.length===16);
  const annual=w.targets.filter(t=>t.sheet==='Staff 2026 #s');assert.equal(annual.length,16);assert.equal(annual.reduce((n,t)=>n+t.weeks,0),243);assert.equal(annual.reduce((n,t)=>n+t.weekends,0),148);
  assert.equal(annual.reduce((n,t)=>n+t.reportedWeeks,0),221);assert.equal(annual.reduce((n,t)=>n+t.reportedWeekends,0),134);
  assert(w.issues.some(i=>i.title==='Target total excludes listed staff'));assert(w.issues.some(i=>i.title==='Night block conversions disagree'));
  const records=materialize(w).records;assert(records.filter(r=>r.strike).every(r=>r.status==='review'));assert.equal(records.find(r=>r.sheet==='2026 Sch'&&r.address==='E244').status,'review');
  assert(records.every(r=>!('start' in r)&&!('end' in r)));assert.equal(w.sheets.reduce((n,s)=>n+s.cells.filter(c=>c.disposition).length,0),6503);
});
