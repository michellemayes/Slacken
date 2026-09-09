import WebSocket from 'ws';

// A very small Chrome DevTools Protocol client: enough to enable a couple of
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
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
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
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error('cdp connection closed'));
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

  send(method, params = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('cdp connection is not open'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (!err) return;
        this.pending.delete(id);
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
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`devtools endpoint returned ${res.status}`);
  return res.json();
}

export async function devtoolsVersion(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`devtools endpoint returned ${res.status}`);
  return res.json();
}
