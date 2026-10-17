import test from "node:test";
import assert from "node:assert/strict";
import { PanelTransport } from "../direct-client.mjs";

const session=()=>({baseUrl:"https://parley-panel.livingruntime.com/panel",token:"test",expiresAt:Date.now()+600000});
test("direct client renews once and keeps bearer credentials out of URLs and storage",async()=>{
  let authorizations=0;const urls=[];
  const client=new PanelTransport({authorize:async()=>{authorizations++;return session();},fetch:async(url,options)=>{
    urls.push(url);assert.equal(options.credentials,"omit");assert.equal(options.redirect,"error");
    assert.equal(options.headers.authorization,"Bearer test");
    if(url.endsWith("/ping"))return Response.json({ok:true});
    return Response.json({status:200,json:{ok:true}});
  }});
  await client.connect();
  await Promise.all([client.request({path:"/api/rooms",method:"GET"}),client.request({path:"/api/rooms",method:"GET"})]);
  assert.equal(authorizations,1);assert.ok(client.ready);assert.ok(urls.every(url=>!url.includes("token=")));
});

test("an explicit unauthorized response renews the session, but network failure never replays a write",async()=>{
  let issues=0,requests=0;
  const client=new PanelTransport({authorize:async()=>{issues++;return session();},fetch:async()=>++requests===1
    ?new Response("",{status:401}):Response.json({status:200})});
  await client.request({path:"/api/config",method:"POST",body:{room:"a"}});
  assert.equal(issues,2);assert.equal(requests,2);
  requests=0;
  client.fetch=async()=>{requests++;throw Error("connection lost after dispatch");};
  await assert.rejects(client.request({path:"/api/message",method:"POST",body:{text:"once"}}),/connection lost/);
  assert.equal(requests,1);
});

test("SSE decoding preserves Unicode, cursor boundaries and cancellation",async()=>{
  const update={cursor:7,events:[{type:"stream",delta:"中文原文 $&\n"}]};
  const bytes=new TextEncoder().encode("event: update\ndata: "+JSON.stringify(update)+"\n\n");
  let cancelled=false;
  const client=new PanelTransport({authorize:async()=>session(),fetch:async()=>new Response(new ReadableStream({
    start(controller){controller.enqueue(bytes.slice(0,42));controller.enqueue(bytes.slice(42));},
    cancel(){cancelled=true;},
  }),{headers:{"content-type":"text/event-stream"}})});
  const abort=new AbortController();
  for await(const actual of client.events({room:"a",after:6,signal:abort.signal})){
    assert.deepEqual(actual,update);abort.abort();break;
  }
  assert.ok(cancelled);
});
