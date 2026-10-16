import { createRoomState, applyRoomEvent } from './room-state.mjs';
const BASE = 'http://127.0.0.1:4141';
export const ROOM_NAME = /^[a-zA-Z0-9_-]{1,40}$/;
export function validRoom(value) {
  const room = String(value || 'default');
  if (!ROOM_NAME.test(room)) throw new Error('Invalid Parley room name');
  return room;
}
export function validTarget(value) {
  const target = String(value || 'both').toLowerCase();
  if (!['claude', 'codex', 'both'].includes(target)) throw new Error('Target must be claude, codex, or both');
  return target;
}
const fail = (text) => new Error('Parley: ' + text);
export class ParleyBridge {
  constructor(base = BASE) {
    this.base = base;
    this.auth = null;
    this.channels = new Map();
  }
  async refreshAuth() {
    const response = await fetch(this.base + '/', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw fail('home returned ' + response.status);
    const html = await response.text();
    const token = html.match(/<meta name="parley-token" content="([^"]+)"/)?.[1];
    const protocol = html.match(/<meta name="parley-runtime-protocol" content="([^"]+)"/)?.[1];
    if (!token || !protocol) throw fail('missing local session token');
    this.auth = { token, protocol };
    return this.auth;
  }
  async call(path, method = 'GET', body = undefined, retry = true) {
    const { token, protocol } = this.auth || await this.refreshAuth();
    const response = await fetch(this.base + path, {
      method,
      headers: {
        'x-parley-token': token,
        'x-parley-runtime-protocol': protocol,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 403 && retry) {
      await this.refreshAuth();
      return this.call(path, method, body, false);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw fail(String(data.error || 'HTTP ' + response.status));
    return data;
  }
  async rooms() {
    return this.call('/api/rooms');
  }
  async snapshot(room) {
    const name = validRoom(room);
    const channel = this.channel(name);
    // Capture a replay boundary before the HTTP read, so events arriving during
    // that read are still delivered. The native snapshot remains authoritative.
    const cursor = channel.seq;
    const streams = { ...channel.live.streams }, runs = { ...channel.live.runs };
    const snapshot = await this.call('/api/room?name=' + encodeURIComponent(name));
    const busy = snapshot.room?.busy || [];
    const active = Array.isArray(busy) ? busy : Object.keys(busy).filter(key => busy[key]);
    const currentRuns = Object.fromEntries((snapshot.room?.busyInfo || []).map(info => [info.agent, info.runId]));
    return { ...snapshot, cursor, streams: Object.fromEntries(Object.entries(streams).filter(([agent]) =>
      active.includes(agent) && (!currentRuns[agent] || runs[agent] === currentRuns[agent])
    )) };
  }
  async send({ room = 'default', target = 'both', text, solo = false }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) {
      throw new Error('Message must contain 1–12000 characters');
    }
    const normalizedTarget = validTarget(target);
    if (normalizedTarget === 'both' && solo) {
      throw new Error('Solo cannot be combined with both agents');
    }
    return this.call('/api/message', 'POST', {
      room: validRoom(room), target: normalizedTarget, text: text.trim(), solo: !!solo,
    });
  }
  async stop({ room = 'default', agent = null } = {}) {
    if (agent !== null && agent !== '' && !['claude', 'codex'].includes(agent)) {
      throw new Error('Stop agent must be claude or codex');
    }
    return this.call('/api/stop', 'POST', { room: validRoom(room), agent });
  }
  channel(name) {
    const room = validRoom(name);
    if (!this.channels.has(room)) {
      const channel = { room, seq: 0, events: [], waiters: new Set(), connected: false, running: false, live: createRoomState(room) };
      this.channels.set(room, channel);
      this.runEventStream(channel).catch(() => {});
    }
    return this.channels.get(room);
  }
  publish(channel, data) {
    const record = { ...data, seq: ++channel.seq };
    channel.live ||= createRoomState(channel.room);
    applyRoomEvent(channel.live, data);
    channel.live.entries = []; // Only unfinished output needs a memory cache.
    channel.events.push(record);
    if (channel.events.length > 300) channel.events.splice(0, channel.events.length - 300);
    for (const resolve of channel.waiters) resolve();
    channel.waiters.clear();
  }
  async runEventStream(channel) {
    if (channel.running) return;
    channel.running = true;
    while (this.channels.has(channel.room)) {
      try {
        const { token, protocol } = this.auth || await this.refreshAuth();
        const url = new URL('/api/events', this.base);
        url.searchParams.set('room', channel.room);
        url.searchParams.set('token', token);
        url.searchParams.set('protocol', protocol);
        const response = await fetch(url, { headers: { accept: 'text/event-stream' } });
        if (!response.ok) {
          if (response.status === 403) this.auth = null;
          throw fail('event subscription returned ' + response.status);
        }
        channel.connected = true;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          buffer += decoder.decode(part.value, { stream: true });
          if (buffer.length > 1000000) buffer = '';
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end).replaceAll('\r', '');
            buffer = buffer.slice(end + 2);
            const line = frame.split('\n').find(s => s.startsWith('data: '));
            if (!line) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event && typeof event === 'object') this.publish(channel, event);
            } catch { /* malformed or partial event; next event is authoritative */ }
          }
        }
      } catch { /* reconnect after network failure or Parley restart */ }
      channel.connected = false;
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }
  async watch({ room = 'default', after = 0, waitMs = 3000 } = {}) {
    const channel = this.channel(room);
    const cursor = Math.max(0, Number(after) || 0);
    const duration = Math.min(8000, Math.max(0, Number(waitMs) || 0));
    if (channel.seq === cursor && duration) {
      await new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          channel.waiters.delete(finish);
          clearTimeout(timeout);
          resolve();
        };
        channel.waiters.add(finish);
        const timeout = setTimeout(finish, duration);
      });
    }
    const resync = cursor > channel.seq || (channel.events.length > 0 && cursor < channel.events[0].seq - 1);
    const events = channel.events.filter(event => event.seq > cursor).slice(0, 100);
    return {
      room: channel.room, cursor: resync ? channel.seq : (events.at(-1)?.seq ?? channel.seq),
      connected: channel.connected, resync, events,
    };
  }
}
