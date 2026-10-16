import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "Parley Chat", version: "0.1.0" });
const $ = id => document.getElementById(id);
const state = { room:"default",cursor:0,entries:[],streams:{},busy:{},connected:false };
const error = msg => { $("error").textContent = msg || ""; };
async function call(name, params={}) {
  const result = await app.callServerTool({ name, arguments:params });
  if (result.isError) throw Error(result.content?.find(x=>x.type==="text")?.text || "Tool failed");
  if (result.structuredContent) return result.structuredContent;
  const body=result.content?.find(x=>x.type==="text")?.text;
  try {return JSON.parse(body || "{}");} catch {return {};}
}
function bubble(entry, streaming=false) {
  const item=document.createElement("article");
  const who=String(entry.author||entry.agent||entry.kind||"system");
  item.className="item"+(who==="user"?" mine":"");
  const top=document.createElement("div");top.className="author";
  top.textContent=(who==="user"?"你":who==="claude"?"Claude":who==="codex"?"Codex":who)+(streaming?" · 正在生成":"");
  const body=document.createElement("div");body.className="body";body.textContent=String(entry.text||entry.body||"");
  item.append(top,body);return item;
}
function render() {
  const el=$("messages"),bottom=el.scrollHeight-el.scrollTop-el.clientHeight<70, frag=document.createDocumentFragment();
  for(const entry of state.entries.slice(-150)) frag.append(bubble(entry));
  for(const [agent,text] of Object.entries(state.streams)) if(text)frag.append(bubble({agent,text},true));
  if(!frag.childNodes.length) {const empty=document.createElement("small");empty.textContent="暂无消息";frag.append(empty);}
  el.replaceChildren(frag);if(bottom)el.scrollTop=el.scrollHeight;
  $("busy").textContent=Object.keys(state.busy).filter(k=>state.busy[k]).join(" · ");
}
async function loadRoom(){const result=await call("get_room",{room:state.room});if(Array.isArray(result.entries))state.entries=result.entries;state.busy=result.room?.busy||{};render();}
async function loadRooms(){const result=await call("list_rooms");const names=(result.rooms||[]).map(r=>typeof r==="string"?r:r.name).filter(Boolean);const select=$("room");select.replaceChildren();
  for(const name of names.length?names:["default"]){const opt=document.createElement("option");opt.value=name;opt.textContent=name;select.append(opt);}
  if(names.includes(state.room))select.value=state.room;else{state.room="default";select.value="default";}
}
function onEvent(event){
  if(event.type==="stream"&&event.agent)state.streams[event.agent]=event.text||"";
  else if(event.type==="status"&&event.agent)state.busy[event.agent]=!["done","idle"].includes(event.phase||"");
  else if(event.type==="reset"){state.entries=[];state.streams={};loadRoom().catch(e=>error(e.message));}
  else if(["entry","receipt","room","queue","end","result","renamed"].includes(event.type)){
    if(event.agent)delete state.streams[event.agent];
    clearTimeout(onEvent.reload);onEvent.reload=setTimeout(()=>loadRoom().catch(e=>error(e.message)),250);
  }
}
async function poll(){
  while(state.connected){
    if(document.visibilityState==="hidden"){await new Promise(resolve=>setTimeout(resolve,1200));continue;}
    try{
      const result=await call("watch_room",{room:state.room,after:state.cursor,waitMs:3000});
      if(result.resync)await loadRoom();
      for(const event of result.events||[])onEvent(event);
      state.cursor=result.cursor??state.cursor;$("state").textContent=result.connected?"实时连接":"正在重连";render();
    }catch(e){$("state").textContent="连接中断";error(e.message);await new Promise(r=>setTimeout(r,2000));}
  }
}
$("target").addEventListener("change",()=>{$("solo").disabled=$("target").value==="both";if($("solo").disabled)$("solo").checked=false;});
$("solo").disabled=$("target").value==="both";
$("send").addEventListener("click",async()=>{
  const message=$("draft").value.trim();if(!message)return;
  const btn=$("send");btn.disabled=true;error("");
  try{await call("send_message",{room:state.room,target:$("target").value,text:message,solo:$("target").value!=="both"&&$("solo").checked});$("draft").value="";await loadRoom();}
  catch(e){error(e.message);}finally{btn.disabled=false;}
});
$("draft").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("send").click();}});
$("stop").addEventListener("click",async()=>{try{await call("stop_reply",{room:state.room,agent:null});await loadRoom();}catch(e){error(e.message);}});
$("refresh").addEventListener("click",()=>loadRoom().catch(e=>error(e.message)));
$("room").addEventListener("change",async e=>{state.room=e.target.value;state.cursor=0;state.streams={};await loadRoom().catch(err=>error(err.message));});
app.ontoolresult=result=>{const v=result.structuredContent;if(v?.entries){if(v.activeRoom)state.room=v.activeRoom;state.entries=v.entries;render();}};
(async()=>{try{await app.connect();await loadRooms();await loadRoom();state.connected=true;poll();}catch(e){error(e.message);$("state").textContent="未连接";}})();
