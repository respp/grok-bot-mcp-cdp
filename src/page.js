// Code that runs inside the Grok Bot renderer (via CDP Runtime.evaluate).
// It must stay self-contained: it is sent as source text, so it can't use imports or outer variables.
// Selectors were read from Grok Bot 1.2.3; if the app changes its markup, fix them here.

function page(fn, args) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const TIME_RE = /^\d{1,2}:\d{2}(\s?[AP]M)?$/i;

  function agentButtons() {
    return [...document.querySelectorAll('button.sand-agent-item[data-agent-id]')];
  }

  function agentInfo(b) {
    const raw = b.getAttribute('aria-label') || '';
    const parts = raw.split(', ');
    const name = b.querySelector('.sand-agent-item__name')?.innerText.trim() || parts[0];
    const mark = b.querySelector('.sand-grok-bot-mark');
    return {
      name,
      id: b.dataset.agentId,
      main: parts.includes('Main Bot'),
      unread: parts.includes('Unread activity'),
      state: mark?.dataset.grokState || 'unknown',
      paused: mark?.dataset.paused === 'true',
      open: b.getAttribute('aria-current') === 'page',
      preview: clean(b.getAttribute('aria-description')).slice(0, 160),
    };
  }

  function findAgent(name) {
    const all = agentButtons().map(b => ({ b, info: agentInfo(b) }));
    const q = String(name).trim().toLowerCase();
    const exact = all.filter(a => a.info.name.toLowerCase() === q);
    const prefix = all.filter(a => a.info.name.toLowerCase().startsWith(q));
    const incl = all.filter(a => a.info.name.toLowerCase().includes(q));
    const hit = exact.length === 1 ? exact : prefix.length === 1 ? prefix : incl.length === 1 ? incl : null;
    if (hit) return hit[0];
    const pool = exact.length ? exact : prefix.length ? prefix : incl;
    if (pool.length > 1) throw new Error(`"${name}" matches several Bots: ${pool.map(a => a.info.name).join(', ')}`);
    throw new Error(`No Bot named "${name}". Bots: ${all.map(a => a.info.name).join(', ')}`);
  }

  function openName() {
    return document.getElementById('sand-conversation-heading')?.getAttribute('aria-label') || null;
  }

  function scroller() {
    let s = document.querySelector('.sand-virtual-transcript__row');
    while (s && !(s.scrollHeight > s.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    return s;
  }

  function parseRow(row) {
    const index = Number(row.dataset.index);
    const lines = row.innerText.split('\n').map(l => l.trim()).filter(Boolean);
    const msg = row.querySelector('.sand-message:not(.sand-activity-mark)');
    if (!msg) {
      if (row.querySelector('.sand-activity-mark')) return { index, kind: 'activity', text: clean(row.innerText) };
      return { index, kind: 'event', text: clean(row.innerText) };
    }
    const ids = (msg.getAttribute('aria-labelledby') || '').split(' ');
    const sender = (ids[0] && document.getElementById(ids[0])?.innerText.trim()) || lines[0] || '';
    const prose = msg.querySelector('.sand-message-prose');
    let text = prose ? prose.innerText : msg.innerText.split('\n').slice(1).join('\n');
    const extra = [...msg.querySelectorAll('a[href]')].map(a => a.href).filter(h => /^https?:/.test(h) && !text.includes(h));
    const time = TIME_RE.test(lines[lines.length - 1] || '') ? lines[lines.length - 1] : undefined;
    const out = { index, kind: 'message', sender, role: msg.dataset.role, text: clean(text) };
    if (extra.length) out.links = [...new Set(extra)];
    if (time) out.time = time;
    return out;
  }

  function renderedRows() {
    return [...document.querySelectorAll('.sand-virtual-transcript__row[data-index]')].map(parseRow);
  }

  function question() {
    const dismiss = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Dismiss question');
    if (!dismiss) return null;
    let box = dismiss.parentElement;
    const opts = el => [...el.querySelectorAll('button')].filter(b => b !== dismiss && (b.getAttribute('aria-label') || b.innerText).trim());
    while (box && opts(box).length < 2 && box !== document.body) box = box.parentElement;
    const buttons = opts(box);
    const choices = buttons.map(b => clean(b.getAttribute('aria-label') || b.innerText));
    const text = clean(box.innerText).split('\n').map(l => l.trim()).filter(l => l && !choices.some(c => c.startsWith(l) || l.startsWith(c)));
    return { question: text.join(' ').slice(0, 500), choices, buttons };
  }

  function busy() {
    const mark = document.querySelector('button.sand-agent-item[aria-current="page"] .sand-grok-bot-mark');
    const state = mark?.dataset.grokState || 'unknown';
    return { state, busy: !!document.querySelector('.sand-activity-mark[data-typing], .sand-activity-mark[data-activity]') || !['idle', 'unknown'].includes(state) };
  }

  async function toBottom() {
    const s = scroller();
    if (!s) return;
    for (let i = 0; i < 5; i++) {
      s.scrollTop = s.scrollHeight;
      await sleep(120);
      if (s.scrollHeight - s.scrollTop - s.clientHeight < 4) break;
    }
  }

  // Collect messages scrolling up from the bottom (the transcript is virtualized).
  async function collect(count, afterIndex = -1) {
    await toBottom();
    const s = scroller();
    const seen = new Map();
    for (let step = 0; step < 200; step++) {
      for (const r of renderedRows()) seen.set(r.index, r);
      const msgs = [...seen.values()].filter(r => r.kind === 'message' && r.index > afterIndex);
      const minIdx = Math.min(...seen.keys());
      if (!s || s.scrollTop <= 0 || msgs.length >= count || minIdx <= afterIndex) break;
      s.scrollTop = Math.max(0, s.scrollTop - s.clientHeight * 0.8);
      await sleep(150);
    }
    await toBottom();
    const msgs = [...seen.values()].filter(r => r.kind === 'message' && r.index > afterIndex).sort((a, b) => a.index - b.index);
    return msgs.slice(-count);
  }

  async function open(name) {
    const { b, info } = findAgent(name);
    if (openName() !== info.name) {
      b.click();
      for (let i = 0; i < 50 && openName() !== info.name; i++) await sleep(100);
      if (openName() !== info.name) throw new Error(`Could not open the chat with ${info.name}`);
      await sleep(400);
    }
    return info.name;
  }

  function editor() {
    const e = document.querySelector('[contenteditable="true"][role="textbox"][aria-label="Prompt"]');
    if (!e) throw new Error('Message box not found');
    return e;
  }

  const api = {
    async list() {
      return { open: openName(), agents: agentButtons().map(agentInfo) };
    },
    async read(agent, count) {
      const name = agent ? await open(agent) : openName();
      if (!name) throw new Error('No chat is open. Pass an agent name.');
      const messages = await collect(count);
      const q = question();
      return { agent: name, ...busy(), messages: messages.map(({ index, kind, ...m }) => m), question: q && { question: q.question, choices: q.choices } };
    },
    // Index of the newest row, used as the marker before sending.
    async marker(agent) {
      if (agent) await open(agent);
      await toBottom();
      const idx = renderedRows().map(r => r.index);
      return { agent: openName(), index: idx.length ? Math.max(...idx) : -1 };
    },
    async after(agent, index) {
      if (agent && openName() !== agent) await open(agent);
      const messages = await collect(50, index);
      const q = question();
      return { agent: openName(), ...busy(), messages, question: q && { question: q.question, choices: q.choices } };
    },
    async focusEditor() {
      const e = editor();
      e.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
      return clean(e.innerText);
    },
    async editorText() {
      return clean(editor().innerText);
    },
    async choose(agent, choice) {
      if (agent) await open(agent);
      const q = question();
      if (!q) throw new Error('There is no open question with choices in this chat');
      const c = String(choice).trim();
      let i = -1;
      if (/^[A-Za-z]$/.test(c)) i = c.toUpperCase().charCodeAt(0) - 65;
      else {
        const lc = c.toLowerCase();
        i = q.choices.findIndex(x => x.toLowerCase().startsWith(lc));
        if (i < 0) i = q.choices.findIndex(x => x.toLowerCase().includes(lc));
      }
      if (i < 0 || i >= q.buttons.length) throw new Error(`No choice matching "${choice}". Options: ${q.choices.join(' / ')}`);
      await toBottom();
      const idx = renderedRows().map(r => r.index);
      q.buttons[i].click();
      return { agent: openName(), picked: q.choices[i], index: idx.length ? Math.max(...idx) : -1 };
    },
  };

  if (!api[fn]) throw new Error(`Unknown page helper ${fn}`);
  return api[fn](...args);
}

export const PAGE_SCRIPT = page.toString();
