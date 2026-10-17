import http from 'node:http';
import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { ClaudeRunner } from './runner.mjs';

const TOOL_LIST=[
  {name:'claude_ask',description:'Ask an authenticated Claude Code CLI and wait for a reply. Reuse session_id for follow-ups; no Parley, GitHub or review workflow is imposed.',inputSchema:{type:'object',properties:{message:{type:'string'},session_id:{type:'string'},cwd:{type:'string'},permission_mode:{type:'string',enum:['default','plan','acceptEdits']},wait_ms:{type:'integer',minimum:1000,maximum:120000}},required:['message']}},
  {name:'claude_start',description:'Start a Claude CLI turn and return a job ID immediately. Read progress with claude_read. Useful for long actions.',inputSchema:{type:'object',properties:{message:{type:'string'},session_id:{type:'string'},cwd:{type:'string'},permission_mode:{type:'string',enum:['default','plan','acceptEdits']}},required:['message']}},
  {name:'claude_read',description:'Read incremental Claude CLI output, tool progress, final status, and session_id from a job.',inputSchema:{type:'object',properties:{job_id:{type:'string'},after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:200}},required:['job_id']}},
  {name:'claude_sessions',description:'List resumable Claude Code CLI sessions created through this connector.',inputSchema:{type:'object',properties:{}}},
  {name:'claude_stop',description:'Stop an active Claude CLI job.',inputSchema:{type:'object',properties:{job_id:{type:'string'}},required:['job_id']}}
];
export const tools=TOOL_LIST;
const supportedVersions=['2025-11-25','2025-06-18','2025-03-26','2026-07-28'];
const asText=o=>({content:[{type:'text',text:JSON.stringify(o)}],isError:false});
const b64url=x=>Buffer.from(x,'base64url');
const safeEqual=(a,b)=>{const ab=Buffer.from(a),bb=Buffer.from(b);return ab.length===bb.length&&timingSafeEqual(ab,bb);};

async function jwtFromCloudflare(req,{teamDomain,audience,fetchImpl=fetch}){
  const jwt=req.headers['cf-access-jwt-assertion'];
  if(typeof jwt!=='string'||!teamDomain||!audience) return false;
  const parts=jwt.split('.');if(parts.length!==3)return false;
  try{
    const header=JSON.parse(b64url(parts[0]).toString('utf8'));
    const payload=JSON.parse(b64url(parts[1]).toString('utf8'));
    if(header.alg!=='RS256'||!header.kid||typeof payload.exp!=='number')return false;
    const issuer=`https://${teamDomain.replace(/^https?:\/\//,'').replace(/\/$/,'')}`;
    if(payload.iss!==issuer||payload.exp<=Math.floor(Date.now()/1000)||payload.nbf>Math.floor(Date.now()/1000)+30)return false;
    if(!(Array.isArray(payload.aud)?payload.aud:[payload.aud]).includes(audience))return false;
    const response=await fetchImpl(`${issuer}/cdn-cgi/access/certs`);
    if(!response.ok)return false;
    const keys=(await response.json()).keys||[];
    const key=keys.find(k=>k.kid===header.kid&&k.kty==='RSA');if(!key)return false;
    return verifySignature('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key,format:'jwk'}),b64url(parts[2]));
  }catch{return false;}
}
export async function authorized(req,options={}){
  const sharedToken=options.sharedToken??process.env.MCP_ACCESS_TOKEN;
  const auth=req.headers.authorization??'';
  if(sharedToken && typeof auth==='string' && auth.startsWith('Bearer ') && safeEqual(auth.slice(7),sharedToken))return true;
  const teamDomain=options.teamDomain??process.env.CLOUDFLARE_TEAM_DOMAIN;
  const audience=options.audience??process.env.CLOUDFLARE_ACCESS_AUD;
  if(teamDomain&&audience)return jwtFromCloudflare(req,{teamDomain,audience,fetchImpl:options.fetchImpl});
  return false;
}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));}
function errorResult(id,code,message){return {jsonrpc:'2.0',id,error:{code,message}};}
async function dispatch(req,runner){
  const {id,method,params={}}=req??{};
  if(req?.jsonrpc!=='2.0'||typeof method!=='string')return errorResult(id??null,-32600,'Invalid Request');
  if(method==='initialize')return {jsonrpc:'2.0',id,result:{protocolVersion:supportedVersions.includes(params.protocolVersion)?params.protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:false}},serverInfo:{name:'claude-connector',version:'0.1.0'},instructions:'Use Claude Code CLI as a general capability. Resume via session_id; tools do not impose fixed roles.'}};
  if(method==='notifications/initialized'||method==='ping')return id===undefined?null:{jsonrpc:'2.0',id,result:{}};
  if(method==='tools/list')return {jsonrpc:'2.0',id,result:{tools:TOOL_LIST}};
  if(method==='tools/call'){
    const args=params.arguments??{};
    try{
      let output;
      if(params.name==='claude_ask')output=await runner.ask(args);
      else if(params.name==='claude_start')output=await runner.start(args);
      else if(params.name==='claude_read')output=runner.status(args.job_id,args);
      else if(params.name==='claude_sessions')output=runner.listSessions();
      else if(params.name==='claude_stop')output=runner.stop(args.job_id);
      else return errorResult(id,-32602,'Unknown tool');
      return {jsonrpc:'2.0',id,result:asText(output)};
    }catch(e){return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:String(e.message||e)}],isError:true}};}
  }
  return errorResult(id,-32601,'Method not found');
}
export async function makeServer({runner,host='127.0.0.1',port=0,authOptions={}}={}){
  const actual=runner??new ClaudeRunner({roots:(process.env.CLAUDE_ALLOWED_ROOTS||process.cwd()).split(':'),stateFile:process.env.CLAUDE_STATE_FILE});
  await actual.load();
  const server=http.createServer(async(req,res)=>{
    const path=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`).pathname;
    if(path==='/healthz'&&req.method==='GET')return json(res,200,{ok:true,name:'claude-connector'});
    if(path!=='/mcp')return json(res,404,{error:'not found'});
    if(!(await authorized(req,authOptions)))return json(res,401,{error:'authentication required'});
    if(req.method==='GET')return res.writeHead(405,{allow:'POST, DELETE'}).end();
    if(req.method==='DELETE')return json(res,200,{ok:true});
    if(req.method!=='POST')return json(res,405,{error:'method not allowed'});
    let body='';
    try{
      for await(const chunk of req){body+=chunk;if(body.length>200_000){json(res,413,{error:'request too large'});return;}}
      const payload=JSON.parse(body);
      if(Array.isArray(payload))return json(res,400,errorResult(null,-32600,'Batch not supported'));
      const result=await dispatch(payload,actual);
      if(result===null){res.writeHead(202);return res.end();}
      return json(res,200,result);
    }catch{return json(res,400,errorResult(null,-32700,'Invalid JSON'));}
  });
  await new Promise((resolvePromise,reject)=>{server.once('error',reject);server.listen(port,host,resolvePromise);});
  return {server,runner:actual,address:server.address()};
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
  const host=process.env.CLAUDE_MCP_HOST??'127.0.0.1';
  const port=Number(process.env.CLAUDE_MCP_PORT??'8791');
  const enabled=!!process.env.MCP_ACCESS_TOKEN || !!(process.env.CLOUDFLARE_TEAM_DOMAIN&&process.env.CLOUDFLARE_ACCESS_AUD);
  if(!enabled){console.error('Set MCP_ACCESS_TOKEN or Cloudflare Access team domain + audience before serving.');process.exit(1);}
  makeServer({host,port}).then(({address})=>console.log(`claude-connector listening ${address.address}:${address.port}`)).catch(e=>{console.error(e);process.exit(1);});
}
