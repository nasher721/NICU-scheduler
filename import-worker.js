import { parentPort, workerData } from 'node:worker_threads';
import { parseWorkbook } from './workbook-import.js';
try { parentPort.postMessage({ data: await parseWorkbook(Buffer.from(workerData.bytes), workerData.filename) }); }
catch (error) { parentPort.postMessage({ error: error.message }); }
