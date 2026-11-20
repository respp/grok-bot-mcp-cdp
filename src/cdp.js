// Minimal Chrome DevTools Protocol client for the Grok Bot app.
// The app should listen only on 127.0.0.1; no dependencies (Node >= 22 has a global WebSocket).
import { PAGE_SCRIPT } from './page.js';

const CDP_URL = process.env.GROK_BOT_CDP || 'http://127.0.0.1:9333';

export class AppUnreachable extends Error {}

async function pageTarget() {
  let list;
  try {
    list = await (await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  } catch {
    throw new AppUnreachable(`Grok Bot app is not reachable at ${CDP_URL}. Start it with --remote-debugging-port (headless setup: systemctl status grok-bot).`);
  }
  const page = list.find(p => p.type === 'page' && /index\.html/.test(p.url)) || list.find(p => p.type === 'page');
  if (!page) throw new AppUnreachable('Grok Bot app is running but has no window open.');
  return page;
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
      this.pending.clear();
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  // Run one of the page helpers (see page.js) and return its value.
  async call(fn, ...args) {
    const expression = `(${PAGE_SCRIPT})(${JSON.stringify(fn)}, ${JSON.stringify(args)})`;
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error(String(msg).split('\n')[0].replace(/^Error: /, ''));
    }
    return r.result.value;
  }
  async key(key, { shift = false } = {}) {
    const codes = { Enter: 13, Backspace: 8, a: 65 };
    const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: codes[key], modifiers: shift ? 8 : 0 };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key === 'Enter') await this.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  insertText(text) {
    return this.send('Input.insertText', { text });
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

export async function connect() {
  const page = await pageTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new AppUnreachable('Could not open the CDP connection to Grok Bot.'));
  });
  return new Session(ws);
}

// One tool call at a time: they all share one app window.
let chain = Promise.resolve();
export function serial(fn) {
  const run = chain.then(async () => {
    const s = await connect();
    try {
      return await fn(s);
    } finally {
      s.close();
    }
  });
  chain = run.catch(() => {});
  return run;
}
