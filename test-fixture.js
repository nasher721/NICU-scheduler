import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const workbookPath = process.env.WORKBOOK_FIXTURE || join(homedir(),'Downloads','MASTER_NEW_CALENDAR_NICU_Staff_SCHEDULE 2.xlsx');
export const hasWorkbook = existsSync(workbookPath);
export async function smallWorkbook() {
  const book = new ExcelJS.Workbook();
  const schedule=book.addWorksheet('2026 Sch');
  schedule.addRow(['Month','G20','H22','Akron','Nights','Consults','NMET','CDI','Jeopardy','Recovery','Vacations']);
  schedule.addRow(['January']);
  schedule.addRow([new Date('2026-01-01T00:00:00Z'),'Lee','Rosales','Lee','Lee (day Moonlighting)',null,null,null,null,'Lee & Rosales']);
  schedule.getCell('B3').font={strike:true};
  schedule.getCell('O3').value='Rotation name, not a dated assignment';
  schedule.getCell('A4').value=new Date('2026-01-02T00:00:00Z');schedule.getCell('B4').value='Lee';
  const targets=book.addWorksheet('Sheet1');targets.addRow(['Staff','FTE Week','FTE Weekend']);
  targets.addRow(['Lee',12,6]);targets.addRow(['Villamizar Rosales',10,4]);
  targets.addRow([null,{formula:'SUM(B2:B2)',result:12},{formula:'SUM(C2:C2)',result:6}]);
  const old=book.addWorksheet('2025 second half');old.addRow(['Month','G20','H22','Akron','Nights','Consults']);old.addRow([new Date('2026-01-01T00:00:00Z'),'Lee']);
  const hidden=book.addWorksheet('Private notes',{state:'hidden'});hidden.getCell('A100').value='<img src=x onerror=alert(1)>';
  return Buffer.from(await book.xlsx.writeBuffer());
}
