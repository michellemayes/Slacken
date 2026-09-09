/*
 * Slacken page script.
 *
 * Runs inside the Slack renderer. It finds rendered messages from other
 * people, triages them locally, asks the daemon (over a CDP binding, so no
 * network request is made from the page and Slack's CSP is irrelevant) for a
 * neutral rewrite, and swaps the rewrite in with a badge that flips back to
 * the original text.
 *
 * The original DOM is never destroyed. It is hidden with an attribute we own
 * and revealed again on click.
 */
(() => {
  if (window.__SLACKEN__) return;
  window.__SLACKEN__ = true;

  const CONFIG = Object.assign({
    triageMode: 'heuristic',
    triageThreshold: 2,
    condenseEnabled: true,
    condenseMinWords: 45,
    maxChars: 4000,
    holdWhilePending: true,
    selfNames: [],
    ignoreSenders: [],
    ignoreChannels: [],
    requestTimeoutMs: 25000,
    verbose: false,
  }, window.__SLACKEN_CONFIG || {});

  const ASK = '__slackenAsk';
  const ATTR_STATE = 'data-slacken';
  const ATTR_HASH = 'data-slacken-hash';
  const ATTR_BODY = 'data-slacken-body';

  const SEL = {
    item: '[data-qa="virtual-list-item"]',
    content: '[data-qa="message_content"]',
    blocks: '.c-message_kit__blocks, .c-message__message_blocks',
    rich: '.p-rich_text_section',
    sender: '[data-qa="message_sender_name"]',
    channel: '[data-qa="channel_name"]',
    self: '[data-qa="user-button"]',
    composer: '[data-qa="message_input"], .ql-editor',
  };

  const log = (...args) => { if (CONFIG.verbose) console.log('[slacken]', ...args); };

  /* ---------------------------------------------------------------- styles */

  const STYLE_ID = 'slacken-style';
  const CSS = `
    [${ATTR_BODY}="hidden"] { display: none !important; }
    .slacken-panel { margin: 2px 0 0; }
    .slacken-rewrite {
      line-height: 1.46668;
      font-size: 15px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .slacken-panel[data-open="1"] .slacken-rewrite { display: none; }
    .slacken-badge {
      display: inline-flex; align-items: center; gap: 5px;
      margin-top: 3px; padding: 1px 8px;
      font-size: 11px; line-height: 17px; font-weight: 500;
      color: inherit; opacity: .62;
      background: transparent;
      border: 1px solid rgba(127,127,127,.45); border-radius: 10px;
      cursor: pointer; user-select: none;
    }
    .slacken-badge:hover { opacity: 1; border-color: rgba(127,127,127,.8); }
    .slacken-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #d9a441; flex: 0 0 auto;
    }
    .slacken-badge[data-severity="3"] .slacken-dot { background: #e01e5a; }
    .slacken-badge[data-kind="condensed"] .slacken-dot { background: #5b8def; }
    .slacken-action { opacity: .75; }
    .slacken-pending { opacity: .45; font-style: italic; }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------- transport */

  let seq = 0;
  const pending = new Map();

  window.__slackenResult = (json) => {
    let msg;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    clearTimeout(waiter.timer);
    waiter.resolve(msg);
  };

  function ask(payload) {
    if (typeof window[ASK] !== 'function') {
      return Promise.reject(new Error('binding missing'));
    }
    const id = `r${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('timeout'));
      }, CONFIG.requestTimeoutMs + 2000);
      pending.set(id, { resolve, reject, timer });
      try {
        window[ASK](JSON.stringify({ id, ...payload }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  /* -------------------------------------------------------------- triage */

  const ACRONYMS = new Set([
    'OK', 'PR', 'PRS', 'CI', 'CD', 'QA', 'API', 'EOD', 'ETA', 'FYI', 'PTO', 'WFH',
    'LGTM', 'TLDR', 'SLA', 'UTC', 'EST', 'PST', 'AM', 'PM', 'US', 'UK', 'EU', 'ID',
    'URL', 'HTTP', 'HTTPS', 'JSON', 'YAML', 'SQL', 'AWS', 'GCP', 'UI', 'UX', 'MVP',
    'KPI', 'OOO', 'RFC', 'PTAL', 'IMO', 'IIRC', 'TIL', 'CTA', 'CSV', 'PDF', 'DM',
    'DNS', 'SSH', 'SDK', 'CLI', 'IDE', 'OS', 'RAM', 'CPU', 'GPU', 'DB',
  ]);

  const URGENT_RE = /\b(asap|urgent(ly)?|immediately|right now|drop everything|top priority|highest priority|blocker|emergency|need this now|by eod|end of day|last chance|final (warning|reminder)|can'?t wait|no later than)\b/i;
  const BLAME_RE = /\b(why (haven'?t|hasn'?t|didn'?t|did no ?one|is no ?one|are (you|we) still)|unacceptable|ridiculous|how many times|i (already )?(told|asked|said)|you (need|have) to|do i (have|need) to|this is (a mess|broken|nonsense|not (ok|okay))|as i (already )?said|for the (third|last) time|seriously\?)\b/i;
  const PROFANE_RE = /\b(wtf|bullshit|bs|damn(it)?|shit|crap|f+u+c+k+\w*|hell)\b/i;

  function heuristicScore(text) {
    let score = 0;

    const shouted = (text.match(/\b[A-Z][A-Z0-9]{2,}\b/g) || [])
      .filter((w) => !ACRONYMS.has(w));
    score += Math.min(shouted.length, 2);

    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length > 15 && letters === letters.toUpperCase()) score += 2;

    const bangs = (text.match(/!/g) || []).length;
    if (bangs >= 4) score += 2;
    else if (bangs >= 2) score += 1;

    if (/[?!]{2,}/.test(text)) score += 1;
    if (URGENT_RE.test(text)) score += 2;
    if (BLAME_RE.test(text)) score += 2;
    if (PROFANE_RE.test(text)) score += 2;

    return score;
  }

  // Padding tells. Length alone is not one: a long message dense with facts is
  // worth reading in full. What earns a condense is length plus the shape of
  // writing that is mostly throat-clearing.
  const AI_TELLS = [
    /\bi hope (this|you|we)\b/i,
    /\b(just )?wanted to (reach out|take a moment|circle back|flag|check in|follow up|share)\b/i,
    /\bcircl(e|ed|ing) back\b/i,
    /\bas you (may|might) (recall|know|remember)\b/i,
    /\bit'?s (worth|important) (noting|to note|mentioning)\b/i,
    /\bplease (don'?t hesitate|feel free) to\b/i,
    /\blet me know if you have any (questions|thoughts|concerns)\b/i,
    /\b(happy|glad) to (discuss|elaborate|help|clarify)\b/i,
    /\bthat (being )?said\b/i,
    /\b(furthermore|moreover|additionally|in summary|to summarize|overall|in conclusion)\b/i,
    /\b(delve|leverage|robust|seamless|holistic|synerg\w*|streamlin\w*|actionable insights?)\b/i,
    /\bbest (path|way) forward\b/i,
    /\balign(ing)? on\b/i,
    /\b(several|a number of|various) (areas|aspects|factors|considerations|opportunities)\b/i,
    /\bafter (giving it )?(considerable|careful|some) (thought|consideration)\b/i,
    /\bi (believe|think|feel) it would be (beneficial|helpful|valuable|worth)\b/i,
    /\b(great|excellent) (question|point)\b/i,
    /\bcertainly[!,]/i,
    /\bhere'?s a (breakdown|summary|quick rundown|high[- ]level)\b/i,
    /\blet me (break|walk) (this|you|it) (down|through)\b/i,
    /\bfor visibility\b/i,
  ];

  function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function hasCode(text) {
    return /```/.test(text) || /^\s{4,}\S/m.test(text);
  }

  function paddingScore(text) {
    if (!CONFIG.condenseEnabled) return 0;
    if (hasCode(text)) return 0;
    // Mostly a bare link is not padding, it is a link.
    if (/^\s*<?https?:\/\/\S+>?\s*$/.test(text)) return 0;

    const words = wordCount(text);
    if (words < CONFIG.condenseMinWords) return 0;

    let tells = 0;
    for (const re of AI_TELLS) if (re.test(text)) tells += 1;
    if ((text.match(/^\s*([-*•]|\d+\.)\s+/gm) || []).length >= 3) tells += 1;
    if ((text.match(/\n\s*\n/g) || []).length >= 2) tells += 1;
    if (words >= 120) tells += 1;
    return tells;
  }

  function shouldAsk(text) {
    if (CONFIG.triageMode === 'always') return true;
    return heuristicScore(text) >= CONFIG.triageThreshold || paddingScore(text) >= 1;
  }

  /* ------------------------------------------------------------ extraction */

  let cachedSelf = null;
  function selfName() {
    if (cachedSelf) return cachedSelf;
    const el = document.querySelector(SEL.self);
    const label = el?.getAttribute('aria-label') || el?.getAttribute('data-tooltip') || '';
    const m = label.match(/:\s*(.+?)\s*$/);
    if (m) cachedSelf = m[1].trim();
    return cachedSelf;
  }

  function channelName() {
    const el = document.querySelector(SEL.channel);
    const name = el?.textContent?.trim();
    if (name) return name;
    return (document.title || '').split('|')[0].trim() || null;
  }

  // Grouped consecutive messages only carry the sender name on the first one,
  // so walk back through earlier list items until we find it.
  function senderFor(item) {
    let node = item;
    for (let i = 0; i < 40 && node; i += 1) {
      const el = node.querySelector?.(SEL.sender);
      if (el) return el.textContent.trim();
      node = node.previousElementSibling;
    }
    return null;
  }

  function bodyFor(item) {
    const content = item.querySelector(SEL.content);
    if (!content) return null;
    const blocks = content.querySelector(SEL.blocks);
    if (blocks) return blocks;
    // Older layouts put rich text straight under the content node.
    const rich = content.querySelector(SEL.rich);
    return rich ? rich.parentElement : null;
  }

  function textFor(body) {
    const sections = body.querySelectorAll(SEL.rich);
    const source = sections.length ? Array.from(sections) : [body];
    return source.map((el) => el.innerText).join('\n').trim();
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function matchesAny(list, value) {
    if (!value) return false;
    const needle = value.toLowerCase();
    return list.some((entry) => needle === String(entry).toLowerCase());
  }

  /* -------------------------------------------------------------- rendering */

  const verdicts = new Map(); // text hash -> verdict, so re-renders are free

  function rememberVerdict(key, verdict) {
    verdicts.set(key, verdict);
    if (verdicts.size > 800) verdicts.delete(verdicts.keys().next().value);
  }

  function actionLabel(verdict) {
    if (verdict.hostile && verdict.verbose) return 'softened · condensed';
    if (verdict.verbose) return 'condensed';
    return 'softened';
  }

  function clearPanels(item) {
    item.querySelectorAll('.slacken-panel').forEach((el) => el.remove());
  }

  // Local triage already suspects this one, so hide it now rather than letting
  // the hostile version sit on screen for the couple of seconds the model
  // takes. Restored in full if the model disagrees.
  function renderPending(item, body) {
    clearPanels(item);
    const panel = document.createElement('div');
    panel.className = 'slacken-panel';
    panel.dataset.open = '0';
    panel.dataset.pending = '1';

    const placeholder = document.createElement('div');
    placeholder.className = 'slacken-rewrite slacken-pending';
    placeholder.textContent = 'checking…';
    panel.appendChild(placeholder);

    body.setAttribute(ATTR_BODY, 'hidden');
    body.parentElement?.insertBefore(panel, body.nextSibling);
  }

  function restore(item, body) {
    clearPanels(item);
    body.removeAttribute(ATTR_BODY);
  }

  function render(item, body, verdict) {
    // Drop any panel left over from a previous render of this message.
    clearPanels(item);

    const panel = document.createElement('div');
    panel.className = 'slacken-panel';
    panel.dataset.open = '0';

    const rewrite = document.createElement('div');
    rewrite.className = 'slacken-rewrite';
    rewrite.textContent = verdict.rewrite;
    panel.appendChild(rewrite);

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'slacken-badge';
    badge.dataset.severity = String(verdict.severity);
    badge.dataset.kind = verdict.hostile ? 'softened' : 'condensed';
    const tones = (verdict.tone || []).join(', ');
    badge.title = [verdict.note, tones && `(${tones})`].filter(Boolean).join(' ')
      || 'Slacken rewrote this message';

    const dot = document.createElement('span');
    dot.className = 'slacken-dot';
    const label = document.createElement('span');
    label.textContent = actionLabel(verdict);
    const action = document.createElement('span');
    action.className = 'slacken-action';
    action.textContent = 'show original';
    badge.append(dot, label, action);

    badge.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = panel.dataset.open === '1';
      panel.dataset.open = open ? '0' : '1';
      body.setAttribute(ATTR_BODY, open ? 'hidden' : 'shown');
      action.textContent = open ? 'show original' : 'hide original';
    });

    panel.appendChild(badge);
    body.setAttribute(ATTR_BODY, 'hidden');
    body.parentElement?.insertBefore(panel, body.nextSibling);
  }

  function setAll(open) {
    document.querySelectorAll('.slacken-panel:not([data-pending])').forEach((panel) => {
      const badge = panel.querySelector('.slacken-badge');
      const body = panel.previousElementSibling;
      if (!badge || !body || !body.hasAttribute(ATTR_BODY)) return;
      panel.dataset.open = open ? '1' : '0';
      body.setAttribute(ATTR_BODY, open ? 'shown' : 'hidden');
      const action = panel.querySelector('.slacken-action');
      if (action) action.textContent = open ? 'hide original' : 'show original';
    });
  }

  /* ------------------------------------------------------------ processing */

  const IGNORE_STATES = new Set(['clean', 'skipped', 'pending', 'error']);

  function inViewport(el) {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return false;
    return rect.bottom > -600 && rect.top < window.innerHeight + 600;
  }

  async function processItem(item) {
    if (item.closest(SEL.composer)) return;

    const body = bodyFor(item);
    if (!body) return;

    const text = textFor(body);
    if (!text) return;
    if (text.length > CONFIG.maxChars) return;

    const key = hash(text);
    const state = item.getAttribute(ATTR_STATE);

    if (state && item.getAttribute(ATTR_HASH) === key) {
      // Already handled. Re-apply if React blew our panel away.
      if (state === 'done' && !item.querySelector('.slacken-panel')) {
        const verdict = verdicts.get(key);
        if (verdict) render(item, body, verdict);
        else item.removeAttribute(ATTR_STATE);
      }
      // Safety net: never leave a message hidden behind a hold that ended.
      if ((state === 'clean' || state === 'error') && body.hasAttribute(ATTR_BODY)) {
        restore(item, body);
      }
      if (IGNORE_STATES.has(state)) return;
      if (state === 'done') return;
    }

    item.setAttribute(ATTR_HASH, key);

    const sender = senderFor(item);
    const channel = channelName();
    const me = selfName();

    if ((me && sender === me)
      || matchesAny(CONFIG.selfNames, sender)
      || matchesAny(CONFIG.ignoreSenders, sender)
      || matchesAny(CONFIG.ignoreChannels, channel)) {
      item.setAttribute(ATTR_STATE, 'skipped');
      return;
    }

    const cached = verdicts.get(key);
    if (cached) {
      if (cached.flagged) {
        item.setAttribute(ATTR_STATE, 'done');
        render(item, body, cached);
      } else {
        item.setAttribute(ATTR_STATE, 'clean');
      }
      return;
    }

    if (!shouldAsk(text)) {
      item.setAttribute(ATTR_STATE, 'clean');
      return;
    }
    log('triage', heuristicScore(text), paddingScore(text), text.slice(0, 60));

    item.setAttribute(ATTR_STATE, 'pending');
    const held = CONFIG.holdWhilePending;
    if (held) renderPending(item, body);

    let verdict;
    try {
      verdict = await ask({ text, sender, channel });
    } catch (err) {
      log('ask failed', err.message);
      item.setAttribute(ATTR_STATE, 'error');
      if (held && item.isConnected) restore(item, body);
      return;
    }

    if (verdict.error) log('daemon error', verdict.error);
    rememberVerdict(key, verdict);

    // The virtual list may have recycled the node while we waited.
    if (item.getAttribute(ATTR_HASH) !== key || !item.isConnected) return;

    if (verdict.flagged && verdict.rewrite) {
      item.setAttribute(ATTR_STATE, 'done');
      render(item, body, verdict);
    } else {
      item.setAttribute(ATTR_STATE, 'clean');
      if (held) restore(item, body);
    }
  }

  function scan() {
    ensureStyle();
    const items = document.querySelectorAll(SEL.item);
    for (const item of items) {
      if (!inViewport(item)) continue;
      processItem(item).catch((err) => log('process failed', err.message));
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      try {
        scan();
      } catch (err) {
        log('scan failed', err.message);
      }
    }, 250);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('scroll', scheduleScan, true);
  // Backstop: the virtual list sometimes settles without a mutation we see.
  setInterval(scheduleScan, 3000);

  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey && event.shiftKey)) return;
    if (event.key.toLowerCase() !== 'u') return;
    event.preventDefault();
    const anyClosed = Array.from(document.querySelectorAll('.slacken-panel'))
      .some((p) => p.dataset.open !== '1');
    setAll(anyClosed);
  });

  window.__slackenRescan = () => {
    document.querySelectorAll(`[${ATTR_STATE}]`).forEach((el) => {
      el.removeAttribute(ATTR_STATE);
      el.removeAttribute(ATTR_HASH);
    });
    verdicts.clear();
    scan();
  };

  scheduleScan();
  log('page script ready', CONFIG);
})();
