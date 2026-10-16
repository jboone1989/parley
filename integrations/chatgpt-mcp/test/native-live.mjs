import assert from "node:assert/strict";
import {ParleyBridge} from "../bridge.mjs";
import {nativeRequest} from "../native-api.mjs";
const bridge=new ParleyBridge(), prefix="mcp-native-"+Date.now().toString(36);
const names=[prefix+"-a",prefix+"-b"], cleanup=new Set();
async function request(path,body){
 const r=await nativeRequest(bridge,{path,method:body===undefined?"GET":"POST",...(body===undefined?{}:{body})});
 assert.ok(r.status>=200&&r.status<300,JSON.stringify(r.json));return r;
}
async function main(){
 try{
  for(const name of names){await request("/api/rooms",{name});cleanup.add(name);}
  const listing=(await request("/api/rooms")).json.rooms.map(r=>typeof r==="string"?r:r.name);
  for(const name of names)assert.ok(listing.includes(name));
  await request("/api/config",{room:names[0],config:{roomNote:"独立会话 A"}});
  assert.equal((await request("/api/room?name="+names[0])).json.room.cfg.roomNote,"独立会话 A");
  assert.notEqual((await request("/api/room?name="+names[1])).json.room.cfg.roomNote,"独立会话 A");
  for(const agent of ["claude","codex"])await request("/api/seat/sleep",{room:names[0],agent,asleep:true});
  const file=Buffer.from("真实附件原文 $&\n","utf8");
  await request("/api/message",{room:names[0],target:"claude",text:"附件桥接验收；保持休眠，不启动模型。",files:[{name:"native-check.txt",mime:"text/plain",data:file.toString("base64")}]});
  const snapshot=(await request("/api/room?name="+names[0])).json;
  assert.deepEqual(snapshot.room.busy,[]);
  const refs=snapshot.entries.flatMap(entry=>entry.meta?.attachments||[]);
  assert.ok(refs.length>0,"attachment reference missing");
  const attachment=await request("/api/attachment?room="+names[0]+"&id="+encodeURIComponent(refs[0].id));
  assert.deepEqual(Buffer.from(attachment.base64,"base64"),file);
  const transcript=await request("/api/transcript?room="+names[0]);
  assert.ok(Buffer.from(transcript.base64,"base64").toString().includes("附件桥接验收"));
  assert.equal((await request("/api/room?name="+names[1])).json.entries.length,0);
  const renamed=names[0]+"-renamed";await request("/api/room/rename",{room:names[0],to:renamed});cleanup.delete(names[0]);cleanup.add(renamed);
  assert.equal((await request("/api/room?name="+renamed)).json.room.name,renamed);
  console.log(JSON.stringify({ok:true,multipleRooms:true,independentState:true,realAttachmentBytes:true,transcript:true,rename:true,noModelTurns:true}));
 }finally{
  for(const room of cleanup){await request("/api/new",{room}).catch(()=>{});await request("/api/room/delete",{room});}
 }
}
main().then(()=>process.exit(0),err=>{console.error(err.stack);process.exit(1);});
