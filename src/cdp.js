import WebSocket from 'ws';

// A command a hung renderer never answers must not hang whoever sent it: the
// attach loop awaits these, and a stuck await would stop it for good.
const COMMAND_TIMEOUT_MS = 10_000;

// A minimal Chrome DevTools Protocol client: enough to enable a couple of
// domains, install a binding, and evaluate scripts in a page.
export class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      // maxPayload bumped because Runtime.evaluate results can be large.
      this.ws = new WebSocket(this.wsUrl, {
        perMessageDeflate: false,
        maxPayload: 64 * 1024 * 1024,
        handshakeTimeout: COMMAND_TIMEOUT_MS,
      });
      const onError = (err) => reject(err);
      this.ws.once('error', onError);
      this.ws.once('open', () => {
        this.ws.off('error', onError);
        this.ws.on('error', () => {});
        resolve(this);
      });
      this.ws.on('message', (data) => this.onMessage(data));
      this.ws.on('close', () => {
        this.closed = true;
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('cdp connection closed'));
        }
        this.pending.clear();
        this.emit('__close', {});
      });
    });
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method) this.emit(msg.method, msg.params || {});
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
  }

  emit(method, params) {
    for (const handler of this.handlers.get(method) || []) {
      try {
        handler(params);
      } catch (err) {
        console.warn(`[slacken] handler for ${method} threw: ${err.message}`);
      }
    }
  }

  send(method, params = {}, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('cdp connection is not open'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (!err || !this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // Already gone.
    }
  }
}

export async function listTargets(port) {
  return devtoolsGet(port, '/json/list');
}

export async function devtoolsVersion(port) {
  return devtoolsGet(port, '/json/version');
}

async function devtoolsGet(port, route) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${route}`, {
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    throw new Error(devtoolsMessage(err, port));
  }
  if (!res.ok) throw new Error(`devtools endpoint returned ${res.status}`);
  return res.json();
}

// `fetch` reports every transport failure as "fetch failed" with the reason in
// .cause; name the common ones, since Slack having quit is the usual case.
export function devtoolsMessage(err, port) {
  const code = err?.cause?.code || err?.code;
  if (code === 'ECONNREFUSED') {
    return `nothing is listening on 127.0.0.1:${port} — Slack is not running with its debug port open (run: slacken launch)`;
  }
  if (err?.name === 'TimeoutError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT') {
    return `127.0.0.1:${port} accepted the connection but did not answer within 3s`;
  }
  const cause = err?.cause?.message;
  return cause ? `${err.message}: ${cause}` : String(err?.message || err);
}
