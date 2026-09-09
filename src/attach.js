import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, listTargets } from './cdp.js';
import { pageConfig } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECT_PATH = path.join(HERE, '..', 'client', 'inject.js');
const BINDING = '__slackenAsk';

export class Attacher {
  constructor({ config, moderator, state, store, onEvent }) {
    this.config = config;
    this.moderator = moderator;
    this.state = state || null;
    // Optional: without it the page can still read settings, but the button
    // inside Slack has nowhere to write a change to.
    this.store = store || null;
    this.onEvent = onEvent || (() => {});
    this.targetUrl = new RegExp(config.targetUrlPattern, 'i');
    this.sessions = new Map(); // target id -> CdpSession
    this.pollTimer = null;
    this.stopped = false;
    this.unsubscribe = null;
    this.pollFailing = false;
  }

  source() {
    // Read on every injection so editing client/inject.js only needs a page
    // reload, not a daemon restart.
    const script = fs.readFileSync(INJECT_PATH, 'utf8');
    const paused = Boolean(this.state?.paused);
    const prelude = `window.__SLACKEN_CONFIG = ${JSON.stringify(pageConfig(this.config, { paused }))};\n`;
    return prelude + script;
  }

  start() {
    this.stopped = false;
    // A window that attaches later picks the state up from the prelude above;
    // windows already attached are told directly.
    this.unsubscribe?.();
    this.unsubscribe = this.state?.onChange((paused) => {
      this.broadcastPaused(paused).catch(() => {});
    });
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.sweep();
        // Only worth an event when it is news: the log needs to say when the
        // devtools endpoint came back, not that it is still there.
        if (this.pollFailing) {
          this.pollFailing = false;
          this.onEvent({ type: 'poll-ok' });
        }
      } catch (err) {
        this.pollFailing = true;
        this.onEvent({ type: 'poll-error', message: err.message });
      }
      if (!this.stopped) {
        this.pollTimer = setTimeout(tick, 4000);
        this.pollTimer.unref?.();
      }
    };
    return tick();
  }

  // Pausing has to reach the page, not just the daemon: the daemon going quiet
  // would leave every message already rewritten on screen still rewritten.
  async broadcastPaused(paused) {
    await this.evaluateEverywhere(
      `window.__slackenSetPaused && window.__slackenSetPaused(${paused ? 'true' : 'false'})`,
    );
  }

  // Settings changed from the menu bar, the terminal or another Slack window.
  // Every window gets told, including the one the change came from: a setting
  // that only took hold where you clicked it would be a setting you could not
  // trust.
  async broadcastConfig() {
    const payload = JSON.stringify(JSON.stringify(pageConfig(this.config, { paused: Boolean(this.state?.paused) })));
    await this.evaluateEverywhere(`window.__slackenSetConfig && window.__slackenSetConfig(${payload})`);
  }

  async evaluateEverywhere(expression) {
    for (const session of this.sessions.values()) {
      if (!session) continue;
      try {
        await session.send('Runtime.evaluate', { expression });
      } catch {
        // The window is going away; the poll loop will re-attach and the
        // prelude will carry the current settings.
      }
    }
  }

  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  async sweep() {
    const targets = await listTargets(this.config.cdpPort);
    const slackPages = targets.filter(
      (t) => t.type === 'page' && this.targetUrl.test(t.url || '') && t.webSocketDebuggerUrl,
    );
    for (const target of slackPages) {
      if (this.sessions.has(target.id)) continue;
      // Reserve the slot before awaiting so a second sweep cannot double-attach.
      this.sessions.set(target.id, null);
      try {
        const session = await this.attach(target);
        this.sessions.set(target.id, session);
      } catch (err) {
        this.sessions.delete(target.id);
        this.onEvent({ type: 'attach-error', target: target.url, message: err.message });
      }
    }
  }

  async attach(target) {
    const session = new CdpSession(target.webSocketDebuggerUrl);
    await session.connect();

    session.on('__close', () => {
      this.sessions.delete(target.id);
      this.onEvent({ type: 'detached', target: target.url });
    });

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Runtime.addBinding', { name: BINDING });

    session.on('Runtime.bindingCalled', (params) => {
      if (params.name !== BINDING) return;
      this.handleAsk(session, params).catch((err) => {
        this.onEvent({ type: 'moderate-error', message: err.message });
      });
    });

    const source = this.source();
    // Covers future navigations and workspace switches...
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source });
    // ...and the page that is already open right now.
    await session.send('Runtime.evaluate', { expression: source, awaitPromise: false });

    this.onEvent({ type: 'attached', target: target.url, title: target.title });
    return session;
  }

  async handleAsk(session, params) {
    let request;
    try {
      request = JSON.parse(params.payload);
    } catch {
      return;
    }
    if (request.op === 'ignore-channel') {
      await this.handleIgnoreChannel(session, params, request);
      return;
    }
    const verdict = await this.moderator.moderate({
      text: request.text,
      sender: request.sender,
      channel: request.channel,
    });
    this.onEvent({
      type: 'verdict',
      sender: request.sender,
      channel: request.channel,
      text: request.text,
      verdict,
    });
    await this.reply(session, params.executionContextId, { id: request.id, ...verdict });
  }

  // The button in Slack's channel header. The page knows which channel you are
  // reading; the daemon owns the ignore list. Answered directly as well as
  // broadcast, so the button redraws from the daemon's answer rather than from
  // its own optimism about what the click did.
  async handleIgnoreChannel(session, params, request) {
    const channel = String(request.channel || '').trim();
    const ignored = request.ignored !== false;
    if (!channel || !this.store) {
      await this.reply(session, params.executionContextId, {
        id: request.id,
        error: channel ? 'settings are not writable' : 'no channel to ignore',
        ignoreChannels: this.config.ignoreChannels,
      });
      return;
    }

    const { errors } = this.store.setIgnored('ignoreChannels', channel, ignored);
    this.onEvent({ type: 'ignore-channel', channel, ignored, error: errors[0]?.message });
    await this.reply(session, params.executionContextId, {
      id: request.id,
      ok: errors.length === 0,
      error: errors[0]?.message,
      ignoreChannels: this.config.ignoreChannels,
    });
  }

  async reply(session, contextId, payload) {
    const expression = `window.__slackenResult && window.__slackenResult(${JSON.stringify(JSON.stringify(payload))})`;
    try {
      await session.send('Runtime.evaluate', { expression, contextId });
    } catch {
      // The context can go away mid-flight (navigation, workspace switch).
      // Retry once against whatever the default context is now.
      try {
        await session.send('Runtime.evaluate', { expression });
      } catch {
        // The page is gone. Nothing to deliver the verdict to.
      }
    }
  }

  async reinjectAll() {
    const source = this.source();
    for (const session of this.sessions.values()) {
      if (!session) continue;
      try {
        await session.send('Runtime.evaluate', {
          expression: `window.__SLACKEN__ = false; ${source}`,
        });
      } catch {
        // Session is closing; the poll loop will re-attach.
      }
    }
  }

  get attachedCount() {
    return Array.from(this.sessions.values()).filter(Boolean).length;
  }
}
