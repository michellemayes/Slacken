import http from 'node:http';
import { menuModel } from './menubar.js';

/*
 * Small loopback-only control surface.
 *
 *   GET  /health     is the daemon up
 *   GET  /status     everything it knows about itself
 *   GET  /menubar    the same thing, already rendered as a menu
 *   POST /pause      stop changing anything, and reveal what is on screen
 *   POST /resume     start again
 *   POST /toggle     whichever of the two applies — what the menu bar clicks
 *   POST /moderate   rewrite one message, for `slacken test` and poking by hand
 *   POST /reinject   reload the page script without restarting the daemon
 */
export function createServer({ config, moderator, state, getStatus, reinject }) {
  const snapshot = () => ({
    paused: Boolean(state?.paused),
    pausedAt: state?.pausedAt ?? null,
    uptimeMs: state?.uptimeMs ?? 0,
    model: config.model,
    triageMode: config.triageMode,
    dailyBudgetUsd: config.dailyBudgetUsd,
    ...getStatus(),
    stats: moderator.stats,
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

    if (req.method === 'POST' && url.pathname === '/pause') return setPaused(res, true);
    if (req.method === 'POST' && url.pathname === '/resume') return setPaused(res, false);
    if (req.method === 'POST' && url.pathname === '/toggle') return setPaused(res, !state?.paused);

    if (req.method === 'POST' && url.pathname === '/moderate') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return json(res, 400, { error: `bad JSON: ${err.message}` });
      }
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
