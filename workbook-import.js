import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { createHash } from 'node:crypto';

export const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_EXPANDED = 64 * 1024 * 1024;
export const normalize = value => String(value ?? '').replace(/\u00a0/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
const digest = value => createHash('sha256').update(value).digest('hex');
const key = (...parts) => digest(parts.join('\0')).slice(0, 24);
const dateKey = date => date.toISOString().slice(0, 10);
const services = ['G20', 'H22', 'Akron', 'Nights', 'Consults', 'NMET', 'CDI', 'Jeopardy', 'Recovery', 'Vacations'];
const expectedSheets = ['2026 Sch','Staff 2026 #s','Sheet1','2026 RD changes','2025 First Half','2025 second half','Staff 2025 #s','Swap Tracker','FTE Calc','Moonligiting avaibility'];

function checkArchive(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(new Error('This is not a readable XLSX archive.'));
      let bytes = 0, entries = 0, hasWorkbook = false;
      const fail = message => { zip.close(); reject(new Error(message)); };
      zip.on('error', () => fail('The XLSX archive is damaged.'));
      zip.on('entry', entry => {
        bytes += entry.uncompressedSize; entries++;
        if (bytes > MAX_EXPANDED || entries > 2000) return fail('Workbook exceeds the expanded size or entry limit.');
        if (entry.generalPurposeBitFlag & 1 || /vbaProject\.bin$/i.test(entry.fileName)) return fail('Encrypted or macro-enabled workbooks are not supported.');
        if (entry.fileName === 'xl/workbook.xml') hasWorkbook = true;
        zip.readEntry();
      });
      zip.on('end', () => hasWorkbook ? resolve() : reject(new Error('The archive does not contain an XLSX workbook.')));
      zip.readEntry();
    });
  });
}

function cellValue(value) {
  if (value instanceof Date) return { value: dateKey(value), type: 'date' };
  if (value && typeof value === 'object') {
    if (value.formula !== undefined || value.sharedFormula !== undefined) {
      const result = cellValue(value.result);
      return { ...result, formula: value.formula ?? `shared:${value.sharedFormula}` };
    }
    if (value.richText) return { value: value.richText.map(x => x.text).join(''), type: 'text', richText: value.richText };
    if (value.error) return { value: value.error, type: 'error' };
    if (value.text !== undefined) return { value: String(value.text), type: 'text', hyperlink: value.hyperlink };
    return { value: JSON.stringify(value), type: 'text' };
  }
  return { value: value ?? null, type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text' };
}

function sheetKind(name, at) {
  if (normalize(at(1, 2)) === 'g20' && normalize(at(1, 4)) === 'akron') return 'calendar';
  if (/^staff 20\d\d #s$/i.test(name.trim())) return 'staff ledger';
  if (normalize(at(1, 1)) === 'staff' && normalize(at(1, 2)) === 'fte week') return 'targets';
  if (normalize(at(1, 1)) === 'staff involved') return 'change requests';
  if (normalize(name) === 'fte calc') return 'capacity scenario';
  if (/moonlig/i.test(name)) return 'moonlighting availability';
  return 'notes';
}

export async function parseWorkbook(buffer, filename) {
  if (!buffer.length || buffer.length > MAX_UPLOAD) throw new Error('Choose an XLSX workbook under 10 MB.');
  if (!/\.xlsx$/i.test(filename)) throw new Error('Only .xlsx files are supported.');
  await checkArchive(buffer);
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(buffer); } catch { throw new Error('Unable to read workbook data. The source file was not changed.'); }
  if (!book.worksheets.length || book.worksheets.length > 50) throw new Error('Workbook must have between 1 and 50 sheets.');
  const result = { schema: 1, hash: digest(buffer), filename, sheets: [], staff: [], records: [], issues: [], targets: [], swaps: [], stats: {} };
  const bySheet = new Map(), byCell = new Map(), issueIds = new Set();
  const addIssue = issue => {
    if (!issueIds.has(issue.id)) { issueIds.add(issue.id); result.issues.push(issue); }
    return issue.id;
  };
  let total = 0;
  for (const ws of book.worksheets) {
    if (ws.rowCount > 20000 || ws.columnCount > 200) throw new Error('Workbook exceeds the supported row or column limit.');
    const cells = [], lookup = new Map();
    ws.eachRow((row, r) => row.eachCell((cell, c) => {
      if (cell.type === ExcelJS.ValueType.Merge || cell.value == null) return;
      if (++total > 200000) throw new Error('Workbook exceeds 200,000 populated cells.');
      const data = cellValue(cell.value);
      if (String(data.value ?? '').length > 32768) throw new Error('A workbook cell exceeds the supported text limit.');
      const entry = { id: key(ws.name, cell.address), address: cell.address, row: r, col: c, ...data,
        strike: Boolean(cell.font?.strike || cell.value?.richText?.some(run => run.font?.strike)),
        fill: cell.fill?.fgColor ?? null, fontColor: cell.font?.color ?? null, numberFormat: cell.numFmt ?? null,
        hidden: Boolean(row.hidden || ws.getColumn(c).hidden), note: cell.note ?? null, disposition: 'source note' };
      if (cell.type === ExcelJS.ValueType.Formula) entry.formula = cell.formula;
      cells.push(entry); lookup.set(`${r}:${c}`, entry); byCell.set(entry.id, entry);
    }));
    const at = (r, c) => lookup.get(`${r}:${c}`)?.value;
    const kind = sheetKind(ws.name, at);
    const sheet = { name: ws.name, kind, state: ws.state, rows: ws.rowCount, columns: ws.columnCount, cells,
      merges: ws.model.merges ?? [], nonempty: cells.length, formulas: cells.filter(c => c.formula).length };
    result.sheets.push(sheet); bySheet.set(ws.name, { sheet, lookup, at });
    if (ws.state !== 'visible') addIssue({ id: key('hidden', ws.name), type: 'metadata', title: `Hidden sheet: ${ws.name}`, detail: 'Hidden source content was retained. Review it before relying on this import.', sources: cells.slice(0, 6).map(c => c.id) });
  }
  const namedStaff = new Map();
  function addStaff(name) {
    const normalized = normalize(name);
    if (!namedStaff.has(normalized)) {
      const person = { id: key('staff', normalized), name: String(name).trim() };
      namedStaff.set(normalized, person); result.staff.push(person);
    }
    return namedStaff.get(normalized);
  }
  for (const { sheet, lookup, at } of bySheet.values()) {
    if (!['staff ledger', 'targets'].includes(sheet.kind)) continue;
    sheet.cells.forEach(c => { c.disposition = sheet.kind; });
    const start = sheet.kind === 'targets' ? 2 : 3;
    const targetCol = sheet.kind === 'targets' ? 2 : normalize(at(2, 12)) === 'jeopardy' ? 13 : 12;
    const numeric = (row, col) => typeof at(row, col) === 'number' ? at(row, col) : null;
    for (let row = start; row <= sheet.rows && typeof at(row, 1) === 'string' && normalize(at(row, 1)); row++) {
      const person = addStaff(at(row, 1));
      result.targets.push({ id: key('target', sheet.name, String(row)), staffId: person.id, sheet: sheet.name,
        year: sheet.name.match(/20\d\d/)?.[0] ?? null, weeks: numeric(row, targetCol), weekends: numeric(row, targetCol + 1),
        reportedWeeks: sheet.kind === 'staff ledger' ? numeric(row, 10) : null,
        reportedWeekends: sheet.kind === 'staff ledger' ? numeric(row, 11) : null,
        sources: [1,10,11,targetCol,targetCol+1].map(c => lookup.get(`${row}:${c}`)?.id).filter(Boolean) });
      for (const col of [targetCol,targetCol+1]) if (at(row,col) != null && numeric(row,col) === null) addIssue({ id: key('target-type',sheet.name,String(row),String(col)),type:'reconciliation',title:`Non-numeric target: ${person.name}`,detail:'The target value is not numeric. It is preserved in Sources and omitted from numeric totals until interpreted.',sources:[lookup.get(`${row}:${col}`).id] });
    }
  }
  const aliases = new Map();
  function identity(label, sourceId) {
    const normalized = normalize(label), person = namedStaff.get(normalized);
    if (person) return { staffId: person.id };
    const id = key('alias', normalized);
    if (!aliases.has(normalized)) {
      const suggestion = result.staff.filter(p => normalize(p.name).endsWith(' ' + normalized));
      const issue = { id, type: 'identity', label: String(label).trim(), title: `Identify “${String(label).trim()}”`,
        detail: 'This label does not exactly match the annual roster. Confirm a person or explicitly add a distinct person. Similar names are not merged automatically.',
        sources: [], suggestedStaffId: suggestion.length === 1 ? suggestion[0].id : null };
      aliases.set(normalized, issue); addIssue(issue);
    }
    aliases.get(normalized).sources.push(sourceId);
    return { identityIssue: id };
  }
  const datesBySheet = new Map();
  for (const { sheet, lookup, at } of bySheet.values()) {
    if (sheet.kind !== 'calendar') continue;
    const dateRows = sheet.cells.filter(c => c.col === 1 && c.type === 'date');
    datesBySheet.set(sheet.name, dateRows.map(c => c.value));
    sheet.dateRows = dateRows.length;
    sheet.dateFrom = dateRows[0]?.value; sheet.dateTo = dateRows.at(-1)?.value;
    const columns = sheet.cells.filter(c => c.row === 1 && services.some(s => normalize(s) === normalize(c.value)));
    columns.forEach(c => { c.disposition = 'header'; });
    for (const date of dateRows) {
      date.disposition = 'date';
      for (const header of columns) {
        const cell = lookup.get(`${date.row}:${header.col}`);
        if (!cell || cell.value === '' || cell.value == null) continue;
        const service = services.find(s => normalize(s) === normalize(header.value));
        const kind = ['Recovery','Vacations'].includes(service) ? 'availability' : 'assignment';
        cell.disposition = kind;
        const label = String(cell.value).trim(), simple = /^[\p{L}][\p{L}\s'.-]*$/u.test(label) && !/moonlight|leave|meeting| day | H22|\bPM\b|\bML\b/i.test(label);
        const record = { id: cell.id, sourceId: cell.id, sheet: sheet.name, address: cell.address, date: date.value, service, kind,
          raw: label, strike: cell.strike, people: [], issues: [], period: 'unspecified', classification: 'unspecified' };
        if (simple) {
          const resolved = identity(label, cell.id);
          if (resolved.staffId) record.people = [resolved.staffId];
          else { record.identityIssue = resolved.identityIssue; record.issues.push(resolved.identityIssue); }
        }
        if (!simple || cell.strike) {
          record.entryIssue = addIssue({ id: key('entry', cell.id), type: cell.strike ? 'strikethrough' : kind === 'availability' ? 'availability' : 'entry',
            title: `${cell.strike ? 'Struck out' : 'Interpret entry'}: ${label}`, date: date.value, service, recordId: record.id,
            detail: cell.strike ? 'The name remains in the file but is struck through. Confirm whether to exclude it or explicitly retain it.' : 'Confirm participants and activity. Split timing, credit allocation, and shift times are not inferred.', sources: [cell.id] });
          record.issues.push(record.entryIssue);
        }
        result.records.push(record);
      }
    }
    const knownRows = new Set(dateRows.map(c => c.row));
    sheet.cells.forEach(c => {
      if (c.disposition === 'source note' && c.col <= Math.max(...columns.map(h => h.col)) && !knownRows.has(c.row) && !c.formula && /^(january|february|march|april|may|june|july|august|september|october|november|december|20\d\d)$/i.test(String(c.value).trim())) c.disposition = 'heading';
    });
  }
  const dates = new Map();
  for (const [name, values] of datesBySheet) for (const date of values) {
    if (!dates.has(date)) dates.set(date, []);
    dates.get(date).push(name);
  }
  for (const [date, sheets] of dates) if (sheets.length > 1) {
    const preferred = sheets.find(s => s.startsWith(date.slice(0, 4))) ?? sheets[0];
    const id = addIssue({ id: key('overlap', date), type: 'overlap', title: `Choose the source for ${date}`, date, sheets, preferred,
      detail: 'Multiple calendar sheets contain this date. Compare the sources and choose one. Until then the preferred source is displayed as needing review, and older blank cells cannot delete it.',
      sources: result.records.filter(r => r.date === date).map(r => r.sourceId) });
    result.records.filter(r => r.date === date).forEach(r => { r.overlapIssue = id; r.issues.push(id); });
  }
  for (const { sheet, lookup, at } of bySheet.values()) {
    if (sheet.kind === 'calendar') {
      const notes = sheet.cells.filter(c => c.disposition === 'source note');
      if (notes.length) addIssue({ id: key('notes', sheet.name), type: 'notes', title: `Calendar side notes · ${sheet.name}`, detail: 'These cells include rotation lists, aggregate tables, and undated or private notes. They are retained as source notes, not assigned to the neighboring date. Recording a review does not create availability or assignments.', sources: notes.map(c => c.id) });
    } else if (sheet.kind === 'change requests') {
      sheet.cells.forEach(c => { c.disposition = c.row === 1 ? 'header' : 'change request'; });
      let current;
      for (let r = 2; r <= sheet.rows; r++) {
        const rowCells = sheet.cells.filter(c => c.row === r);
        if (!rowCells.length) continue;
        if (at(r, 1)) {
          current = { id: key('swap', sheet.name, String(r)), staff: at(r, 1), details: [], sources: [], example: /example/i.test(String(at(r, 5) ?? '') + String(at(r, 1) ?? '')), approved: at(r, 4) ?? 'Unknown' };
          result.swaps.push(current);
        }
        if (current) { current.details.push(rowCells.map(c => String(c.value)).join(' | ')); current.sources.push(...rowCells.map(c => c.id)); }
      }
      for (const swap of result.swaps.filter(s => !s.example)) addIssue({ id: swap.id, type: 'request', title: `Change note: ${swap.staff}`, detail: `${swap.details.join('\n')}\nSource approval: ${swap.approved}. This import does not apply a swap. Record whether the note is historical, already applied, or needs follow-up.`, sources: swap.sources });
    } else if (sheet.kind === 'notes' || sheet.kind === 'moonlighting availability' || sheet.kind === 'capacity scenario') {
      sheet.cells.forEach(c => { c.disposition = sheet.kind; });
      addIssue({ id: key('section', sheet.name), type: sheet.kind === 'capacity scenario' ? 'policy' : 'notes', title: `Review ${sheet.name.trim()}`,
        detail: sheet.kind === 'capacity scenario' ? 'Scenario assumptions and future staff are preserved separately from live assignments. Confirm effective dates and night block units before using this capacity.' : 'Unstructured dates, names and notes are retained. Missing years, time windows, and approval state are not inferred. Acknowledging this source does not schedule work.', sources: sheet.cells.map(c => c.id) });
    }
  }
  const refs = (name, addresses) => addresses.map(address => result.sheets.find(s => s.name === name)?.cells.find(c => c.address === address)?.id).filter(Boolean);
  function discrepancy(id, title, detail, sources) { addIssue({ id: key('discrepancy', id), type: 'reconciliation', title, detail: detail + ' Source numbers are preserved; recording an interpretation does not change a target.', sources }); }
  const targets = bySheet.get('Sheet1');
  if (targets?.sheet.kind === 'targets') {
    const rows = result.targets.filter(t => t.sheet === 'Sheet1');
    const sums = [rows.reduce((n,t) => n + (typeof t.weeks === 'number' ? t.weeks : 0),0), rows.reduce((n,t) => n + (typeof t.weekends === 'number' ? t.weekends : 0),0)];
    const totals = targets.sheet.cells.filter(c => c.formula && [2,3].includes(c.col));
    if (totals.some(c => c.value !== sums[c.col - 2])) discrepancy('target-sum', 'Target total excludes listed staff', `The listed people total ${sums[0]} weeks / ${sums[1]} weekends. The source total cells show ${totals.map(c=>`${c.address}: ${c.value}`).join(', ')}.`, targets.sheet.cells.map(c=>c.id));
  }
  const ledger = bySheet.get('Staff 2026 #s');
  if (ledger) {
    const { at, lookup } = ledger;
    for (let r = 3; r <= 18; r++) for (let c = 2; c <= 9; c++) {
      const cell = lookup.get(`${r}:${c}`), half1 = lookup.get(`${r+20}:${c}`), half2 = lookup.get(`${r+39}:${c}`);
      if (cell && !cell.formula && typeof cell.value === 'number' && cell.value !== (Number(half1?.value)||0)+(Number(half2?.value)||0)) discrepancy(cell.id, `Annual count differs from half-year entries: ${at(r,1)}`, `${cell.address} is ${cell.value}; the two half-year cells sum to ${(Number(half1?.value)||0)+(Number(half2?.value)||0)}.`, [cell.id,half1?.id,half2?.id].filter(Boolean));
    }
    const annual = Array.from({length:16},(_,i)=>Number(at(i+3,12))||0).reduce((a,b)=>a+b,0);
    const sidebar = Array.from({length:14},(_,i)=>Number(at(i+67,11))||0).reduce((a,b)=>a+b,0);
    if (annual !== sidebar) discrepancy('jeopardy', 'Jeopardy lists have different totals', `Annual Jeopardy totals ${annual}; the separate list totals ${sidebar}. They may represent different periods or concepts.`, refs('Staff 2026 #s',['L2','L7','K66','K67','K68','K78']));
  }
  const fte = bySheet.get('FTE Calc');
  if (fte && typeof fte.at(19,3) === 'number' && typeof fte.at(8,8) === 'number') {
    const weekday = fte.at(8,5) / fte.at(8,8), weekend = fte.at(9,5) / fte.at(9,8);
    if (fte.at(19,3) !== weekday || fte.at(20,3) !== weekend) discrepancy('night-units', 'Night block conversions disagree', `The demand model implies ${weekday} weekday-night and ${weekend} weekend-night shifts per FTE; the per-person breakdown lists ${fte.at(19,3)} and ${fte.at(20,3)}.`, refs('FTE Calc',['E8','H8','E9','H9','B19','C19','B20','C20']));
  }
  if (fte && ledger) {
    const annual = result.targets.filter(t=>t.sheet==='Staff 2026 #s');
    const weeks = annual.reduce((n,t)=>n+(t.weeks??0),0), weekends=annual.reduce((n,t)=>n+(t.weekends??0),0);
    if (fte.at(51,2)!==weeks || fte.at(52,2)!==weekends) discrepancy('capacity-snapshot','Capacity snapshot differs from annual targets',`FTE Calc lists ${fte.at(51,2)} weeks / ${fte.at(52,2)} weekends for 2026. The annual staff targets sum to ${weeks} / ${weekends}.`,[...refs('FTE Calc',['A50','A51','B51','A52','B52']),...refs('Sheet1',['B18','C18'])]);
  }
  const missing = expectedSheets.filter(name => !result.sheets.some(s=>normalize(s.name)===normalize(name)));
  if (missing.length) addIssue({ id: key('profile'), type: 'metadata', title: 'Workbook differs from the analyzed template', detail: `Missing expected sheets: ${missing.join(', ')}. Only recognized calendar and roster layouts are extracted; all other cells remain available in Sources.`, sources: [] });
  if (!dates.size) throw new Error('No supported scheduling calendar found. Expected G20 and Akron headers with Excel dates in column A.');
  const allDates = [...dates.keys()].sort();
  result.stats = { sheets: result.sheets.length, cells: total, formulas: result.sheets.reduce((n,s)=>n+s.formulas,0),
    strikethrough: result.sheets.reduce((n,s)=>n+s.cells.filter(c=>c.strike).length,0), dateRows: [...datesBySheet.values()].reduce((n,ds)=>n+ds.length,0),
    uniqueDates: dates.size, from: allDates[0], to: allDates.at(-1), records: result.records.length };
  return result;
}
