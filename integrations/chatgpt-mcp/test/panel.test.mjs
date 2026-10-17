import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PanelSessions } from "../panel-auth.mjs";
import { createPanelHandler } from "../panel-server.mjs";

test("panel credentials expire, are origin-bound and are stored only as hashes", () => {
  let time = 1000;
  const sessions = new PanelSessions({ now: () => time, ttl: 100 });
  const value = sessions.issue("https://web-sandbox.oaiusercontent.com");
  assert.ok(sessions.verify(value.token, value.origin));
  assert.equal(sessions.verify(value.token, "https://attacker.test"), null);
  assert.equal(sessions.verify("wrong", value.origin), null);
  assert.equal(sessions.sessions.has(value.token), false);
  time = 1101; assert.equal(sessions.verify(value.token, value.origin), null);
  assert.throws(() => sessions.issue("null"));
  assert.throws(() => sessions.issue("http://example.com"));
  assert.throws(() => sessions.issue("https://example.com/path"));
});

test("direct HTTP rejects unauthenticated/cross-origin access and streams resumable native events", async t => {
  const client = "https://web-sandbox.oaiusercontent.com";
  let writes = 0, watchCalls = 0;
  const upstream = createServer((req,res) => {
    assert.equal(req.headers["x-parley-token"], "loopback-only");
    writes++; res.writeHead(200,{"content-type":"application/json"}); res.end('{"ok":true}');
  });
  await new Promise(resolve=>upstream.listen(0,"127.0.0.1",resolve));
  const bridge = {
    base: "http://127.0.0.1:"+upstream.address().port, auth: {token:"loopback-only",protocol:"12"},
    snapshot: async name=>({room:{name},entries:[],cursor:4,streams:{claude:"前缀"}}),
    rooms: async()=>({rooms:[{name:"a"}]}),
    watch: async ({after,signal})=>{
      watchCalls++;
      if(after===4)return {room:"a",connected:true,cursor:5,resync:false,events:[{seq:5,type:"stream",agent:"claude",from:2,delta:" 原文 $&"}]};
      await new Promise(resolve=>{
        if(signal.aborted)return resolve(); signal.addEventListener("abort",resolve,{once:true});
      });
      return {room:"a",connected:true,cursor:5,resync:false,events:[]};
    },
  };
  const sessions=new PanelSessions();
  const handle=createPanelHandler({bridge,sessions});
  const server=createServer(async(req,res)=>{if(!await handle(req,res)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{
    server.closeAllConnections();upstream.closeAllConnections();
    await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);
  });
  const base="http://127.0.0.1:"+server.address().port;
  const {token}=sessions.issue(client), headers={origin:client,authorization:"Bearer "+token};
  assert.equal((await fetch(base+"/panel/ping")).status,403);
  assert.equal((await fetch(base+"/panel/ping",{headers:{origin:client}})).status,401);
  assert.equal((await fetch(base+"/panel/ping?token="+token,{headers})).status,401);
  assert.equal((await fetch(base+"/panel/ping",{headers:{...headers,origin:"https://attacker.test"}})).status,401);
  assert.equal(writes,0);
  const preflight=await fetch(base+"/panel/request",{method:"OPTIONS",headers:{origin:client}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get("access-control-allow-origin"),client);
  assert.equal(preflight.headers.get("access-control-allow-credentials"),null);
  const snapshot=await fetch(base+"/panel/request",{method:"POST",headers:{...headers,"content-type":"application/json"},
    body:JSON.stringify({path:"/api/room?name=a&panel=1",method:"GET"})});
  assert.equal(snapshot.status,200);const data=await snapshot.json();
  assert.equal(data.json.cursor,4);assert.equal(data.json.panel.rooms.rooms[0].name,"a");
  assert.ok(snapshot.headers.get("server-timing"));
  const forbidden=await fetch(base+"/panel/request",{method:"POST",headers:{...headers,"content-type":"application/json"},
    body:JSON.stringify({path:"https://attacker.test/",method:"POST"})});
  assert.equal(forbidden.status,400);assert.equal(writes,0);
  const write=await fetch(base+"/panel/request",{method:"POST",headers:{...headers,"content-type":"application/json"},
    body:JSON.stringify({path:"/api/config",method:"POST",body:{room:"a",config:{roomNote:"中文"}}})});
  assert.equal((await write.json()).status,200);assert.equal(writes,1);
  const abort=new AbortController();
  const stream=await fetch(base+"/panel/events?room=a&after=4",{headers,signal:abort.signal});
  assert.match(stream.headers.get("content-type"),/text\/event-stream/);
  const reader=stream.body.getReader();let text="";
  while(!text.includes('"cursor":5'))text+=new TextDecoder().decode((await reader.read()).value);
  assert.ok(text.includes('"delta":" 原文 $&"'));assert.ok(watchCalls>=1);
  abort.abort();await reader.cancel().catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(sessions.verify(token,client).streams,0);
});
