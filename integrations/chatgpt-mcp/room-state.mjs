export function createRoomState(room = "default") {
  return { room, cursor: 0, entries: [], streams: {}, busy: {}, runs: {}, connected: false };
}

function busyMap(value) {
  if (Array.isArray(value)) return Object.fromEntries(value.map(agent => [agent, true]));
  return Object.fromEntries(Object.entries(value || {}).filter(([, busy]) => busy));
}

function finish(state, agent) {
  if (!agent) return;
  delete state.streams[agent];
  delete state.busy[agent];
  delete state.runs[agent];
}

function applyActivity(state, room) {
  if (!Object.hasOwn(room, "busy")) return;
  state.busy = busyMap(room.busy);
  for (const agent of new Set([...Object.keys(state.streams), ...Object.keys(state.runs)])) {
    if (!state.busy[agent]) finish(state, agent);
  }
  for (const info of room.busyInfo || []) {
    if (info.agent && info.runId) state.runs[info.agent] = info.runId;
  }
}

function upsertEntry(state, entry) {
  if (!entry || !Number.isInteger(entry.n)) return;
  const index = state.entries.findIndex(item => item.n === entry.n);
  if (index < 0) state.entries.push(entry);
  else state.entries[index] = entry;
  state.entries.sort((a, b) => a.n - b.n);
}

export function applyRoomSnapshot(state, snapshot, { preserveLive = false } = {}) {
  if (Array.isArray(snapshot.entries)) {
    if (preserveLive) {
      const current = state.entries;
      state.entries = [];
      for (const entry of [...snapshot.entries, ...current]) upsertEntry(state, entry);
    } else state.entries = snapshot.entries.slice();
  }
  if (!preserveLive && snapshot.room) {
    applyActivity(state, snapshot.room);
    if (snapshot.streams) state.streams = Object.fromEntries(
      Object.entries(snapshot.streams).filter(([agent, text]) => state.busy[agent] && typeof text === "string")
    );
    if (Number.isInteger(snapshot.cursor)) state.cursor = snapshot.cursor;
  }
}

export function visibleStreams(state) {
  return Object.entries(state.streams).filter(([agent, text]) =>
    state.busy[agent] && text && text.trim() !== "[pass]"
  );
}

// Return true only when an authoritative snapshot is needed.
export function applyRoomEvent(state, event) {
  const agent = event.agent;
  if (event.type === "stream" && agent) {
    const previous = state.streams[agent] || "";
    if (typeof event.text === "string") state.streams[agent] = event.text;
    else if (event.from === previous.length && typeof event.delta === "string") {
      state.streams[agent] = previous + event.delta;
    } else return false; // Wait for the next keyframe after a lost increment.
    state.busy[agent] = true;
  } else if (event.type === "status" && agent) {
    const terminal = ["done", "idle", "stopped", "cancelled", "error"].includes(event.phase);
    if (terminal) {
      if (!event.runId || !state.runs[agent] || state.runs[agent] === event.runId) finish(state, agent);
    } else {
      if (event.runId && state.runs[agent] !== event.runId) delete state.streams[agent];
      if (event.runId) state.runs[agent] = event.runId;
      state.busy[agent] = true;
    }
  } else if (event.type === "entry") {
    upsertEntry(state, event.entry);
    if (event.entry?.kind === "agent") finish(state, event.entry.author);
  } else if (event.type === "receipt" || event.type === "lurk") {
    finish(state, agent || event.receipt?.agent);
  } else if (event.type === "room" && event.room) {
    applyActivity(state, event.room);
  } else if (event.type === "reset") {
    state.entries = [];
    state.streams = {};
    state.busy = {};
    state.runs = {};
    return true;
  } else if (["end", "error", "result"].includes(event.type)) {
    if (agent) finish(state, agent);
    else { state.streams = {}; state.busy = {}; state.runs = {}; }
    return true;
  }
  return false;
}
