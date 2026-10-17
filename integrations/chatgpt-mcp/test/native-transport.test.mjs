import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function harness(handler) {
  const storage = new Map();
  class App { connect() { return new Promise(() => {}); } async callServerTool(request) { return { structuredContent: await handler(request.name, request.arguments) }; } }
  const source = readFileSync(new URL("../native-transport.mjs", import.meta.url), "utf8")
    .replace(/^import .*\n/gm, "").replace(/\bexport /g, "");
  const window = {}, context = vm.createContext({ App, window, EventTarget, Event, MessageEvent, Response, URL,
    URLSearchParams, Uint8Array, atob, setTimeout, sessionStorage: {
      getItem: key => storage.get(key) || null, setItem: (key,value) => storage.set(key,value),
    }, document: { getElementById: () => null } });
  vm.runInContext(source+"\nthis.api = {nativeFetch,NativeEventSource,seeds,call};",context);
  return {...context.api, window};
}
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

test("native fetch forwards original request bodies and recreates binary Responses", async () => {
  let forwarded;
  const ui = harness(async (name,args) => {
    forwarded = {name,args}; return { status: 200, headers: { "content-type":"application/octet-stream", "x-parley-runtime-protocol":"12" }, base64:Buffer.from([0,255,10]).toString("base64") };
  });
  const response = await ui.nativeFetch("/api/message", {method:"POST",body:JSON.stringify({room:"a",target:"auto",hopBudget:3,files:[{data:"AA=="}]})});
  assert.equal(forwarded.name,"native_request");
  assert.equal(forwarded.args.body.hopBudget,3);
  assert.equal(forwarded.args.body.target,"auto");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from([0,255,10]));
  assert.equal(response.headers.get("x-parley-runtime-protocol"),"12");
  await assert.rejects(ui.nativeFetch("https://elsewhere.test/api/rooms"),/External/);
});

test("native event transport resumes at the snapshot boundary and stops after close", async () => {
  const requested = [], ui = harness(async (name,args) => {
    requested.push({name,args});
    if(name === "native_request") return {status:200,headers:{},json:{room:{name:"a"},cursor:4,streams:{claude:"前缀"}}};
    return {connected:true,cursor:5,resync:false,events:[{type:"stream",agent:"claude",from:2,delta:" 后续"}]};
  });
  await ui.nativeFetch("/api/room?name=a");
  const es = new ui.NativeEventSource("/api/events?room=a"), received=[];
  const finished = new Promise(resolve => { es.onmessage=event => { const data=JSON.parse(event.data);received.push(data);if(data.delta){es.close();resolve();} }; });
  await finished;
  assert.equal(requested.find(call=>call.name==="watch_room").args.after,4);
  assert.equal(requested.find(call=>call.name==="watch_room").args.waitMs,0);
  assert.equal(received[0].text,"前缀");
  assert.equal(received[1].delta," 后续");
  const count=requested.length;await pause(5);assert.equal(requested.length,count);
});

test("an expired cursor reloads the original UI and restores complete partial output", async () => {
  let calls=0;
  const ui=harness(async () => ++calls === 1
    ? {connected:true,cursor:20,resync:true,events:[]}
    : new Promise(()=>{}));
  ui.window.__parleyNative={refreshAfterGap:async()=>ui.seeds.set("a",{cursor:21,streams:{claude:"恢复后的全文 $&"}})};
  const es=new ui.NativeEventSource("/api/events?room=a");
  const restored=new Promise(resolve=>{es.onmessage=event=>{es.close();resolve(JSON.parse(event.data));};});
  assert.equal((await restored).text,"恢复后的全文 $&");
  assert.equal(es.cursor,21);
});

test("room bootstrap seeds the room list and concurrent reads share one MCP request", async () => {
  const calls=[];
  const ui=harness(async (name,args)=>{
    calls.push({name,args}); await pause(5);
    return {status:200,headers:{},json:{room:{name:"a"},cursor:0,panel:{rooms:{rooms:[{name:"a"}],providers:{}}}}};
  });
  await Promise.all([ui.nativeFetch("/api/room?name=a"),ui.nativeFetch("/api/room?name=a")]);
  const rooms=await (await ui.nativeFetch("/api/rooms")).json();
  assert.equal(calls.length,1);assert.deepEqual(rooms.rooms,[{name:"a"}]);
  assert.ok(calls[0].args.path.includes("panel=1"));
});

test("interactive writes go ahead of queued background watches", async () => {
  let release;const order=[];
  const ui=harness(async (name,args)=>{
    order.push(name);
    if(name==="first")await new Promise(resolve=>release=resolve);
    return {ok:true};
  });
  const first=ui.call("first",{}); await pause(0);
  const watch=ui.call("watch_room",{waitMs:0});
  const write=ui.call("native_request",{path:"/api/config",method:"POST"});
  release();await Promise.all([first,watch,write]);
  assert.deepEqual(order,["first","native_request","watch_room"]);
});

test("writes invalidate short-lived read caches and cannot reuse an older pending read", async () => {
  let version=0,release;const reads=[];
  const ui=harness(async (name,args)=>{
    if(args.method==="POST"){version++;return {status:200,headers:{},json:{ok:true}};}
    const value=version;reads.push(value);
    if(reads.length===1)await new Promise(resolve=>release=resolve);
    return {status:200,headers:{},json:{version:value}};
  });
  const old=ui.nativeFetch("/api/rooms");await pause(0);
  const write=ui.nativeFetch("/api/config",{method:"POST",body:"{}"});
  const newer=ui.nativeFetch("/api/rooms");release();
  await Promise.all([old,write]);
  assert.equal((await (await newer).json()).version,1);
  assert.deepEqual(reads,[0,1]);
});
