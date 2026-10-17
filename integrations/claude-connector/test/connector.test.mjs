import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRunner } from '../src/runner.mjs';
import { makeServer } from '../src/server.mjs';

const SID='9ef98370-1111-4222-8333-777777777777';
async function fakeRunner(exit=0){
  const dir=await mkdtemp(join(tmpdir(),'claude-bridge-'));
  let calls=[];
  function spawnFake(command,args,opts){
    const proc=new EventEmitter();proc.pid=process.pid;proc.stdout=new PassThrough();proc.stderr=new PassThrough();
    proc.kill=()=>{};
    calls.push({command,args,opts,proc});
    queueMicrotask(()=>{
      proc.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:SID,model:'claude'})+'\n');
      proc.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Claude reply'}]}})+'\n');
      proc.stdout.write(JSON.stringify({type:'result',result:'Claude final',session_id:SID})+'\n');
      proc.stdout.end();proc.stderr.end();proc.emit('close',exit,null);
    });
    return proc;
  }
  const runner=new ClaudeRunner({roots:[dir],stateFile:join(dir,'sessions.json'),spawnImpl:spawnFake});
  await runner.load();return {runner,calls,dir};
}
test('send and resume session without a shell, and persist id',async()=>{
  const {runner,calls,dir}=await fakeRunner();
  const a=await runner.ask({message:'hello'});
  assert.equal(a.state,'done');assert.equal(a.text,'Claude final');assert.equal(a.session_id,SID);
  const persisted=JSON.parse(await readFile(join(dir,'sessions.json'),'utf8'));
  assert.ok(persisted.sessions[SID]);
  const b=await runner.ask({message:'followup',session_id:SID});
  assert.equal(b.state,'done');assert.ok(calls[1].args.includes('--resume'));
  assert.ok(calls[1].args.includes(SID));
  assert.equal(calls[0].command,'claude');
  assert.equal(calls[0].opts.shell,undefined);
  assert.equal(runner.listSessions().length,1);
});
test('invalid messages, paths, modes and unrecognized session rejected',async()=>{
  const {runner}=await fakeRunner();
  await assert.rejects(runner.start({message:' '}),/message must/);
  await assert.rejects(runner.start({message:'hi',cwd:'/etc'}),/outside/);
  await assert.rejects(runner.start({message:'hi',permission_mode:'bypassPermissions'}),/invalid permission/);
  await assert.rejects(runner.start({message:'hi',session_id:'not_a_uuid'}),/invalid session/);
});
test('authenticated MCP initialize, tools/list and claude_ask; rejects no token',async()=>{
  const {runner}=await fakeRunner();
  const {server,address}=await makeServer({runner,authOptions:{sharedToken:'my-secret-token'}});
  const base=`http://127.0.0.1:${address.port}`;
  try{
    const post=(json,token)=>fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(json)});
    const unauth=await post({jsonrpc:'2.0',id:1,method:'tools/list'});
    assert.equal(unauth.status,401);
    const init=await (await post({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}},'my-secret-token')).json();
    assert.equal(init.result.serverInfo.name,'claude-connector');
    const tools=await (await post({jsonrpc:'2.0',id:2,method:'tools/list'},'my-secret-token')).json();
    assert.deepEqual(tools.result.tools.map(x=>x.name),['claude_ask','claude_start','claude_read','claude_sessions','claude_stop']);
    const call=await (await post({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'claude_ask',arguments:{message:'Ping'}}},'my-secret-token')).json();
    assert.equal(JSON.parse(call.result.content[0].text).text,'Claude final');
    const health=await (await fetch(base+'/healthz')).json(); assert.equal(health.ok,true);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
