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
