import { materialize, activityServices, periods, reviewedStaff } from './workbook-model.js';

export const clinicalServices=activityServices.filter(s=>!['Recovery','Vacations'].includes(s));
export const creditCategories=[
  {id:'g20',label:'G20',service:'G20',col:2,unit:'weeks',days:[1,2,3,4,5]},
  {id:'h22',label:'H22',service:'H22',col:3,unit:'weeks',days:[1,2,3,4,5]},
  {id:'weekdayNights',label:'Weekday nights',service:'Nights',col:4,unit:'weeks',days:[]},
  {id:'mainWeekends',label:'Main weekends',service:'G20',col:5,unit:'weekends',days:[0,6]},
  {id:'weekendNights',label:'Weekend nights',service:'Nights',col:6,unit:'weekends',days:[]},
  {id:'akron',label:'Akron',service:'Akron',col:7,unit:'weeks',days:[1,2,3,4,5]},
  {id:'akronWeekends',label:'Akron weekends',service:'Akron',col:8,unit:'weekends',days:[0,6]},
  {id:'consults',label:'Consults',service:'Consults',col:9,unit:'weeks',days:[1,2,3,4,5]}
];
export const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const normalize=value=>String(value??'').trim().toLowerCase().replace(/\s+/g,' ');
const dayOf=date=>new Date(date+'T12:00:00Z').getUTCDay();
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
const reason=value=>{if(typeof value!=='string'||!value.trim()||value.length>2000)throw new Error('Record a reason of 1–2,000 characters.');return value.trim();};
export const emptyWorkspace=()=>({policies:{},profiles:{},drafts:{},credits:{},reviewPreferences:{strikes:'grouped'}});
export function scheduleView(snapshot) {
  const view=materialize(snapshot.workbook,snapshot.decisions), workspace=snapshot.workspace??emptyWorkspace();
  for(const draft of Object.values(workspace.drafts)) {
    const index=view.records.findIndex(r=>r.id===draft.id), source=index<0?null:view.records[index];
    const provenance=source??snapshot.workbook.records.find(r=>r.id===draft.sourceId);
    const record={...draft,kind:'assignment',people:[draft.staffId],status:'draft',raw:draft.note,issues:provenance?.issues??[],pendingIssues:source?.pendingIssues??[],sourceId:provenance?.sourceId??null,sheet:provenance?.sheet??'App draft',address:provenance?.address??'',sourceStatus:source?.status??null};
    // shortcut: a changed source invalidates its replacement; re-review before recalculating credit.
    if(draft.sourceId&&(!source||source.status==='review'||source.status==='excluded'||source.kind!=='assignment'||source.service!==draft.service||source.date!==draft.date))record.status='review';
    const profile=workspace.profiles[draft.staffId];
    if(profile&&(draft.date<profile.from||draft.date>profile.to||!profile.services.includes(draft.service))){record.status='review';record.invalidReason='The current eligibility profile no longer permits this draft.';}
    if(record.status==='review'&&!record.invalidReason)record.invalidReason='The source was reinterpreted, reopened, excluded or replaced by another authoritative sheet. Remove this draft or resolve its source.';
    if(index<0)view.records.push(record);else view.records[index]=record;
  }
  return view;
}

export function parsePeople(label,workbook,decisions={}) {
  const names=reviewedStaff(workbook,decisions).map(p=>({label:p.name,id:p.id}));
  for(const issue of workbook.issues.filter(i=>i.type==='identity')) {
    const d=decisions[issue.id];if(d?.action==='identify'&&(d.staffId||d.newPerson))names.push({label:issue.label,id:d.staffId??d.newPerson.id});
  }
  let remainder=normalize(label);const people=[];
  for(const name of names.sort((a,b)=>b.label.length-a.label.length)) {
    const escaped=normalize(name.label).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const pattern=new RegExp(`(^|[^\\p{L}])(${escaped})(?=$|[^\\p{L}])`,'gu');
    let found=false;remainder=remainder.replace(pattern,(_,prefix)=>{found=true;return prefix+' ';});
    if(found&&!people.includes(name.id))people.push(name.id);
  }
  return {people,complete:people.length>0&&!remainder.replace(/\band\b|[\s,&/+]/g,'').length};
}
export function reviewGroups(snapshot) {
  const {workbook,decisions}=snapshot,groups=[];
  const add=(key,title,issue,decision,detail)=>{
    let group=groups.find(g=>g.key===key);
    if(!group){group={key,title,detail,items:[],sources:[]};groups.push(group);}
    group.items.push({issueId:issue.id,decision});group.sources.push(...issue.sources);
  };
  const aliases={rosales:'Villamizar Rosales',barrron:'Barron',mitchel:'Mitchell',nepburn:'Hepburn','giampalmo-':'Giampalmo'};
  for(const issue of workbook.issues.filter(i=>!decisions[i.id])) {
    if(issue.type==='identity') {
      const person=workbook.staff.find(p=>p.name===aliases[normalize(issue.label)]);
      if(person)add('aliases','Five proposed name corrections',issue,{action:'identify',staffId:person.id},'Confirm each listed mapping. Unknown names and initials remain separate.');
      else {const parsed=parsePeople(issue.label,workbook,decisions);if(parsed.complete&&parsed.people.length>1)add('people:'+parsed.people.slice().sort().join(','),'Identify multiple people: '+issue.label,issue,{action:'identify',people:parsed.people},'Participants are identified together; split clinical credit still requires allocation.');}
    } else if(issue.type==='strikethrough'){
      if(snapshot.workspace?.reviewPreferences?.strikes!=='individual')add('strike:'+issue.service,'Exclude struck-out '+issue.service+' entries',issue,{action:'exclude'},'Use only if strikethrough means cancelled work. Source cells remain available.');
    }
    else if(issue.type==='overlap'&&issue.sheets.includes('2026 Sch'))add('overlap','Use 2026 Sch for January overlap',issue,{action:'source',sheet:'2026 Sch'},'Select the 2026 calendar as authority for these four dates. The older version remains available.');
    else if(issue.type==='availability') {
      const record=workbook.records.find(r=>r.id===issue.recordId), parsed=parsePeople(record.raw,workbook,decisions);
      if(parsed.complete)add('availability:'+record.service+':'+parsed.people.slice().sort().join(','),'Confirm '+record.service+': '+parsed.people.map(id=>reviewedStaff(workbook,decisions).find(p=>p.id===id).name).join(' + '),issue,{action:'include',people:parsed.people,service:record.service,period:'unspecified',classification:'unspecified'},'Confirm full-date unavailability for the identified people. No assignment or clinical credit is created.');
    }
  }
  return groups;
}

export function validatePolicy(workbook,input) {
  if(!input||typeof input!=='object'||!Number.isInteger(input.year)||input.year<2000||input.year>2100)throw new Error('Choose a valid policy year.');
  const note=reason(input.note), targetSheet=`Staff ${input.year} #s`;
  if(!workbook.targets.some(t=>t.sheet===targetSheet))throw new Error('No annual target ledger exists for this year.');
  if(!Array.isArray(input.rules)||input.rules.length>8)throw new Error('Choose up to eight clinical category rules.');
  const rules=[],seen=new Set(),used=new Set();
  for(const rule of input.rules) {
    const category=creditCategories.find(c=>c.id===rule.category);
    if(!category||seen.has(rule.category)||!Array.isArray(rule.days)||!rule.days.length||rule.days.length>7||new Set(rule.days).size!==rule.days.length||rule.days.some(d=>!Number.isInteger(d)||d<0||d>6)||typeof rule.daysPerCredit!=='number'||!Number.isFinite(rule.daysPerCredit)||rule.daysPerCredit<=0||rule.daysPerCredit>31||typeof rule.moonlightingCredit!=='boolean')throw new Error('Each rule needs a distinct category, valid weekdays, days per credit and moonlighting policy.');
    seen.add(rule.category);
    for(const day of rule.days){const key=category.service+day;if(used.has(key))throw new Error('A service day cannot earn credit in two categories.');used.add(key);}
    rules.push({category:category.id,days:[...rule.days].sort(),daysPerCredit:rule.daysPerCredit,moonlightingCredit:rule.moonlightingCredit});
  }
  return {year:input.year,targetSheet,note,rules};
}
export function validateProfile(workbook,decisions,input) {
  if(!input||!reviewedStaff(workbook,decisions).some(p=>p.id===input.staffId))throw new Error('Choose a known roster person.');
  if(!validDate(input.from)||!validDate(input.to)||input.from>input.to)throw new Error('Choose a valid active date range.');
  if(!Array.isArray(input.services)||input.services.length>clinicalServices.length||new Set(input.services).size!==input.services.length||input.services.some(s=>!clinicalServices.includes(s)))throw new Error('Choose distinct eligible services.');
  return {staffId:input.staffId,from:input.from,to:input.to,services:input.services,note:reason(input.note)};
}
const creditSignature=r=>JSON.stringify([r.date,r.service,r.people,r.classification,r.period,r.shares??null]);
export function validateCredit(snapshot,input) {
  if(!input||!Number.isInteger(input.year)||input.year<2000||input.year>2100)throw new Error('Choose a valid credit year.');
  const category=creditCategories.find(c=>c.id===input.category),view=scheduleView(snapshot);
  if(input.confirm!==true)throw new Error('Explicitly approve the credit quantity and selected source scope.');
  if(!category||!view.staff.some(p=>p.id===input.staffId))throw new Error('Choose a known clinical category and person.');
  if(!Array.isArray(input.recordIds)||!input.recordIds.length||input.recordIds.length>400||new Set(input.recordIds).size!==input.recordIds.length)throw new Error('Select 1–400 distinct source/draft dates.');
  if(typeof input.quantity!=='number'||!Number.isFinite(input.quantity)||input.quantity<0||input.quantity>input.recordIds.length)throw new Error('Credit must be a nonnegative quantity no larger than the selected date count.');
  const records=input.recordIds.map(id=>view.records.find(r=>r.id===id));
  if(records.some(r=>!r||r.kind!=='assignment'||['review','excluded'].includes(r.status)||!r.date.startsWith(input.year+'-')||r.service!==category.service||!r.people.includes(input.staffId)))throw new Error('Every selected entry must be reviewed/identified, in this year and category service, with this person as a participant.');
  if(records.some(r=>r.people.length>1&&!r.shares))throw new Error('Allocate participant shares on every split source before approving credit.');
  if(records.some(r=>view.records.some(other=>other.id!==r.id&&other.date===r.date&&other.service===r.service&&other.people.includes(input.staffId)&&!['review','excluded'].includes(other.status))))throw new Error('Resolve duplicate person/service/date sources before approving credit.');
  if(Object.values(snapshot.workspace?.credits??{}).some(c=>c.staffId===input.staffId&&c.recordIds.some(id=>input.recordIds.includes(id))))throw new Error('This person already has an explicit approval for one of these entries. Remove that approval before replacing it.');
  if(typeof input.countsTowardObligation!=='boolean')throw new Error('Choose whether this credit reduces an obligation or records moonlighting exposure only.');
  if(!input.countsTowardObligation&&records.some(r=>r.classification!=='moonlighting'))throw new Error('Exposure-only credit requires explicitly classified moonlighting entries.');
  return {year:input.year,category:category.id,staffId:input.staffId,recordIds:[...input.recordIds],quantity:input.quantity,countsTowardObligation:input.countsTowardObligation,note:reason(input.note),evidence:records.map(r=>({id:r.id,signature:creditSignature(r)}))};
}
export function creditLedger(snapshot,year) {
  const view=scheduleView(snapshot),policy=snapshot.workspace?.policies?.[year],sheet=snapshot.workbook.sheets.find(s=>s.name===`Staff ${year} #s`);
  const targets=snapshot.workbook.targets.filter(t=>t.sheet===sheet?.name), details=[],unvalued=[];
  const rows=view.staff.map(person=>{
    const target=targets.find(t=>t.staffId===person.id),rowNumber=sheet?.cells.find(c=>c.id===target?.sources[0])?.row;
    const reported=Object.fromEntries(creditCategories.map(c=>{const cell=sheet?.cells.find(x=>x.row===rowNumber&&x.col===c.col);return [c.id,typeof cell?.value==='number'?cell.value:cell?.formula?0:null];}));
    return {staffId:person.id,name:person.name,targetWeeks:target?.weeks??null,targetWeekends:target?.weekends??null,reportedWeeks:target?.reportedWeeks??null,reportedWeekends:target?.reportedWeekends??null,reported,scheduledWeeks:0,scheduledWeekends:0,moonlightingWeeks:0,moonlightingWeekends:0,unvalued:0,categories:Object.fromEntries(creditCategories.map(c=>[c.id,0])),exposure:{CDI:0,Jeopardy:0,NMET:0}};
  });
  const rowMap=new Map(rows.map(r=>[r.staffId,r])),approved=[],invalidApprovals=[],manualKeys=new Set();
  for(const credit of Object.values(snapshot.workspace?.credits??{}).filter(c=>c.year===year)) {
    const records=credit.recordIds.map(id=>view.records.find(r=>r.id===id)),row=rowMap.get(credit.staffId),category=creditCategories.find(c=>c.id===credit.category);
    if(!row||!category||records.some((r,index)=>!r||['review','excluded'].includes(r.status)||creditSignature(r)!==credit.evidence[index]?.signature)) {invalidApprovals.push({...credit,reason:'Source participants, activity, time window, classification or draft eligibility changed; reapproval is required.'});continue;}
    const obligation=credit.countsTowardObligation?credit.quantity:0;
    row[category.unit==='weeks'?'scheduledWeeks':'scheduledWeekends']+=obligation;row.categories[category.id]+=obligation;
    const moonlighting=records.every(r=>r.classification==='moonlighting');if(moonlighting)row[category.unit==='weeks'?'moonlightingWeeks':'moonlightingWeekends']+=credit.quantity;
    for(const id of credit.recordIds)manualKeys.add(credit.staffId+':'+id);
    approved.push(credit);details.push({approvalId:credit.id,recordIds:credit.recordIds,staffId:credit.staffId,category:category.id,unit:category.unit,quantity:credit.quantity,obligation,moonlighting,explicit:true,note:credit.note,date:records.map(r=>r.date).sort()[0]});
  }
  const slots=new Map(),duplicates=new Set();
  for(const r of view.records.filter(r=>r.date.startsWith(String(year)+'-')&&r.kind==='assignment'&&!['review','excluded'].includes(r.status)))for(const person of r.people){
    const key=[r.date,r.service,person].join(':'),other=slots.get(key);
    if(other){duplicates.add(r.id);duplicates.add(other);}else slots.set(key,r.id);
  }
  for(const record of view.records.filter(r=>r.date.startsWith(String(year)+'-')&&r.kind==='assignment'&&r.status!=='excluded')) {
    const remainingPeople=record.people.filter(id=>!manualKeys.has(id+':'+record.id));
    if(record.people.length&&!remainingPeople.length)continue;
    const unvaluedRecord={...record,people:remainingPeople};
    if(record.status==='review'||!record.people.length){unvalued.push({record,reason:'Source interpretation unresolved'});for(const id of record.people)if(rowMap.has(id))rowMap.get(id).unvalued++;continue;}
    if(['CDI','Jeopardy','NMET'].includes(record.service)){for(const id of record.people)if(rowMap.has(id))rowMap.get(id).exposure[record.service]++;continue;}
    if(duplicates.has(record.id)){unvalued.push({record:unvaluedRecord,reason:'Duplicate person/service/date requires allocation review'});for(const id of remainingPeople)if(rowMap.has(id))rowMap.get(id).unvalued++;continue;}
    const incompatibleWindow=record.service==='Nights'?!['unspecified','night'].includes(record.period):!['unspecified','day'].includes(record.period);
    if(incompatibleWindow){unvalued.push({record:unvaluedRecord,reason:'Nonstandard time window needs a distinct credit rule or corrected activity'});for(const id of remainingPeople)if(rowMap.has(id))rowMap.get(id).unvalued++;continue;}
    const rule=policy?.rules.find(r=>creditCategories.find(c=>c.id===r.category).service===record.service&&r.days.includes(dayOf(record.date)));
    const shares=record.shares??(record.people.length===1?[1]:null);
    if(!rule||!shares){unvalued.push({record:unvaluedRecord,reason:!rule?'No approved category/day conversion':'Split credit shares not allocated'});for(const id of remainingPeople)if(rowMap.has(id))rowMap.get(id).unvalued++;continue;}
    const category=creditCategories.find(c=>c.id===rule.category);
    record.people.forEach((id,index)=>{
      if(manualKeys.has(id+':'+record.id))return;
      const row=rowMap.get(id);if(!row)return;
      const quantity=shares[index]/rule.daysPerCredit,moonlighting=record.classification==='moonlighting',obligation=moonlighting&&!rule.moonlightingCredit?0:quantity;
      row[category.unit==='weeks'?'scheduledWeeks':'scheduledWeekends']+=obligation;row.categories[category.id]+=obligation;
      if(moonlighting)row[category.unit==='weeks'?'moonlightingWeeks':'moonlightingWeekends']+=quantity;
      details.push({staffId:id,recordId:record.id,date:record.date,category:category.id,unit:category.unit,quantity,obligation,share:shares[index],moonlighting,rule,sourceId:record.sourceId,draft:record.status==='draft'});
    });
  }
  const hasCredit=Boolean(policy||approved.length);
  for(const row of rows){row.remainingWeeks=hasCredit&&row.targetWeeks!==null?row.targetWeeks-row.scheduledWeeks:null;row.remainingWeekends=hasCredit&&row.targetWeekends!==null?row.targetWeekends-row.scheduledWeekends:null;}
  return {year,policy:policy??null,hasCredit,approved,invalidApprovals,rows,details,unvalued,unassigned:unvalued.filter(i=>!i.record.people.length).length};
}

export function candidates(snapshot,proposal) {
  if(!validDate(proposal.date)||!clinicalServices.includes(proposal.service)||!periods.includes(proposal.period)||!['unspecified','moonlighting'].includes(proposal.classification))throw new Error('Choose a valid date, clinical service, time window and classification.');
  const view=scheduleView(snapshot),workspace=snapshot.workspace??emptyWorkspace(),ledger=creditLedger(snapshot,Number(proposal.date.slice(0,4)));
  const comparison=proposal.comparisonCategory?creditCategories.find(c=>c.id===proposal.comparisonCategory&&c.service===proposal.service):null;
  if(proposal.comparisonCategory&&!comparison)throw new Error('Choose a comparison category for the selected service.');
  return view.staff.map(person=>{
    const blocked=[],warnings=['Exact shift overlap, rest, and consecutive-night limits need clinical review; times and limits are unspecified.','Source side notes and moonlighting offers need manual date checks; they are not structured availability.'];
    const profile=workspace.profiles[person.id];
    if(!profile)warnings.push('Service eligibility and active dates are unconfirmed.');
    else {
      if(proposal.date<profile.from||proposal.date>profile.to)blocked.push('Outside confirmed active dates.');
      if(!profile.services.includes(proposal.service))blocked.push('Service not in confirmed eligibility.');
    }
    for(const record of view.records.filter(r=>r.id!==proposal.sourceId&&r.date===proposal.date&&r.status!=='excluded')) {
      const potential=record.people.includes(person.id)||parsePeople(record.raw,snapshot.workbook,snapshot.decisions).people.includes(person.id);
      if(!potential){if(record.kind==='availability'&&record.status==='review'&&!parsePeople(record.raw,snapshot.workbook,snapshot.decisions).complete)warnings.push('Unresolved availability text on this date may affect this person.');continue;}
      if(record.status==='review')warnings.push(`${record.service} source on this date still needs review.`);
      else if(record.kind==='availability'){
        if(record.period!=='unspecified'&&proposal.period!=='unspecified'&&record.period!==proposal.period)warnings.push(`Confirmed ${record.service} during ${record.period}; exact boundaries against ${proposal.period} need review.`);
        else blocked.push(`Confirmed ${record.service} on this date.`);
      }
      else if(record.service===proposal.service||(record.period!=='unspecified'&&record.period===proposal.period))blocked.push(`Already assigned ${record.service} on this date/window.`);
      else warnings.push(`Also assigned ${record.service} on this date; compatibility is unconfirmed.`);
    }
    const row=ledger.rows.find(r=>r.staffId===person.id),rule=ledger.policy?.rules.find(r=>creditCategories.find(c=>c.id===r.category).service===proposal.service&&r.days.includes(dayOf(proposal.date)));
    const nonstandard=proposal.service==='Nights'?!['unspecified','night'].includes(proposal.period):!['unspecified','day'].includes(proposal.period);
    const category=rule?creditCategories.find(c=>c.id===rule.category):comparison,impact=rule&&!nonstandard?(proposal.classification==='moonlighting'&&!rule.moonlightingCredit?0:1/rule.daysPerCredit):null;
    let remaining=null,basis='No category selected';
    if(category){
      if(ledger.hasCredit){remaining=category.unit==='weeks'?row.remainingWeeks:row.remainingWeekends;basis='Valued credit subtotal (partial)';}
      else {const target=category.unit==='weeks'?row.targetWeeks:row.targetWeekends,reported=category.unit==='weeks'?row.reportedWeeks:row.reportedWeekends;remaining=target!==null&&reported!==null?target-reported:null;basis='Imported reported ledger; not recomputed';}
    }
    if(!rule)warnings.push('No approved clinical credit conversion for this service/day.');
    if(nonstandard)warnings.push('Nonstandard time window is not covered by the credit rules; credit will remain pending.');
    if(row.unvalued)warnings.push(`${row.unvalued} known-person source entries remain unvalued; workload ranking is partial.`);
    return {staffId:person.id,name:person.name,blocked:[...new Set(blocked)],warnings:[...new Set(warnings)],remaining,remainingBasis:basis,impact,unit:category?.unit??null,status:blocked.length?'blocked':'review'};
  }).sort((a,b)=>Number(Boolean(a.blocked.length))-Number(Boolean(b.blocked.length))||(b.remaining??-Infinity)-(a.remaining??-Infinity)||a.name.localeCompare(b.name));
}
export function validateDraft(snapshot,input) {
  if(!input||typeof input!=='object')throw new Error('A draft assignment is required.');
  const drafts=snapshot.workspace?.drafts??{};
  if(input.id!==undefined&&(typeof input.id!=='string'||!/^([a-f0-9]{24}|draft-[a-f0-9-]{36})$/.test(input.id)))throw new Error('Invalid draft identifier.');
  const note=reason(input.note),base=materialize(snapshot.workbook,snapshot.decisions),existing=Object.hasOwn(drafts,input.id)?drafts[input.id]:null;
  if(existing?.sourceId&&input.sourceId!==existing.sourceId)throw new Error('A replacement must retain its original source reference.');
  let source=null;
  if(input.sourceId){source=base.records.find(r=>r.id===input.sourceId);if(!source||source.kind!=='assignment'||source.status==='review'||source.status==='excluded')throw new Error('Resolve the active source entry before replacing it.');}
  if(input.id&&!existing&&input.id!==source?.id)throw new Error('Draft not found.');
  if(source&&input.id&&input.id!==source.id)throw new Error('A replacement must use its source identifier.');
  if(source&&(input.date!==source.date||input.service!==source.service))throw new Error('A source replacement must keep its date and service.');
  const candidate=candidates(snapshot,{...input,sourceId:source?.id??existing?.id}).find(p=>p.staffId===input.staffId);
  if(!candidate)throw new Error('Choose a known person.');
  if(candidate.blocked.length)throw new Error(candidate.blocked.join(' '));
  if(input.acknowledgeWarnings!==true)throw new Error('Review and explicitly acknowledge all incomplete policy/timing checks before saving a draft.');
  return {date:input.date,service:input.service,period:input.period,classification:input.classification,comparisonCategory:input.comparisonCategory??'',staffId:input.staffId,sourceId:source?.id??null,note,warnings:candidate.warnings,creditPreview:{impact:candidate.impact,unit:candidate.unit}};
}
