import { createHash, randomBytes } from "node:crypto";

export const PANEL_TTL = 10 * 60 * 1000;
export const panelOrigin = process.env.PARLEY_PANEL_ORIGIN || "https://parley-panel.livingruntime.com";
export function validOrigin(value, allowLocal = false) {
  try {
    const url = new URL(value);
    const local = allowLocal && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
    return (url.protocol === "https:" || local) && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}
const digest = value => createHash("sha256").update(value).digest("hex");
export class PanelSessions {
  constructor({ now = Date.now, ttl = PANEL_TTL, origin = panelOrigin, allowLocal = false } = {}) {
    if (!validOrigin(origin, allowLocal)) throw Error("Panel origin must be an HTTPS origin");
    this.now = now; this.ttl = ttl; this.origin = origin; this.allowLocal = allowLocal;
    this.sessions = new Map();
  }
  issue(origin) {
    if (!validOrigin(origin, this.allowLocal)) throw Error("Invalid panel client origin");
    for (const [key, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 200) throw Error("Too many panel sessions");
    const token = randomBytes(32).toString("base64url"), expiresAt = this.now() + this.ttl;
    this.sessions.set(digest(token), { origin, expiresAt, streams: 0, active: 0, windowAt: this.now(), requests: 0 });
    return { baseUrl: this.origin + "/panel", token, expiresAt, origin };
  }
  verify(token, origin) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = this.sessions.get(digest(token));
    if (!session || session.expiresAt <= this.now() || session.origin !== origin) return null;
    return session;
  }
  admit(session) {
    if (this.now() - session.windowAt >= 60000) { session.windowAt = this.now(); session.requests = 0; }
    return ++session.requests <= 300 && session.active < 8;
  }
}
