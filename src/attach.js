import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, listTargets } from './cdp.js';
import { pageConfig } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECT_PATH = path.join(HERE, '..', 'client', 'inject.js');
const BINDING = '__slackenAsk';
const POLL_MS = 4000;
// Health reports older than this say nothing about the page as it is now.
const HEALTH_STALE_MS = 5 * 60_000;

export class Attacher {
  constructor({ config, moderator, state, store, onEvent }) {
    this.config = config;
    this.moderator = moderator;
    this.state = state || null;
    // Optional: without it the button inside Slack has nowhere to write to.
    this.store = store || null;
    this.onEvent = onEvent || (() => {});
    this.targetUrl = new RegExp(config.targetUrlPattern, 'i');
    this.sessions = new Map(); // target id -> CdpSession, or null while attaching
    // CdpSession -> identifier of its Page.addScriptToEvaluateOnNewDocument
    this.newDocumentScripts = new WeakMap();
    this.pollTimer = null;
    this.stopped = false;
    this.unsubscribe = null;
    this.pollFailing = false;
    // The last thing a page reported about what it can see; null until then.
    this.health = null;
  }

  /*
   * Has Slack's layout moved under us? List items with no message bodies in
   * them is the signature of a renamed class. No list items at all is not
   * evidence of anything: an empty channel or a loading window looks the same.
   */
  get drifted() {
    if (!this.health) return false;
    if (Date.now() - this.health.at > HEALTH_STALE_MS) return false;
    return this.health.items > 0 && this.health.bodies === 0;
  }

  // Read on every injection so editing client/inject.js only needs a
  // `slacken` reinject or a page reload, not a daemon restart.
  source() {
    const script = fs.readFileSync(INJECT_PATH, 'utf8');
    const paused = Boolean(this.state?.paused);
    const prelude = `window.__SLACKEN_CONFIG = ${JSON.stringify(pageConfig(this.config, { paused }))};\n`;
    return prelude + script;
  }

  start() {
    this.stopped = false;
    this.unsubscribe?.();
    this.unsubscribe = this.state?.onChange((paused) => {
      this.broadcastPaused(paused).catch(() => {});
    });
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.sweep();
        if (this.pollFailing) {
          this.pollFailing = false;
          this.onEvent({ type: 'poll-ok' });
        }
      } catch (err) {
        this.pollFailing = true;
        this.onEvent({ type: 'poll-error', message: err.message });
      }
      if (!this.stopped) {
        this.pollTimer = setTimeout(tick, POLL_MS);
        this.pollTimer.unref?.();
      }
    };
    return tick();
  }

  // Pausing has to reach the page, or everything already rewritten on screen
  // would stay rewritten.
  async broadcastPaused(paused) {
    await this.evaluateEverywhere(
      `window.__slackenSetPaused && window.__slackenSetPaused(${paused ? 'true' : 'false'})`,
    );
    await this.refreshNewDocumentScripts();
  }

  // A settings change from anywhere reaches every window, including the one
  // it came from, so the page only ever shows what the daemon holds.
  async broadcastConfig() {
    const payload = JSON.stringify(JSON.stringify(pageConfig(this.config, { paused: Boolean(this.state?.paused) })));
    await this.evaluateEverywhere(`window.__slackenSetConfig && window.__slackenSetConfig(${payload})`);
    await this.refreshNewDocumentScripts();
  }

  async evaluateEverywhere(expression) {
    await Promise.all(this.liveSessions().map((session) => (
      // A window going away is re-attached by the poll loop, with the current
      // settings in its prelude.
      session.send('Runtime.evaluate', { expression }).catch(() => {})
    )));
  }

  /*
   * The script a window runs on its next reload carries the settings in its
   * prelude, fixed when it was registered. Re-register it on every change, or
   * reloading Slack during a pause would bring the page back unpaused.
   */
  async refreshNewDocumentScripts() {
    const source = this.source();
    await Promise.all(this.liveSessions().map((session) => (
      this.installNewDocumentScript(session, source).catch(() => {})
    )));
  }

  async installNewDocumentScript(session, source = this.source()) {
    const previous = this.newDocumentScripts.get(session);
    const { identifier } = await session.send('Page.addScriptToEvaluateOnNewDocument', { source });
    this.newDocumentScripts.set(session, identifier);
    if (previous) {
      await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: previous }).catch(() => {});
    }
  }

  liveSessions() {
    return Array.from(this.sessions.values()).filter(Boolean);
  }

  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const session of this.liveSessions()) session.close();
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
        if (this.stopped) {
          session.close();
          return;
        }
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
      // Only forget the slot if it is still ours; a later attach may own it.
      const current = this.sessions.get(target.id);
      if (current === session || current === null) this.sessions.delete(target.id);
      this.onEvent({ type: 'detached', target: target.url });
    });

    try {
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
      // Future navigations and workspace switches...
      await this.installNewDocumentScript(session, source);
      // ...and the page already open. The script replaces any copy of itself
      // left by an earlier daemon, so a restart picks up new code and settings.
      await session.send('Runtime.evaluate', { expression: source, awaitPromise: false });
    } catch (err) {
      session.close();
      throw err;
    }

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
    if (!request || typeof request !== 'object') return;
    const respond = (payload) => this.reply(session, params.executionContextId, { id: request.id, ...payload });

    if (request.op === 'ignore-channel') {
      await this.handleIgnoreChannel(respond, request);
      return;
    }
    if (request.op === 'reveal') {
      this.moderator.stats.reveals = (this.moderator.stats.reveals || 0) + 1;
      this.onEvent({
        type: 'reveal',
        sender: request.sender,
        channel: request.channel,
        kind: request.kind,
        note: request.note,
      });
      await respond({ ok: true });
      return;
    }
    // What the page is finding; the only way to notice Slack's DOM has moved.
    if (request.op === 'health') {
      this.health = {
        at: Date.now(),
        items: Number(request.items) || 0,
        bodies: Number(request.bodies) || 0,
      };
      await respond({ ok: true });
      return;
    }

    const stats = this.moderator.stats;
    if (request.kind === 'notification') stats.notifications = (stats.notifications || 0) + 1;
    if (request.kind === 'draft') stats.drafts = (stats.drafts || 0) + 1;

    let verdict;
    try {
      verdict = await this.moderator.moderate({
        text: request.text,
        sender: request.sender,
        channel: request.channel,
      });
    } catch (err) {
      // Answer anyway: a page left waiting keeps the message hidden until its
      // own timeout gives up on it.
      await respond({ flagged: false, rewrite: null, error: err.message });
      throw err;
    }
    this.onEvent({
      type: 'verdict',
      kind: request.kind || 'message',
      sender: request.sender,
      channel: request.channel,
      text: request.text,
      verdict,
    });
    await respond(verdict);
  }

  // The button in Slack's channel header. The daemon owns the ignore list, and
  // the page redraws the button from this answer rather than from the click.
  async handleIgnoreChannel(respond, request) {
    const channel = String(request.channel || '').trim();
    const ignored = request.ignored !== false;
    if (!channel || !this.store) {
      await respond({
        error: channel ? 'settings are not writable' : 'no channel to ignore',
        ignoreChannels: this.config.ignoreChannels,
      });
      return;
    }

    const { errors } = this.store.setIgnored('ignoreChannels', channel, ignored);
    this.onEvent({ type: 'ignore-channel', channel, ignored, error: errors[0]?.message });
    await respond({
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
      // The context can go away mid-flight (navigation, workspace switch), so
      // try once more against whatever the default context is now.
      try {
        await session.send('Runtime.evaluate', { expression });
      } catch {
        // The page is gone.
      }
    }
  }

  // What each attached window makes of what is on screen, read from the page
  // itself rather than from anything the daemon remembers.
  async inspect() {
    const windows = [];
    for (const [id, session] of this.sessions) {
      if (!session) continue;
      try {
        const { result } = await session.send('Runtime.evaluate', {
          expression: 'JSON.stringify(window.__slackenInspect ? window.__slackenInspect() : null)',
          returnByValue: true,
        });
        const value = result?.value ? JSON.parse(result.value) : null;
        windows.push(value
          ? { target: id, ...value }
          : { target: id, error: 'the page script is not running in this window' });
      } catch (err) {
        windows.push({ target: id, error: err.message });
      }
    }
    return windows;
  }

  async reinjectAll() {
    await this.evaluateEverywhere(this.source());
    await this.refreshNewDocumentScripts();
  }

  get attachedCount() {
    return this.liveSessions().length;
  }
}
