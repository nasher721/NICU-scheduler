import test from 'node:test';
import assert from 'node:assert/strict';
import {monday,addDays,duration,summary,validateShift,seed,parseSaved} from './model.js';
test('week navigation handles Sundays and year boundaries',()=>{assert.equal(monday('2026-10-25'),'2026-10-19');assert.equal(addDays('2026-12-28',7),'2027-01-04');assert.equal(monday('2026-10-19'),'2026-10-19');});
test('sample schedule matches observed six shifts and 48 hours',()=>{const shifts=seed('2026-10-19');assert.deepEqual(summary(shifts),{hours:48,shifts:6,users:3});assert.equal(shifts.filter(s=>s.status==='draft').length,1);assert.ok(shifts.every(s=>validateShift(s)===''));});
test('overnight and partial-hour shifts retain exact duration',()=>{assert.equal(duration({start:'22:00',end:'06:00'}),8);assert.equal(duration({start:'09:15',end:'17:45'}),8.5);});
test('invalid dates, times, users and equal times rejected',()=>{const s=seed('2026-10-19')[0];for(const patch of [{date:'2026-02-31'},{date:'garbage'},{start:'25:00'},{end:'09:00'},{user:'Unknown'},{location:'Unknown'},{tasks:[{text:'Task'}]}])assert.ok(validateShift({...s,...patch}));});
test('saved schedule roundtrips and corrupt data is rejected',()=>{const data={version:1,shifts:seed('2026-10-19'),showWelcome:false};assert.deepEqual(parseSaved(JSON.stringify(data)),data);for(const raw of ['{',JSON.stringify({...data,version:2}),JSON.stringify({...data,shifts:[data.shifts[0],data.shifts[0]]}),JSON.stringify({...data,shifts:[null]})])assert.throws(()=>parseSaved(raw));});
