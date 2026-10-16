const KEY = "parley-panel-v1";

export function restorePanel(storage) {
  try {
    const value = JSON.parse(storage.getItem(KEY) || "{}");
    return {
      room: /^[A-Za-z0-9_-]{1,40}$/.test(value.room) ? value.room : "default",
      drafts: Object.fromEntries(Object.entries(value.drafts || {}).filter(([room, draft]) =>
        /^[A-Za-z0-9_-]{1,40}$/.test(room) && typeof draft === "string" && draft.length <= 12000)),
    };
  } catch { return { room: "default", drafts: {} }; }
}

export function savePanel(storage, panel) {
  try { storage.setItem(KEY, JSON.stringify(panel)); }
  catch { /* Storage may be unavailable inside the host's sandbox. */ }
}

export function shouldSend(event) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}
