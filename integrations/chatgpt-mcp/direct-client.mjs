export class PanelTransport {
  constructor({ fetch, authorize }) {
    this.fetch = fetch; this.authorize = authorize; this.session = null;
    this.refreshing = null; this.ready = false;
  }
  async credentials(force = false) {
    if (!force && this.session?.expiresAt > Date.now() + 30000) return this.session;
    if (!this.refreshing) this.refreshing = Promise.resolve().then(this.authorize).then(session => {
      const url = new URL(session.baseUrl);
      if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) throw Error("Invalid direct origin");
      this.session = session; return session;
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async connect() {
    const session = await this.credentials();
    const response = await this.fetch(session.baseUrl + "/ping", {
      headers: { authorization: "Bearer " + session.token }, credentials: "omit",
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !(await response.json()).ok) throw Error("Direct connection unavailable");
    this.ready = true;
  }
  async send(path, options, retry = true) {
    const session = await this.credentials();
    const response = await this.fetch(session.baseUrl + path, {
      ...options, credentials: "omit", redirect: "error",
      headers: { ...options.headers, authorization: "Bearer " + session.token },
    });
    if (response.status === 401 && retry) { await this.credentials(true); return this.send(path, options, false); }
    if (!response.ok) throw Error("Direct Parley HTTP " + response.status);
    return response;
  }
  async request(args) {
    // Never replay a mutation after a network failure: it may already have
    // reached Parley. Only an explicit pre-dispatch 401 can safely be retried.
    const response = await this.send("/request", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(args),
      signal: AbortSignal.timeout(35000) });
    return response.json();
  }
  async *events({ room, after, signal }) {
    const response = await this.send("/events?room=" + encodeURIComponent(room) + "&after=" + after,
      { headers: { accept: "text/event-stream" }, signal });
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) throw Error("Invalid event stream");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const part = await reader.read(); if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        if (buffer.length > 8 * 1024 * 1024) throw Error("Oversized event frame");
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end).replaceAll("\r", ""); buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
          if (data) yield JSON.parse(data);
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
}
