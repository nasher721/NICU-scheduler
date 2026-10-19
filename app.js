import { people,locations,dateKey,fromKey,addDays,monday,duration,summary,validateShift,seed,parseSaved } from './model.js';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const KEY='connecteam-local-v1';
let week=monday(today),days=7,group='location',query='',status='all',person='all',editing=null,tasks=[],toastTimer,storageBlocked=false;
let data={version:1,shifts:seed(week),showWelcome:true};
try { const saved=localStorage.getItem(KEY); if(saved) data=parseSaved(saved); } catch { storageBlocked=true; }
const hours=n=>`${Math.floor(n)}:${String(Math.round((n%1)*60)).padStart(2,'0')}`;
const time=t=>new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit'}).format(new Date('2000-01-01T'+t)).replace(' AM','a').replace(' PM','p');
const shortDate=d=>fromKey(d).toLocaleDateString('en-US',{month:'short',day:'numeric'});
function toast(message,undo) {
  clearTimeout(toastTimer); $('#toast').replaceChildren(document.createTextNode(message));
  if(undo){const b=document.createElement('button');b.textContent='Undo';b.onclick=()=>{undo();$('#toast').hidden=true;};$('#toast').append(b);}
  $('#toast').hidden=false; toastTimer=setTimeout(()=>$('#toast').hidden=true,undo?12000:4500);
}
function commit(next) {
  if(storageBlocked){toast('Saved data could not be read. Export your browser data before resetting this workspace.');return false;}
  try {localStorage.setItem(KEY,JSON.stringify(next));data=next;return true;}
  catch {toast('Unable to save. Browser storage may be full or disabled. Your changes were not saved.');return false;}
}
function visible() {return data.shifts.filter(s=>s.date>=week&&s.date<addDays(week,days)&&(status==='all'||s.status===status)&&(person==='all'||s.user===person)&&(!query||[s.location,s.user,s.note].some(v=>v.toLowerCase().includes(query))));}
function render() {
  $('#welcome').hidden=data.showWelcome===false;
  $('#date-label').textContent=days===1?shortDate(week):`${shortDate(week)} – ${shortDate(addDays(week,6))}`;
  const shifts=visible(),dates=Array.from({length:days},(_,i)=>addDays(week,i));
  const rows=group==='location'?['',...locations.map(l=>l.name)]:['',...people];
  const rowColor=name=>locations.find(l=>l.name===name)?.color||'#96a7b5';
  const totals=summary(shifts);
  $('#schedule-subtitle').textContent=query||status!=='all'||person!=='all'?`${shifts.length} shifts match your filters`:"Your team's week at a glance";
  let html=`<div class="calendar-row calendar-head"><div class="search-cell"><input id="row-search" aria-label="Search shifts" placeholder="⌕  Search" value="${escape(query)}"></div>`;
  for(const date of dates){const list=shifts.filter(s=>s.date===date);html+=`<div class="day-head"><span class="day-title ${date===today?'today':''}">${fromKey(date).toLocaleDateString('en-US',{weekday:'short'})} ${fromKey(date).getMonth()+1}/${fromKey(date).getDate()}</span><div class="day-stats">◷ ${list.length?hours(summary(list).hours):'--'} &nbsp; ▤ ${list.length}</div><div class="day-bar">${list.map(s=>`<i style="background:${rowColor(s.location)}"></i>`).join('')}</div></div>`;}html+='</div>';
  for(const name of rows){
    const list=shifts.filter(s=>s[group]===name),stats=summary(list);
    html+=`<div class="calendar-row ${!name?'unassigned':''}"><div class="row-label" style="--row-color:${rowColor(name)}"><span>${escape(name||(group==='location'?'Shifts without a Location':'Unassigned shifts'))}</span>${name?`<small>◷ ${hours(stats.hours)} &nbsp; ▤ ${stats.shifts} &nbsp; ♙ ${stats.users}</small>`:''}</div>`;
    for(const date of dates){html+=`<div class="slot ${[0,6].includes(fromKey(date).getDay())?'weekend':''}">`;
      for(const shift of list.filter(s=>s.date===date)){
        const done=shift.tasks.filter(t=>t.done).length;
        html+=`<button class="shift ${shift.status}" data-shift="${escape(shift.id)}" style="--shift-color:${rowColor(shift.location)}" aria-label="${escape(`${shift.location||'No location'}, ${shift.date}, ${time(shift.start)} to ${time(shift.end)}, ${shift.user||'Unassigned'}, ${shift.status}`)}"><div class="shift-content">${shift.status==='draft'?'<span class="draft-label">Draft</span>':''}<span class="shift-time">${time(shift.start)} - ${time(shift.end)}</span><span class="shift-user">${escape(group==='location'?(shift.user||'♙ Open shift'):(shift.location||'No location'))}</span></div><div class="shift-task"><span class="task-track"><i style="width:${shift.tasks.length?done/shift.tasks.length*100:0}%"></i></span>${done}/${shift.tasks.length}</div></button>`;
      }
      html+=`<button class="add-cell" data-date="${date}" data-row="${escape(name)}" aria-label="Add shift ${escape(name||'unassigned')} ${date}">+</button></div>`;
    }html+='</div>';
  }
  $('#calendar').style.setProperty('--days',days);$('#calendar').innerHTML=html;
  $('#calendar').style.minWidth=days===1?'420px':'950px';
  $('#summary').innerHTML=`<span class="summary-title">${days===7?'Weekly':'Daily'} summary</span>${[['◷','Hours',hours(totals.hours)],['▤','Shifts',totals.shifts],['♙','Users',totals.users]].map(([icon,label,value])=>`<div class="stat"><span class="stat-icon">${icon}</span>${label}<strong>${value}</strong></div>`).join('')}`;
  const drafts=shifts.filter(s=>s.status==='draft').length;$('#publish').textContent=`Publish (${drafts})`;$('#publish').disabled=!drafts;
  $('#row-search').addEventListener('input',e=>{const pos=e.target.selectionStart;query=e.target.value.toLowerCase();$('#global-search').value=query;render();$('#row-search').focus();$('#row-search').setSelectionRange(pos,pos);});
  $$('[data-shift]').forEach(b=>b.onclick=()=>openEditor(data.shifts.find(s=>s.id===b.dataset.shift)));
  $$('.add-cell').forEach(b=>b.onclick=()=>openEditor(null,b.dataset.date,b.dataset.row));
  $('#save-state').textContent=storageBlocked?'⚠ Existing saved data could not be loaded':'✓ All changes saved locally';
}
const form=$('#shift-form');
function field(name){return form.elements.namedItem(name);}
function updateDuration(){const s={start:field('start').value,end:field('end').value};$('#duration').textContent=s.start&&s.end?hours(duration(s))+' hrs':'';}
function updateAddress(){$('#address').textContent='⌖  '+(locations.find(l=>l.name===field('location').value)?.address||'No location selected');}
function openEditor(shift,date=week,row=''){
  editing=shift?.id||null;tasks=structuredClone(shift?.tasks||[]);
  const draft=shift||{date,start:'09:00',end:'17:00',location:group==='location'?row:'',user:group==='user'?row:'',note:''};
  for(const key of ['date','start','end','location','user','note'])field(key).value=draft[key];
  $('#editor-title').textContent=shift?'Edit shift':'New shift';$('#editor-status').textContent=shift?.status||'Draft';
  $('#delete-shift').hidden=!shift;$('#form-error').textContent='';updateDuration();updateAddress();renderTasks();switchTab('details');$('#editor').showModal();field('date').focus();
}
function switchTab(tab){$$('[data-tab]').forEach(b=>b.classList.toggle('selected',b.dataset.tab===tab));$('#details-panel').hidden=tab!=='details';$('#tasks-panel').hidden=tab!=='tasks';}
function renderTasks(){
  $('#task-count').textContent=`(${tasks.length})`;
  $('#task-list').innerHTML=tasks.map((t,i)=>`<div class="task-item ${t.done?'done':''}"><input type="checkbox" data-task="${i}" ${t.done?'checked':''} aria-label="${escape(t.text)}"><span>${escape(t.text)}</span><button type="button" data-remove-task="${i}" aria-label="Remove ${escape(t.text)}">×</button></div>`).join('');
  $$('[data-task]').forEach(b=>b.onchange=()=>{tasks[Number(b.dataset.task)].done=b.checked;renderTasks();});
  $$('[data-remove-task]').forEach(b=>b.onclick=()=>{tasks.splice(Number(b.dataset.removeTask),1);renderTasks();});
}
function addTask(){const input=$('#new-task'),text=input.value.trim();if(!text)return;if(tasks.length>=50){toast('A shift can have up to 50 tasks.');return;}tasks.push({text,done:false});input.value='';renderTasks();input.focus();}
$('#add-task').onclick=addTask;$('#new-task').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();addTask();}};
$$('[data-tab]').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
field('location').innerHTML='<option value="">No location</option>'+locations.map(l=>`<option>${l.name}</option>`).join('');
field('user').innerHTML='<option value="">Unassigned / open shift</option>'+people.map(p=>`<option>${p}</option>`).join('');
$('#person-filter').innerHTML='<option value="all">All team members</option><option value="">Unassigned</option>'+people.map(p=>`<option>${p}</option>`).join('');
field('location').onchange=updateAddress;field('start').oninput=updateDuration;field('end').oninput=updateDuration;
form.onsubmit=e=>{
  e.preventDefault();const shift={id:editing||crypto.randomUUID(),...Object.fromEntries(new FormData(form)),status:e.submitter?.value||'draft',tasks:structuredClone(tasks)};
  const error=validateShift(shift);if(error){$('#form-error').textContent=error;return;}
  const next={...data,shifts:editing?data.shifts.map(s=>s.id===editing?shift:s):[...data.shifts,shift]};
  if(!commit(next))return;$('#editor').close();render();toast(shift.status==='published'?'Shift published in this local workspace.':'Draft saved.');
};
$('#close-editor').onclick=()=>$('#editor').close();
$('#delete-shift').onclick=()=>{
  const removed=data.shifts.find(s=>s.id===editing);if(!removed)return;
  if(!commit({...data,shifts:data.shifts.filter(s=>s.id!==editing)}))return;
  $('#editor').close();render();toast('Shift deleted.',()=>{if(commit({...data,shifts:[...data.shifts,removed]}))render();});
};
$('#add').onclick=()=>openEditor();$('#prev').onclick=()=>{week=addDays(week,-days);render();};$('#next').onclick=()=>{week=addDays(week,days);render();};
function goToday(){week=days===7?monday(today):today;render();}
$('#today').onclick=goToday;$('#date-label').onclick=goToday;$('#schedule-nav').onclick=goToday;
$('#range').onchange=e=>{days=Number(e.target.value);if(days===7)week=monday(week);render();};$('#group').onchange=e=>{group=e.target.value;render();};
$('#global-search').oninput=e=>{query=e.target.value.toLowerCase();render();};$('#filter-toggle').onclick=()=>{$('#filter-bar').hidden=!$('#filter-bar').hidden;};
$('#status-filter').onchange=e=>{status=e.target.value;render();};$('#person-filter').onchange=e=>{person=e.target.value;render();};
$('#clear-filters').onclick=()=>{status='all';person='all';query='';$('#status-filter').value='all';$('#person-filter').value='all';$('#global-search').value='';render();};
$('#dismiss').onclick=()=>{if(commit({...data,showWelcome:false}))render();};
function info(title,body){$('#info-title').textContent=title;$('#info-body').innerHTML=body;$('#info-dialog').showModal();}
$('#close-info').onclick=()=>$('#info-dialog').close();
$('#publish').onclick=()=>{
  const ids=new Set(visible().filter(s=>s.status==='draft').map(s=>s.id));
  info('Ready to publish?',`<p>Publish ${ids.size} draft shift${ids.size===1?'':'s'} in the current view? Your schedule will be saved locally. No employee notifications will be sent.</p><button class="primary" id="confirm-publish">Publish ${ids.size} shift${ids.size===1?'':'s'}</button>`);
  $('#confirm-publish').onclick=()=>{if(commit({...data,shifts:data.shifts.map(s=>ids.has(s.id)?{...s,status:'published'}:s)})){$('#info-dialog').close();render();toast(`${ids.size} shift${ids.size===1?'':'s'} published locally.`);}};
};
function showPanel(panel){
  if(panel==='users')info('Your team',people.map((p,i)=>`<div class="person-card"><span class="avatar" style="background:${['#ef7380','#9bb392','#87a9d1'][i]}">${p.split(' ').map(v=>v[0]).join('')}</span><div><strong>${p}</strong><p>${i?'Team member':'Workspace admin'} · ${data.shifts.filter(s=>s.user===p).length} scheduled shifts</p></div></div>`).join(''));
  if(panel==='locations')info('Location list',locations.map(l=>`<div class="person-card"><span class="location-dot" style="background:${l.color}"></span><div><strong>${l.name}</strong><p>${l.address}</p></div></div>`).join(''));
  if(panel==='overview'){const stats=summary(data.shifts);info('Workspace overview',`<p>A snapshot of your locally saved schedule, across all dates.</p><div class="info-stats"><div>Shifts<strong>${stats.shifts}</strong></div><div>Hours<strong>${hours(stats.hours)}</strong></div><div>Team members<strong>${stats.users}</strong></div></div><p>${data.shifts.filter(s=>s.status==='draft').length} draft shifts are waiting to be published.</p>`);}
  if(panel==='guide')info('Make the week work for you',`<ol><li><strong>Plan your week.</strong> Use the arrows to browse dates, and choose a day or week view.</li><li><strong>Add a shift.</strong> Click an empty cell or Add shift. Pick a location, team member, and start/end time.</li><li><strong>Make it clear.</strong> Include notes and a task checklist, then save as a draft.</li><li><strong>Publish when ready.</strong> Publish individual shifts or the drafts in the current view.</li></ol><p>This independent reconstruction stores data in this browser only. It is not connected to Connecteam. Sample names and addresses are demo data.</p>`);
}
$$('[data-panel]').forEach(b=>b.onclick=()=>showPanel(b.dataset.panel));$('#help').onclick=()=>showPanel('guide');$('#rail-help').onclick=()=>showPanel('guide');
$('#settings').onclick=()=>{info('Schedule settings',`<p>Your workspace saves automatically in this browser.</p><label class="settings-label"><input type="checkbox" id="show-welcome" ${data.showWelcome!==false?'checked':''}> Show getting started banner</label><p>Timezone: America/New_York<br>Week starts on Monday. Overnight shifts end the following day.</p><button id="backup">Download schedule backup</button>`);$('#show-welcome').onchange=e=>{if(commit({...data,showWelcome:e.target.checked}))render();};$('#backup').onclick=()=>download('schedule-backup.json',JSON.stringify(data,null,2),'application/json');};
function download(name,content,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
$('#export').onclick=()=>{const cell=v=>'"'+String(v).replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';const lines=[['Date','Start','End','Location','User','Status','Hours','Note'],...visible().map(s=>[s.date,s.start,s.end,s.location,s.user,s.status,duration(s),s.note])];download('schedule-'+week+'.csv',lines.map(row=>row.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8');toast('Current schedule view exported.');};
render();
if(storageBlocked)toast('Existing saved data could not be loaded. It has been preserved, and saving is disabled.');
