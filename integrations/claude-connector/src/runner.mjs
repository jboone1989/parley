import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const MAX_EVENTS = 400;
const MAX_LINE = 1_000_000;
const MAX_TEXT = 80_000;
const MAX_MESSAGE = 40_000;
const MODES = new Set(['default', 'plan', 'acceptEdits']);

function isWithin(path, root) { return path === root || path.startsWith(root + sep); }
function trimText(value, limit=MAX_TEXT) { return String(value ?? '').slice(-limit); }
function parsed(line) { try { return JSON.parse(line); } catch { return null; } }
function lastAssistantText(event) {
  const content = event?.message?.content;
  return Array.isArray(content) ? content.filter(x => x?.type === 'text').map(x => x.text ?? '').join('\n') : '';
}

export class ClaudeRunner {
  constructor({ command=process.env.CLAUDE_BIN || 'claude', roots, stateFile, spawnImpl=spawn, timeoutMs=900000, now=()=>Date.now() }={}) {
    this.command = command;
    this.roots = (roots ?? [process.cwd()]).map(x=>resolve(x));
    this.stateFile = stateFile ?? resolve(process.cwd(), '.state', 'sessions.json');
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.jobs = new Map();
    this.sessions = new Map();
    this.activeSessions = new Set();
    this._saving = Promise.resolve();
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.stateFile, 'utf8'));
      for (const [k,v] of Object.entries(data.sessions ?? {})) {
        if (v && typeof v === 'object' && typeof v.cwd === 'string') this.sessions.set(k,v);
      }
    } catch(e) { if (e.code !== 'ENOENT') throw e; }
  }
  persist() {
    const payload = JSON.stringify({sessions:Object.fromEntries(this.sessions)},null,2);
    this._saving = this._saving.then(async()=>{
      await mkdir(dirname(this.stateFile), {recursive:true,mode:0o700});
      await writeFile(this.stateFile, payload, {mode:0o600});
    });
    return this._saving;
  }
  cwdFor(input) {
    const candidate=resolve(input || this.roots[0]);
    if (!this.roots.some(root=>isWithin(candidate,root))) throw new Error('cwd is outside configured allowed roots');
    return candidate;
  }
  append(job, type, extra={}) {
    const ev = {seq:++job.cursor, at:new Date(this.now()).toISOString(), type, ...extra};
    job.events.push(ev);
    if (job.events.length>MAX_EVENTS) job.events.splice(0,job.events.length-MAX_EVENTS);
  }
  async start({message, session_id, cwd, permission_mode='default'}={}) {
    if (typeof message!=='string'||!message.trim()||message.length>MAX_MESSAGE) throw new Error('message must be a nonempty string of at most 40000 characters');
    if (!MODES.has(permission_mode)) throw new Error('invalid permission_mode');
    if (session_id && !/^[0-9a-f-]{10,80}$/i.test(session_id)) throw new Error('invalid session_id');
    const directory=this.cwdFor(session_id ? (this.sessions.get(session_id)?.cwd ?? cwd) : cwd);
    if(session_id && this.activeSessions.has(session_id)) throw new Error('Claude session already has an active job');
    const id=randomUUID();
    const job={id,state:'running',createdAt:this.now(),updatedAt:this.now(),cursor:0,events:[],text:'',stderr:'',session_id:session_id??null,exit_code:null, process:null,error:null};
    const args=['-p',message,'--output-format','stream-json','--verbose','--permission-mode',permission_mode];
    if(session_id) args.push('--resume', session_id);
    const child=this.spawnImpl(this.command,args,{cwd:directory,stdio:['ignore','pipe','pipe'],env:process.env,detached:process.platform!=='win32'});
    job.process=child;
    this.jobs.set(id,job);
    if(session_id)this.activeSessions.add(session_id);
    this.append(job,'start',{cwd:directory});
    let lastAssistant='';
    const timer=setTimeout(()=>this.stop(id,'timeout'),this.timeoutMs);
    timer.unref?.();
    const lineReader=readline.createInterface({input:child.stdout});
    lineReader.on('line',line=>{
      if(line.length>MAX_LINE){this.append(job,'warning',{message:'Oversized CLI event discarded'});return;}
      const event=parsed(line);
      if(!event)return;
      if (event.session_id && /^[0-9a-f-]{10,80}$/i.test(event.session_id)){
        if(job.session_id && job.session_id!==event.session_id) this.activeSessions.delete(job.session_id);
        job.session_id=event.session_id;
        this.activeSessions.add(event.session_id);
        this.sessions.set(event.session_id,{cwd:directory,last_used:new Date(this.now()).toISOString()});
        void this.persist().catch(e=>{this.append(job,'warning',{message:'session persistence failed'});});
      }
      if (event.type==='assistant') {
        const t=lastAssistantText(event);
        if(t && t!==lastAssistant){lastAssistant=t;job.text=trimText(t);this.append(job,'assistant',{text:trimText(t,12000)});}
      } else if(event.type==='result') {
        if(typeof event.result==='string')job.text=trimText(event.result);
        if(event.is_error)job.error='Claude reported an error';
        this.append(job,'result',{is_error:!!event.is_error,text:trimText(job.text,12000)});
      } else if(event.type==='system'&&event.subtype==='init'){
        this.append(job,'session',{session_id:job.session_id,model:event.model ?? null});
      } else if(event.type==='stream_event'&&event.event?.type==='content_block_delta'&&event.event?.delta?.type==='text_delta'){
        this.append(job,'delta',{text:trimText(event.event.delta.text,2000)});
      } else if(event.type==='tool_progress'){
        this.append(job,'tool_progress',{tool_name:String(event.tool_name??'tool').slice(0,120)});
      }
      job.updatedAt=this.now();
    });
    child.stderr.on('data',chunk=>{job.stderr=trimText(job.stderr+String(chunk),4000);});
    job.done = new Promise(resolveDone=>{
      let finished=false;
      const finish=(code,signal,error)=>{
        if(finished)return;
        finished=true;clearTimeout(timer);
        job.state=job.state==='stopping'?'stopped':error||code!==0||job.error?'failed':'done';
        job.exit_code=code;
        job.error=error?.message??job.error??(job.state==='failed'?trimText(job.stderr,800):null);
        job.updatedAt=this.now();
        job.process=null;
        if(job.session_id)this.activeSessions.delete(job.session_id);
        this.append(job,'end',{state:job.state,exit_code:code,signal:signal??null});
        void this._saving.catch(()=>{}).finally(()=>resolveDone(this.status(id,{after:0,limit:MAX_EVENTS})));
      };
      child.on('error',error=>finish(null,null,error));
      child.on('close',(code,signal)=>finish(code,signal));
    });
    return {job_id:id,state:'running',session_id:job.session_id};
  }
  status(jobId,{after=0,limit=100}={}){
    const job=this.jobs.get(jobId);
    if(!job)throw new Error('unknown job_id');
    const n=Math.max(0,Math.floor(Number(after)||0));
    const first=job.events[0]?.seq??job.cursor+1;
    const events=job.events.filter(e=>e.seq>n).slice(0,Math.min(Math.max(Number(limit)||1,1),200));
    return {job_id:job.id,state:job.state,session_id:job.session_id,created_at:new Date(job.createdAt).toISOString(),updated_at:new Date(job.updatedAt).toISOString(),cursor:job.cursor,truncated:n>0 && n<first-1,events,text:job.state==='running'?null:job.text,error:job.error,exit_code:job.exit_code};
  }
  stop(id,reason='user'){
    const job=this.jobs.get(id);
    if(!job)throw new Error('unknown job_id');
    if(!job.process)return {job_id:id,state:job.state};
    job.state='stopping';this.append(job,'stop_requested',{reason});
    try {if(process.platform!=='win32')process.kill(-job.process.pid,'SIGTERM');else job.process.kill('SIGTERM');} catch{try{job.process.kill('SIGTERM');}catch{}}
    return {job_id:id,state:'stopping'};
  }
  listSessions(){return [...this.sessions.entries()].map(([session_id,info])=>({session_id,...info,active:this.activeSessions.has(session_id)})).sort((a,b)=>b.last_used.localeCompare(a.last_used));}
  async ask({wait_ms=90000,...args}){
    const started=await this.start(args);
    const job=this.jobs.get(started.job_id);
    const result=await Promise.race([job.done,new Promise(resolveTimeout=>{const timer=setTimeout(()=>resolveTimeout(null),Math.min(Math.max(Number(wait_ms)||1000,1000),120000));timer.unref?.();})]);
    return result ?? this.status(started.job_id);
  }
}
