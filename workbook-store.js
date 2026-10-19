import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateDecision } from './workbook-model.js';
import { emptyWorkspace, validatePolicy, validateProfile, validateDraft, validateCredit } from './scheduling.js';

export function createStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, filename TEXT NOT NULL, created TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, original BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS decisions (import_id TEXT NOT NULL REFERENCES imports(id), issue_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(import_id,issue_id));
    CREATE TABLE IF NOT EXISTS review_events (id INTEGER PRIMARY KEY, import_id TEXT NOT NULL REFERENCES imports(id), issue_id TEXT NOT NULL, revision INTEGER NOT NULL, created TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspaces (import_id TEXT PRIMARY KEY REFERENCES imports(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_events (id INTEGER PRIMARY KEY, import_id TEXT NOT NULL REFERENCES imports(id), revision INTEGER NOT NULL, kind TEXT NOT NULL, created TEXT NOT NULL, data TEXT NOT NULL);`);
  function get(id) {
    const row = db.prepare('SELECT id,filename,created,revision,data FROM imports WHERE id=?').get(id);
    if (!row) return null;
    const decisions = Object.fromEntries(db.prepare('SELECT issue_id,data FROM decisions WHERE import_id=?').all(id).map(r=>[r.issue_id,JSON.parse(r.data)]));
    const workspace=db.prepare('SELECT data FROM workspaces WHERE import_id=?').get(id);
    return { id: row.id, created: row.created, revision: row.revision, workbook: JSON.parse(row.data), decisions, workspace:{...emptyWorkspace(),...(workspace?JSON.parse(workspace.data):{})} };
  }
  function change(id,revision,operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current=get(id);
      if(!current)throw Object.assign(new Error('Workbook not found.'),{status:404});
      if(!Number.isSafeInteger(revision)||current.revision!==revision)throw Object.assign(new Error('This workbook changed in another tab. Reload before saving.'),{status:409});
      operation(current);
      db.prepare('UPDATE imports SET revision=revision+1 WHERE id=?').run(id);
      db.exec('COMMIT');return get(id);
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function reviewMany(id,revision,items) {
    return change(id,revision,current=>{
      if(!Array.isArray(items)||!items.length||items.length>300||new Set(items.map(i=>i?.issueId)).size!==items.length)throw new Error('Choose 1–300 distinct review items.');
      if(current.workspace.reviewPreferences.strikes==='individual'&&items.filter(item=>current.workbook.issues.find(i=>i.id===item.issueId)?.type==='strikethrough').length>1)throw new Error('Struck-out entries are set to individual review. Save one at a time.');
      const decisions={...current.decisions},clean=[];
      for(const item of items){const decision=validateDecision(current.workbook,decisions,item.issueId,item.decision);clean.push({issueId:item.issueId,decision});if(decision.action==='reopen')delete decisions[item.issueId];else decisions[item.issueId]=decision;}
      for(const item of clean){
        const old=current.decisions[item.issueId],decision=decisions[item.issueId];
        if(old?.newPerson&&decision?.newPerson?.name!==old.newPerson.name){
          const used=Object.entries(decisions).some(([key,value])=>key!==item.issueId&&(value.people?.includes(old.newPerson.id)||value.staffId===old.newPerson.id))||current.workspace.profiles[old.newPerson.id]||Object.values(current.workspace.drafts).some(d=>d.staffId===old.newPerson.id)||Object.values(current.workspace.credits).some(c=>c.staffId===old.newPerson.id);
          if(used)throw new Error('This person is used by another review, profile or draft. Remove those references first.');
        }
      }
      for(const {issueId,decision} of clean){
        if(decision.action==='reopen')db.prepare('DELETE FROM decisions WHERE import_id=? AND issue_id=?').run(id,issueId);
        else db.prepare('INSERT INTO decisions VALUES (?,?,?) ON CONFLICT(import_id,issue_id) DO UPDATE SET data=excluded.data').run(id,issueId,JSON.stringify(decision));
        db.prepare('INSERT INTO review_events (import_id,issue_id,revision,created,data) VALUES (?,?,?,?,?)').run(id,issueId,revision+1,new Date().toISOString(),JSON.stringify(decision));
      }
    });
  }
  return {
    list: () => db.prepare('SELECT id,filename,created,revision FROM imports ORDER BY created DESC, rowid DESC').all(), get,
    import(workbook, original) {
      const existing = get(workbook.hash);
      if (existing) return { ...existing, duplicate: true };
      db.prepare('INSERT INTO imports (id,filename,created,data,original) VALUES (?,?,?,?,?)').run(workbook.hash,workbook.filename,new Date().toISOString(),JSON.stringify(workbook),original);
      return { ...get(workbook.hash), duplicate: false };
    },
    review(id, issueId, revision, input) {
      return reviewMany(id,revision,[{issueId,decision:input}]);
    },
    reviewMany,
    updateWorkspace(id,revision,operation) {
      return change(id,revision,current=>{
        const workspace=current.workspace;let saved;
        if(operation.kind==='policy') {saved=validatePolicy(current.workbook,operation.input);workspace.policies[saved.year]=saved;}
        else if(operation.kind==='profile') {saved=validateProfile(current.workbook,current.decisions,operation.input);workspace.profiles[saved.staffId]=saved;}
        else if(operation.kind==='draft') {
          saved=validateDraft(current,operation.input);saved.id=saved.sourceId??operation.input.id??('draft-'+randomUUID());
          workspace.drafts[saved.id]=saved;
        } else if(operation.kind==='credit') {
          saved=validateCredit(current,operation.input);saved.id='credit-'+randomUUID();workspace.credits[saved.id]=saved;
        } else if(operation.kind==='reviewPreferences') {
          if(!operation.input||!['individual','grouped'].includes(operation.input.strikes)||typeof operation.input.note!=='string'||!operation.input.note.trim()||operation.input.note.length>2000)throw new Error('Choose a review mode and record a reason.');
          saved={strikes:operation.input.strikes,note:operation.input.note.trim()};workspace.reviewPreferences=saved;
        } else if(operation.kind==='removeDraft'||operation.kind==='removeCredit') {
          const collection=operation.kind==='removeDraft'?workspace.drafts:workspace.credits;
          if(!operation.input||!Object.hasOwn(collection,operation.input.id))throw new Error('Draft or credit approval not found.');
          if(typeof operation.input.note!=='string'||!operation.input.note.trim()||operation.input.note.length>2000)throw new Error('Record a removal reason.');
          saved={id:operation.input.id,note:operation.input.note.trim()};delete collection[saved.id];
        } else throw new Error('Unknown workspace operation.');
        db.prepare('INSERT INTO workspaces VALUES (?,?) ON CONFLICT(import_id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(workspace));
        db.prepare('INSERT INTO workspace_events (import_id,revision,kind,created,data) VALUES (?,?,?,?,?)').run(id,revision+1,operation.kind,new Date().toISOString(),JSON.stringify(saved));
      });
    },
    original: id => db.prepare('SELECT original FROM imports WHERE id=?').get(id)?.original,
    events: id => db.prepare('SELECT issue_id,revision,created,data FROM review_events WHERE import_id=? ORDER BY revision,id').all(id).map(r=>({...r,decision:JSON.parse(r.data),data:undefined})),
    workspaceEvents: id=>db.prepare('SELECT revision,kind,created,data FROM workspace_events WHERE import_id=? ORDER BY revision,id').all(id).map(r=>({...r,data:JSON.parse(r.data)})),
    close: () => db.close()
  };
}
