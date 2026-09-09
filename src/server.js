import http from 'node:http';
import { menuModel } from './menubar.js';
import { SETTINGS, CHANNEL_KEYS } from './settings.js';
import { tokenFrom, tokenMatches } from './auth.js';
import { errorHint } from './moderate.js';

/*
 * Small loopback-only control surface.
 *
 *   GET  /health     is the daemon up
 *   GET  /status     everything it knows about itself
 *   GET  /menubar    the same thing, already rendered as a menu
 *   GET  /config     the settings in force, and what they may be set to
 *   POST /config     change one or more settings, now and on disk
 *   POST /ignore     add or remove one channel or person from an ignore list
 *   POST /pause      stop changing anything, and reveal what is on screen
 *   POST /resume     start again
 *   POST /toggle     whichever of the two applies — what the menu bar clicks
 *   POST /moderate   rewrite one message, for `slacken test` and poking by hand
 *   POST /channel    change, or clear, the settings for one channel
 *   POST /reinject   reload the page script without restarting the daemon
 *   POST /stop       shut the daemon down, the way Ctrl-C would
 *
 * Everything but /health needs the token from ~/.slacken/token, because
 * loopback means "every process on this machine", not "only me". /health is
 * left open and says nothing but that something is here: it is what a second
 * `slacken start` uses to find the first one, and answering that with 401
 * would turn "already running" into "something is wrong".
 */
export function createServer({ config, moderator, state, store, getStatus, reinject, onStop, token = null }) {
  const snapshot = () => ({
    paused: Boolean(state?.paused),
    pausedAt: state?.pausedAt ?? null,
    uptimeMs: state?.uptimeMs ?? 0,
    model: config.model,
    triageMode: config.triageMode,
    dailyBudgetUsd: config.dailyBudgetUsd,
    ...getStatus(),
    stats: moderator.stats,
    // Named rather than counted: "3 errors" is not something anyone can act
    // on, and "not signed in to Claude" is.
    lastError: moderator.lastError
      ? { ...moderator.lastError, hint: errorHint(moderator.lastError.kind, moderator.lastError.message) }
      : null,
    // What the settings menu draws its checkmarks from.
    config: { ...config },
  });

  const setPaused = (res, paused) => {
    state?.setPaused(paused);
    return json(res, 200, { ok: true, paused: Boolean(state?.paused) });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    // Deliberately narrow: that a Slacken is here, and whether it is currently
    // changing anything. What it has read, what that cost and what it is set to
    // are behind the token, because those are the answers worth having.
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, slacken: true, paused: Boolean(state?.paused) });
    }

    if (!tokenMatches(token, tokenFrom(req))) {
      return json(res, 401, {
        error: 'this needs the token from ~/.slacken/token',
        hint: 'slacken token prints it; the CLI and the menu bar item send it for you',
      });
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, snapshot());
    }

    if (req.method === 'GET' && url.pathname === '/menubar') {
      return json(res, 200, menuModel(snapshot()));
    }

    if (req.method === 'GET' && url.pathname === '/config') {
      return json(res, 200, { config: { ...config }, settings: SETTINGS });
    }

    // A patch of setting -> value. Refused as a whole if any of it is invalid,
    // so a bad value can never leave half a change applied.
    if (req.method === 'POST' && url.pathname === '/config') {
      const body = await readJson(req, res);
      if (!body) return undefined;
      if (!store) return json(res, 501, { error: 'this daemon cannot change settings' });
      const { changed, errors } = store.update(body);
      return json(res, errors.length ? 400 : 200, {
        ok: errors.length === 0,
        changed,
        errors,
        config: { ...config },
      });
    }

    // The one change that arrives from inside Slack, where you can see which
    // channel you mean. Separate from /config because it edits a list rather
    // than replacing one, so two clients cannot overwrite each other's entries.
    if (req.method === 'POST' && url.pathname === '/ignore') {
      const body = await readJson(req, res);
      if (!body) return undefined;
      if (!store) return json(res, 501, { error: 'this daemon cannot change settings' });
      const key = body.list === 'ignoreSenders' ? 'ignoreSenders'
        : body.list === 'ignoreChannels' ? 'ignoreChannels' : null;
      if (!key) return json(res, 400, { error: 'list is ignoreChannels or ignoreSenders' });
      const ignored = body.ignored === undefined ? true : Boolean(body.ignored);
      const { changed, errors } = store.setIgnored(key, body.value, ignored);
      return json(res, errors.length ? 400 : 200, {
        ok: errors.length === 0,
        changed,
        errors,
        ignored,
        value: body.value,
        [key]: config[key],
      });
    }

    /*
     * One channel's settings, merged rather than replaced.
     *
     * Separate from /config for the same reason /ignore is: this edits one
     * entry in a map that other clients are also editing, and handing the
     * whole map back and forth would let two Slack windows undo each other.
     * A patch with no keys in it clears the channel entirely.
     */
    if (req.method === 'POST' && url.pathname === '/channel') {
      const body = await readJson(req, res);
      if (!body) return undefined;
      if (!store) return json(res, 501, { error: 'this daemon cannot change settings' });
      const channel = String(body.channel || '').trim();
      if (!channel) return json(res, 400, { error: 'channel is required' });
      const patch = body.settings && typeof body.settings === 'object' ? body.settings : {};
      const result = Object.keys(patch).length || body.clear === true
        ? (body.clear === true ? store.clearChannel(channel) : store.setChannel(channel, patch))
        : { changed: [], errors: [{ key: 'settings', message: `nothing to set (${CHANNEL_KEYS.join(', ')})` }] };
      return json(res, result.errors.length ? 400 : 200, {
        ok: result.errors.length === 0,
        changed: result.changed,
        errors: result.errors,
        channel,
        settings: config.channelOverrides?.[channel] || null,
        channelOverrides: config.channelOverrides,
      });
    }

    if (req.method === 'POST' && url.pathname === '/pause') return setPaused(res, true);
    if (req.method === 'POST' && url.pathname === '/resume') return setPaused(res, false);
    if (req.method === 'POST' && url.pathname === '/toggle') return setPaused(res, !state?.paused);

    if (req.method === 'POST' && url.pathname === '/moderate') {
      const body = await readJson(req, res);
      if (!body) return undefined;
      if (typeof body.text !== 'string') {
        return json(res, 400, { error: 'text is required' });
      }
      const verdict = await moderator.moderate(body);
      return json(res, 200, verdict);
    }

    // The terminal is not the only place Slacken gets started from, so it
    // must not be the only place it can be stopped from. The reply goes out
    // first; the shutdown happens once it has actually left.
    if (req.method === 'POST' && url.pathname === '/stop') {
      if (!onStop) return json(res, 501, { error: 'this daemon cannot stop itself' });
      res.on('finish', () => onStop('a stop request'));
      return json(res, 200, { ok: true, stopping: true });
    }

    if (req.method === 'POST' && url.pathname === '/reinject') {
      await reinject();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpPort, '127.0.0.1', () => resolve(server));
  });
}

// Answers the 400 itself and returns null, so every caller is one line.
async function readJson(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    json(res, 400, { error: `bad JSON: ${err.message}` });
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    json(res, 400, { error: 'expected a JSON object' });
    return null;
  }
  return body;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
