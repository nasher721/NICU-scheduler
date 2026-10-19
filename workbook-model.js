export const activityServices = ['G20','H22','Akron','Nights','Consults','NMET','CDI','Jeopardy','Recovery','Vacations'];
export const periods = ['unspecified','day','night','PM','home call'];
export function reviewedStaff(workbook, decisions) {
  const staff = [...workbook.staff];
  for (const decision of Object.values(decisions)) if (decision.action === 'identify' && decision.newPerson && !staff.some(p=>p.id===decision.newPerson.id)) staff.push(decision.newPerson);
  return staff.sort((a,b)=>a.name.localeCompare(b.name));
}
export function validateDecision(workbook, decisions, issueId, decision) {
  const issue = workbook.issues.find(i=>i.id===issueId);
  if (!issue) throw new Error('Review item not found.');
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('A review decision is required.');
  if (typeof decision.note !== 'string' || !decision.note.trim() || decision.note.length > 2000) throw new Error('Add a review reason of 1–2,000 characters.');
  const clean = { action: decision.action, note: decision.note.trim() };
  if (decision.action === 'reopen') return clean;
  const staff = reviewedStaff(workbook, decisions), validPerson = id => staff.some(p=>p.id===id);
  if (issue.type === 'identity' && decision.action === 'identify') {
    if (decision.newName !== undefined) {
      const name = String(decision.newName).trim();
      if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name)) throw new Error('Enter a valid distinct person name.');
      const existing = staff.find(p=>p.name.toLowerCase()===name.toLowerCase());
      if (existing) clean.staffId = existing.id;
      else clean.newPerson = { id: 'review-person-' + issue.id, name };
    } else {
      if (decision.people !== undefined) {
        if (!Array.isArray(decision.people) || !decision.people.length || decision.people.length > 20 || decision.people.some(id=>!validPerson(id)) || new Set(decision.people).size !== decision.people.length) throw new Error('Choose known participants without duplicates.');
        clean.people = decision.people;
      } else {
        if (!validPerson(decision.staffId)) throw new Error('Choose a roster person.');
        clean.staffId = decision.staffId;
      }
    }
  } else if (issue.type === 'overlap' && decision.action === 'source') {
    if (!issue.sheets.includes(decision.sheet)) throw new Error('Choose one of the overlapping source sheets.');
    clean.sheet = decision.sheet;
  } else if (['strikethrough','entry','availability'].includes(issue.type) && ['include','exclude'].includes(decision.action)) {
    if (decision.action === 'include') {
      if (!Array.isArray(decision.people) || !decision.people.length || decision.people.length > 20 || decision.people.some(id=>!validPerson(id)) || new Set(decision.people).size !== decision.people.length) throw new Error('Choose at least one known person, without duplicates.');
      if (!activityServices.includes(decision.service) || !periods.includes(decision.period) || !['unspecified','moonlighting'].includes(decision.classification)) throw new Error('Choose valid activity, time-window and classification values.');
      Object.assign(clean, { people: decision.people, service: decision.service, period: decision.period, classification: decision.classification });
      if (decision.shares !== undefined) {
        if (!Array.isArray(decision.shares) || decision.shares.length !== decision.people.length || decision.shares.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<=0||n>1) || Math.abs(decision.shares.reduce((a,b)=>a+b,0)-1)>1e-8) throw new Error('Credit shares must be positive and sum to one across the selected participants.');
        clean.shares=decision.shares;
      }
    }
  } else if (!['identity','overlap','strikethrough','entry','availability'].includes(issue.type) && decision.action === 'acknowledge') {
    // Reviewing notes never creates assignments or changes contractual targets.
  } else throw new Error('This action is not valid for this review item.');
  return clean;
}
export function materialize(workbook, decisions = {}) {
  const issues = new Map(workbook.issues.map(i=>[i.id,i])), records = [];
  for (const raw of workbook.records) {
    const overlap = issues.get(raw.overlapIssue), source = decisions[raw.overlapIssue];
    if (overlap && raw.sheet !== (source?.sheet ?? overlap.preferred)) continue;
    const entry = decisions[raw.entryIssue], identity = decisions[raw.identityIssue];
    let people = [...raw.people];
    if (identity?.action === 'identify') people = identity.people ?? [identity.staffId ?? identity.newPerson.id];
    const record = { ...raw, people, status: 'imported' };
    if (entry?.action === 'include') Object.assign(record, { people: entry.people, service: entry.service, period: entry.period, classification: entry.classification, shares: entry.shares });
    record.kind = ['Recovery','Vacations'].includes(record.service) ? 'availability' : 'assignment';
    record.pendingIssues = raw.issues.filter(id => !decisions[id] && !(entry && id===raw.identityIssue));
    if (entry?.action === 'exclude') { record.status = 'excluded'; record.pendingIssues = []; }
    else if (record.pendingIssues.length) record.status = 'review';
    else if (entry || identity || source) record.status = 'reviewed';
    records.push(record);
  }
  return { staff: reviewedStaff(workbook, decisions), records, issues: workbook.issues.map(issue=>({ ...issue, decision: decisions[issue.id] ?? null })) };
}
