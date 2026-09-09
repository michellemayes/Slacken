import http from 'node:http';
import { menuModel } from './menubar.js';
import { SETTINGS } from './settings.js';

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
 *   POST /reinject   reload the page script without restarting the daemon
 */
export function createServer({ config, moderator, state, store, getStatus, reinject }) {
  const snapshot = () => ({
    paused: Boolean(state?.paused),
    pausedAt: state?.pausedAt ?? null,
    uptimeMs: state?.uptimeMs ?? 0,
    model: config.model,
    triageMode: config.triageMode,
    dailyBudgetUsd: config.dailyBudgetUsd,
    ...getStatus(),
    stats: moderator.stats,
    // What the settings menu draws its checkmarks from.
    config: { ...config },
  });

  const setPaused = (res, paused) => {
    state?.setPaused(paused);
    return json(res, 200, { ok: true, paused: Boolean(state?.paused) });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, ...getStatus(), paused: Boolean(state?.paused), stats: moderator.stats });
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
