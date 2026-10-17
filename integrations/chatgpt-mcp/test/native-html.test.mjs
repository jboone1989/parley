import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildNativeHtml, nativeAppSource } from "../native-html.mjs";
import { NATIVE_ROUTES } from "../native-api.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const ui = new URL("../../../ui/", import.meta.url);
const source = readFileSync(new URL("app.js", ui), "utf8");

test("the full upstream UI is embedded with its controls, stylesheet and valid JavaScript", () => {
  const html = buildNativeHtml(root);
  const nativeHtml = readFileSync(new URL("index.html", ui), "utf8");
  for (const [, id] of nativeHtml.matchAll(/id="([^"]+)"/g)) assert.ok(html.includes('id="'+id+'"'), id);
  assert.ok(html.includes(readFileSync(new URL("styles.css", ui), "utf8")));
  assert.doesNotMatch(html, /<script src="\/ui\/|<link rel="stylesheet" href="\/ui\//);
  const transformed = nativeAppSource(source);
  new vm.Script("function start(__initialRoom) {\n"+transformed+"\n}");
  assert.match(transformed, /await window\.__parleyConfirm/);
  assert.match(transformed, /await window\.__parleyPrompt/);
});

test("every upstream API path has a bridge, event transport, or explicit desktop adaptation", () => {
  const supported = new Set([...NATIVE_ROUTES].map(route => route.split(" ")[1]));
  for (const path of ["/api/events", "/api/pickfolder", "/api/open"]) supported.add(path);
  for (const [, path] of source.matchAll(/["'](\/api\/[a-z/]+)(?:[?"'])/g)) {
    assert.ok(supported.has(path), "Unbridged native feature: " + path);
  }
});

function modeFixture() {
  let settle;
  const buttons = ["talk", "work"].map(mode => ({
    dataset: {m:mode}, textContent:mode, disabled:false, attributes:{},
    setAttribute(name,value) { this.attributes[name]=value; },
    removeAttribute(name) { delete this.attributes[name]; },
  }));
  const fixture = {
    document: {querySelectorAll:()=>buttons},
    state: {room:"a",summary:{cfg:{mode:"talk"},seats:[],agents:{}}},
    api: () => new Promise((resolve,reject) => { settle={resolve,reject}; }),
    applySummary: summary => { fixture.state.summary=summary; fixture.applied++; },
    refreshRooms:()=>{}, toast:message=>fixture.errors.push(message),
    applied:0, errors:[], buttons, ack:()=>settle,
  };
  const transformed=nativeAppSource(source);
  const begin=transformed.indexOf('document.querySelectorAll(".mbtn").forEach((b) => {');
  const end=transformed.indexOf("// Two different questions",begin);
  assert.ok(begin>=0&&end>begin);
  vm.runInNewContext(transformed.slice(begin,end),fixture);
  return fixture;
}

test("mode controls acknowledge clicks immediately and use the save response without waiting for SSE", async()=>{
  const f=modeFixture(), work=f.buttons[1];
  const pending=work.onclick();
  assert.equal(work.attributes["aria-busy"],"true");
  assert.equal(work.textContent,"work…");
  assert.ok(f.buttons.every(button=>button.disabled));
  assert.equal(f.state.summary.cfg.mode,"talk","pending permission changes must not appear confirmed");
  f.state.summary.liveVersion = "newer SSE";
  f.ack().resolve({room:{cfg:{mode:"work"},liveVersion:"older response"}});
  await pending;
  assert.equal(f.state.summary.cfg.mode,"work");
  assert.equal(f.applied,1);
  assert.equal(f.state.summary.liveVersion,"newer SSE","saving mode must preserve newer agent state");
  assert.equal(work.textContent,"work");
  assert.ok(f.buttons.every(button=>!button.disabled));
});

test("failed mode saves keep the previous mode and late responses cannot overwrite another room", async()=>{
  const failed=modeFixture(), pending=failed.buttons[1].onclick();
  failed.ack().reject(Error("rejected")); await pending;
  assert.equal(failed.state.summary.cfg.mode,"talk");
  assert.deepEqual(failed.errors,["rejected"]);
  assert.ok(failed.buttons.every(button=>!button.disabled));
  const moved=modeFixture(), late=moved.buttons[1].onclick();
  moved.state.room="b"; moved.ack().resolve({room:{cfg:{mode:"work"}}}); await late;
  assert.equal(moved.applied,0);
});
