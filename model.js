export const people = ['Alex Morgan', 'Sam Thompson', 'Liz Carter'];
export const locations = [
  { name: 'Location A', color: '#923b43', address: '119 West 24th St, New York, NY' },
  { name: 'Location B', color: '#57794a', address: '40 Park Avenue, New York, NY' },
  { name: 'Location C', color: '#426bb1', address: '88 Madison Avenue, New York, NY' }
];
export function dateKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
export function fromKey(key) { return new Date(key + 'T12:00:00'); }
export function addDays(key, days) { const d=fromKey(key); d.setDate(d.getDate()+days); return dateKey(d); }
export function monday(key) { return addDays(key, -(fromKey(key).getDay()+6)%7); }
export function duration(s) { const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3)); return ((minute(s.end)-minute(s.start)+1440)%1440 || 1440)/60; }
export function summary(shifts) { return {hours:shifts.reduce((n,s)=>n+duration(s),0), shifts:shifts.length, users:new Set(shifts.map(s=>s.user).filter(Boolean)).size}; }
export function validateShift(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || Number.isNaN(+fromKey(s.date)) || dateKey(fromKey(s.date))!==s.date) return 'Choose a valid date.';
  if (![s.start,s.end].every(t=>/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return 'Enter valid start and end times.';
  if (s.start===s.end) return 'Start and end times must be different.';
  if (s.location && !locations.some(l=>l.name===s.location)) return 'Choose a valid location.';
  if (s.user && !people.includes(s.user)) return 'Choose a valid team member.';
  if (!['draft','published'].includes(s.status)) return 'Choose a valid shift status.';
  if (typeof s.note!=='string' || s.note.length>4000) return 'Notes must be under 4,000 characters.';
  if (!Array.isArray(s.tasks) || s.tasks.length>50 || s.tasks.some(t=>typeof t.text!=='string'||t.text.length>200||typeof t.done!=='boolean')) return 'Invalid shift tasks.';
  return '';
}
export function seed(week) {
  return locations.flatMap((l,i)=>[0,1].map(day=>({id:`sample-${i}-${day}`,date:addDays(week,day),start:'09:00',end:'17:00',location:l.name,user:day===1&&i===2?'':people[(i+day)%3],status:day===1&&i===2?'draft':'published',note:'Everything you need for a great shift, in one place. Check in with your team when you arrive.',tasks:[{text:'Complete opening checklist',done:false},{text:'Send end-of-shift handover',done:false}]})));
}
export function parseSaved(raw) {
  const data=JSON.parse(raw);
  if (data.version!==1 || !Array.isArray(data.shifts) || data.shifts.some(s=>!s || typeof s.id!=='string' || validateShift(s)) || new Set(data.shifts.map(s=>s.id)).size!==data.shifts.length) throw new Error('Saved schedule is invalid.');
  return data;
}
