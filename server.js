import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createStore } from './workbook-store.js';

const MAX_UPLOAD = 10 * 1024 * 1024;
const files = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/model.js': ['model.js','text/javascript'],
  '/styles.css': ['styles.css','text/css'], '/workbook-ui.js': ['workbook-ui.js','text/javascript'], '/workbook-model.js': ['workbook-model.js','text/javascript'], '/scheduling.js':['scheduling.js','text/javascript'], '/workbook.css': ['workbook.css','text/css'] };
async function body(req, max) {
  if (Number(req.headers['content-length']) > max) throw Object.assign(new Error('Upload is too large.'), { status: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error('Upload is too large.'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export function parseInWorker(bytes, filename) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import-worker.js',import.meta.url), { workerData: { bytes, filename }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(()=>{worker.terminate(); reject(new Error('Workbook parsing exceeded 20 seconds. No data was saved.'));},20000);
    worker.once('message',message=>{clearTimeout(timer); worker.terminate(); message.error ? reject(new Error(message.error)) : resolve(message.data);});
    worker.once('error',()=>{clearTimeout(timer); reject(new Error('Workbook parsing failed. No data was saved.'));});
    worker.once('exit',code=>{clearTimeout(timer); if(code!==0) reject(new Error('Workbook parser stopped before completion.'));});
  });
}
export function createApp({ dbPath = resolve('.data/workspace.sqlite') } = {}) {
  const store = createStore(dbPath), token = randomBytes(32).toString('hex');
  let importing = false;
  const server = http.createServer(async (req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY');
    const json = (status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data));};
    try {
      const host = req.headers.host, port = req.socket.localPort;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return json(403,{error:'Use the local workspace address.'});
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(403,{error:'Requests must come from this workspace.'});
      const url = new URL(req.url,`http://${host}`), path = url.pathname;
      if (path.startsWith('/api/') && req.method !== 'GET' && req.headers['x-workspace-token'] !== token) return json(403,{error:'Reload this workspace before saving.'});
      if (path === '/api/imports' && req.method === 'GET') return json(200,{imports:store.list(),token});
      if (path === '/api/imports' && req.method === 'POST') {
        if (importing) return json(409,{error:'Another workbook is being imported. Please try again when it finishes.'});
        importing = true;
        try {
          let filename;
          try { filename = decodeURIComponent(req.headers['x-filename'] ?? ''); } catch { throw new Error('Invalid file name.'); }
          if (!filename || filename.length > 240 || /[\\/\u0000-\u001f]/.test(filename)) throw new Error('Choose a valid workbook file name.');
          const bytes = await body(req,MAX_UPLOAD), workbook = await parseInWorker(bytes,filename);
          return json(200,store.import(workbook,bytes));
        } finally { importing = false; }
      }
      const match = path.match(/^\/api\/imports\/([a-f0-9]{64})(?:\/(source|backup|review|reviews|workspace)(?:\/([a-f0-9]{24}))?)?$/);
      if (match) {
        const [,id,action,issueId] = match, snapshot = store.get(id);
        if (!snapshot) return json(404,{error:'Workbook not found.'});
        if (!action && req.method === 'GET') return json(200,snapshot);
        if (action === 'source' && req.method === 'GET') {
          res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="source.xlsx"; filename*=UTF-8''${encodeURIComponent(snapshot.workbook.filename)}`});
          return res.end(Buffer.from(store.original(id)));
        }
        if (action === 'backup' && req.method === 'GET') { res.setHeader('Content-Disposition','attachment; filename="workbook-review-backup.json"'); return json(200,{...snapshot,events:store.events(id),workspaceEvents:store.workspaceEvents(id)}); }
        if ((action === 'reviews'||action === 'workspace') && !issueId && req.method === 'POST') {
          let input;try{input=JSON.parse((await body(req,256000)).toString());}catch{throw new Error('Submit valid JSON under 256 KB.');}
          if(!input||typeof input!=='object')throw new Error('A structured operation is required.');
          return json(200,action==='reviews'?store.reviewMany(id,input.revision,input.items):store.updateWorkspace(id,input.revision,input.operation));
        }
        if (action === 'review' && issueId && req.method === 'POST') {
          let input;
          try { input = JSON.parse((await body(req,16000)).toString()); } catch { throw new Error('Review request must be valid JSON under 16 KB.'); }
          return json(200,store.review(id,issueId,input.revision,input.decision));
        }
        return json(405,{error:'Method not allowed.'});
      }
      if (path.startsWith('/api/')) return json(404,{error:'Endpoint not found.'});
      const file = files[path];
      if (!file || !['GET','HEAD'].includes(req.method)) {res.writeHead(404); return res.end('Not found');}
      const content = await readFile(new URL(file[0],import.meta.url));
      res.writeHead(200,{'Content-Type':file[1]+'; charset=utf-8'});res.end(req.method==='HEAD'?undefined:content);
    } catch (error) { if(!res.headersSent) json(error.status ?? 400,{error:error.code?.startsWith('SQLITE')?'The workspace could not save this change. Your previous data is intact.':error.message}); }
  });
  server.requestTimeout = 30000;
  return { server, store, close: () => new Promise((resolve,reject)=>server.close(error=>{store.close();error?reject(error):resolve();})) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp({dbPath:process.env.SCHEDULE_DB || resolve('.data/workspace.sqlite')});
  app.server.listen(Number(process.env.PORT || 5173),'127.0.0.1',()=>console.log(`Scheduler ready at http://127.0.0.1:${app.server.address().port}`));
}
