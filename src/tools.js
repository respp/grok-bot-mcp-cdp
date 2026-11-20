// MCP tools for the Grok Bot app. Same tool names and arguments as rthomas24/grok-bot-mcp.
import { serial } from './cdp.js';

const POLL_MS = 2000;

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function str(args, key, required) {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
  return v;
}

function num(args, key, { min, max, fallback, integer = false }) {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || Number.isNaN(v) || (integer && !Number.isInteger(v))) throw new Error(`"${key}" must be ${integer ? 'an integer' : 'a number'}`);
  if (v < min || v > max) throw new Error(`"${key}" must be between ${min} and ${max}`);
  return v;
}

function bool(args, key, fallback) {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new Error(`"${key}" must be true or false`);
  return v;
}

const strip = m => { const { index, kind, ...rest } = m; return rest; };

// Poll after the marker row until the Bot is idle and quiet, or asks a question.
async function waitForReply(s, { agent, index, timeoutS, quietS, signal, progress }) {
  const started = Date.now();
  const deadline = started + timeoutS * 1000;
  let last = '';
  let stableSince = Date.now();
  let r;
  while (Date.now() < deadline && !signal?.aborted) {
    await sleep(POLL_MS, signal);
    if (signal?.aborted) break;
    r = await s.call('after', agent, index);
    const replies = r.messages.filter(m => m.role !== 'user');
    const seen = `${replies.length}\n${replies.at(-1)?.text ?? ''}\n${r.busy}`;
    if (seen !== last) { last = seen; stableSince = Date.now(); }
    progress?.(Math.round((Date.now() - started) / 1000), replies.length ? `${agent} is replying…` : `Waiting for ${agent}…`);
    if (r.question) break;
    if (replies.length && !r.busy && Date.now() - stableSince >= quietS * 1000) break;
  }
  if (signal?.aborted) return { cancelled: true };
  r = await s.call('after', agent, index);
  const replies = r.messages.filter(m => m.role !== 'user').map(strip);
  const timedOut = Date.now() >= deadline && !r.question;
  const out = { timedOut, busy: r.busy, replies };
  if (r.question) out.question = r.question;
  if (timedOut) out.note = replies.length ? `${agent} was still writing. Call read_messages later for the rest.` : `${agent} hasn't replied yet. It may still be working: call read_messages later.`;
  return out;
}

const agentParam = { type: 'string', description: 'Bot name as shown by list_agents. Case-insensitive; a unique prefix works too.' };
const waitParams = {
  wait_for_reply: { type: 'boolean', default: true, description: 'Wait for the Bot to reply and return the reply (default true).' },
  timeout_seconds: { type: 'number', minimum: 5, maximum: 900, default: 180, description: 'Longest wait for a reply, in seconds (default 180).' },
  quiet_seconds: { type: 'number', minimum: 2, maximum: 120, default: 12, description: 'Reply is finished after this many seconds with no change and the Bot idle (default 12).' },
};
const waitArgs = a => ({
  wait: bool(a, 'wait_for_reply', true),
  timeoutS: num(a, 'timeout_seconds', { min: 5, max: 900, fallback: 180 }),
  quietS: num(a, 'quiet_seconds', { min: 2, max: 120, fallback: 12 }),
});

export const tools = [
  {
    name: 'list_agents',
    title: 'List Grok Bot agents',
    description: 'List the Bots in Grok Bot (name, unread, state, last message preview) and which chat is open. Call this first to check that the app is reachable.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List Grok Bot agents', readOnlyHint: true, openWorldHint: false },
    handler: () => serial(s => s.call('list')),
  },
  {
    name: 'read_messages',
    title: 'Read Grok Bot messages',
    description: 'Read recent messages from a Bot chat, including any multiple-choice question the Bot is waiting on. Opening a chat marks it as read in Grok Bot.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { ...agentParam, description: `${agentParam.description} Defaults to the open chat.` },
        count: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'How many recent messages (default 10).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Read Grok Bot messages', readOnlyHint: true, openWorldHint: false },
    handler: args => {
      const agent = str(args, 'agent');
      const count = num(args, 'count', { min: 1, max: 50, fallback: 10, integer: true });
      return serial(s => s.call('read', agent, count));
    },
  },
  {
    name: 'send_message',
    title: 'Send a message to a Grok Bot agent',
    description: 'Send a message to a Bot as the user and, by default, wait for its reply. Ask the user first if the message would make the Bot act outside Grok Bot (email, purchases, posts, account changes).',
    inputSchema: {
      type: 'object',
      properties: { agent: agentParam, message: { type: 'string', minLength: 1, description: 'The message to send.' }, ...waitParams },
      required: ['agent', 'message'],
      additionalProperties: false,
    },
    annotations: { title: 'Send a message to a Grok Bot agent', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: (args, ctx) => {
      const agent = str(args, 'agent', true);
      const message = str(args, 'message', true);
      const { wait, timeoutS, quietS } = waitArgs(args);
      return serial(async s => {
        const { agent: name, index } = await s.call('marker', agent);
        const left = await s.call('focusEditor');
        if (left) throw new Error('Could not clear the message box; nothing was sent.');
        const lines = message.replace(/\r\n?/g, '\n').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (i) await s.key('Enter', { shift: true });
          if (lines[i]) await s.insertText(lines[i]);
        }
        const typed = await s.call('editorText');
        if (typed.replace(/\s+/g, ' ').trim() !== message.replace(/\s+/g, ' ').trim()) {
          await s.call('focusEditor');
          throw new Error('The message box did not hold the exact text; cleared it and sent nothing.');
        }
        await s.key('Enter');
        await sleep(800);
        if (await s.call('editorText')) throw new Error('Pressed Enter but the message is still in the box; it may not have been sent.');
        if (!wait) return { agent: name, sent: true };
        return { agent: name, sent: true, ...(await waitForReply(s, { agent: name, index, timeoutS, quietS, ...ctx })) };
      });
    },
  },
  {
    name: 'answer_choice',
    title: 'Answer a Grok Bot question',
    description: 'Click an option on a multiple-choice question a Bot asked. Pass a letter ("A", "B"…) or the start of the option text. Waits for the reply by default.',
    inputSchema: {
      type: 'object',
      properties: {
        choice: { type: 'string', minLength: 1, description: 'Letter ("A", "B"…) or the start of the option text.' },
        agent: { ...agentParam, description: `${agentParam.description} Defaults to the open chat.` },
        ...waitParams,
      },
      required: ['choice'],
      additionalProperties: false,
    },
    annotations: { title: 'Answer a Grok Bot question', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: (args, ctx) => {
      const choice = str(args, 'choice', true);
      const agent = str(args, 'agent');
      const { wait, timeoutS, quietS } = waitArgs(args);
      return serial(async s => {
        const r = await s.call('choose', agent, choice);
        if (!wait) return r;
        const { index, ...rest } = r;
        return { ...rest, ...(await waitForReply(s, { agent: r.agent, index, timeoutS, quietS, ...ctx })) };
      });
    },
  },
];
