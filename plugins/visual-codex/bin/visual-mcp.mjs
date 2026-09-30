#!/usr/bin/env node
// visual-mcp: the Codex plugin's MCP server (stdio, newline-delimited JSON-RPC 2.0). Dependency-free, Node >= 22.
//
// Codex starts it and it lives exactly as long as Codex runs it. Each Codex thread (`params._meta.threadId` of a
// tools/call) gets its own connection to the Visual gateway, linked to one Visual chat through
// ~/.visual-bridge/links/codex-<threadId>.json (the same link format as the Claude Code bridge), so a later
// `$visual` in the same thread continues in that chat, even after Codex restarted.
//
//   visual_open({request, brief?, new?})   start or continue this thread's Visual chat
//   visual_reply({question_id, answer})    answer a question from Visual (Codex asks the user first: .mcp.json)
//   visual_decline({question_id})          tell Visual the answer won't be shared (sends no content)
//   visual_status()                        this thread's connection state
//
// Visual's questions reach the thread with `codex queue --thread <threadId> --message <text>`.
// This file is self-contained: the plugin folder is copied into Codex's cache, so it imports nothing outside it.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
export const VERSION = '0.1.0';
export const AGENT = 'codex';
export const LIMITS = { title: 100, cwd: 500, prompt: 4000, brief: 30000, transcript: 80000, answer: 100000, question: 20000 };
const ENTRY_LIMIT = 8000; // one transcript message, so a single paste can't crowd out the rest
const PAIR_TIMEOUT_MS = 20_000;
const IDLE_MS = 3 * 60 * 60 * 1000;
const RECONNECT_GIVE_UP_MS = 11 * 60 * 1000; // the server keeps a dropped bridge for 10 min
const QUEUE_TIMEOUT_MS = 60_000;
const THREAD_RE = /^[A-Za-z0-9_-]{1,100}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same content-free text as the Claude Code bridge.
export const DECLINED = 'Codex declined to share that (the user did not approve it, or it is not allowed from Visual).';

const stateDir = () => join(homedir(), '.visual-bridge');
const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');
// ~/.visual-bridge/config.json: {"apiUrl", "webUrl"}; environment variables win.
export function config() {
  try { const value = JSON.parse(readFileSync(join(stateDir(), 'config.json'), 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
const setting = (env, key, fallback) => String(process.env[env] || (typeof config()[key] === 'string' && config()[key]) || fallback).replace(/\/+$/, '');
const apiUrl = () => setting('VISUAL_API_URL', 'apiUrl', 'https://api-beta.visualunderstanding.ai');
const webUrl = () => setting('VISUAL_WEB_URL', 'webUrl', 'https://beta.visualunderstanding.ai');
const log = (...parts) => { try { process.stderr.write(`visual-mcp: ${parts.join(' ')}\n`); } catch {} };

export function wsUrl(base = apiUrl()) {
  const url = new URL(`${base}/bridge/connect`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  return url.href;
}

/** Cuts to `max` UTF-16 units without leaving half a surrogate pair. */
export function clip(text, max, marker = '…') {
  text = String(text ?? '');
  if (text.length <= max) return text;
  let cut = max - marker.length;
  if (/[\uD800-\uDBFF]/.test(text[cut - 1] ?? '')) cut -= 1;
  return text.slice(0, cut) + marker;
}

/** Keeps the last `max` units, starting on a line boundary when one is near. */
export function keepTail(text, max, marker = '[… earlier conversation omitted …]\n\n') {
  if (text.length <= max) return text;
  let tail = text.slice(text.length - (max - marker.length));
  const nl = tail.indexOf('\n');
  if (nl >= 0 && nl < 2000) tail = tail.slice(nl + 1);
  else if (/[\uDC00-\uDFFF]/.test(tail[0])) tail = tail.slice(1);
  return marker + tail;
}

const CONTROL = /\u001b\[[0-9;?]*[A-Za-z]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const cleanText = (text) => String(text ?? '').replace(CONTROL, '').trim();

// ---------------------------------------------------------------- Codex transcript
// ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl: a `session_meta` line (payload.id, cwd), then
// `response_item` lines. Conversation = payload.type "message" with role user (content input_text/input_image) or
// assistant (output_text). Developer messages, reasoning, tool outputs and events are skipped; tool calls
// (function_call, custom_tool_call, local_shell_call, web_search_call) become one line each.

const safeReaddir = (dir) => { try { return readdirSync(dir); } catch { return []; } };

/** The rollout file of a Codex thread, newest day first; null when there is none. */
export function findRollout(threadId, home = codexHome()) {
  if (!THREAD_RE.test(threadId ?? '')) return null;
  const suffix = `-${threadId}.jsonl`;
  const sessions = join(home, 'sessions');
  const desc = (dir) => safeReaddir(dir).sort().reverse();
  for (const year of desc(sessions)) {
    for (const month of desc(join(sessions, year))) {
      for (const day of desc(join(sessions, year, month))) {
        const hit = safeReaddir(join(sessions, year, month, day)).find((name) => name.startsWith('rollout-') && name.endsWith(suffix));
        if (hit) return join(sessions, year, month, day, hit);
      }
    }
  }
  const archived = safeReaddir(join(home, 'archived_sessions')).find((name) => name.startsWith('rollout-') && name.endsWith(suffix));
  return archived ? join(home, 'archived_sessions', archived) : null;
}

// Codex injects context as user messages: environment/instructions blocks, skill bodies, IDE state, image wrappers.
const INJECTED = /^(# AGENTS\.md instructions\b|<(environment_context|user_instructions|guardian_[a-z_]+|skill|recommended_plugins|turn_aborted|in-app-browser-context|ide_opened_file|no retained transcript delta entries|permissions instructions|image\b|\/image)[\s>])/;
const WRAPPED = /^<([A-Za-z][\w-]*)(\s[^>]*)?>[\s\S]*<\/\1>$/; // one tag around the whole text

export function cleanUserText(text) {
  text = cleanText(text);
  if (!text || INJECTED.test(text) || WRAPPED.test(text)) return '';
  // IDE context ("# Context from my IDE setup: … ## My request for Codex: …"): keep the request.
  if (/^# (Context from my IDE setup|Files mentioned by the user)/.test(text)) {
    const request = text.match(/^## My request(?: for Codex)?:\s*\n([\s\S]*)$/m);
    return request ? request[1].trim() : '';
  }
  return text;
}

const TOOL_KEYS = ['cmd', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'q', 'prompt', 'message'];
export function summarizeToolCall(name, input) {
  let detail = input;
  if (typeof input === 'string') {
    try { const parsed = JSON.parse(input); if (parsed && typeof parsed === 'object') detail = parsed; } catch {}
  }
  if (Array.isArray(detail)) detail = detail.join(' ');
  else if (detail && typeof detail === 'object') {
    const key = TOOL_KEYS.find((k) => (typeof detail[k] === 'string' && detail[k].trim()) || (Array.isArray(detail[k]) && detail[k].length));
    detail = key ? (Array.isArray(detail[key]) ? detail[key].join(' ') : detail[key]) : JSON.stringify(detail);
  }
  return `[tool ${name || 'tool'}: ${clip(String(detail ?? '').replace(/\s+/g, ' ').trim(), 200)}]`;
}

/** Condenses a Codex rollout to user/assistant text and one-line tool calls, most recent kept. */
export function extractTranscript(jsonl, { max = LIMITS.transcript } = {}) {
  const entries = [];
  const push = (who, text) => {
    text = cleanText(text);
    if (text) entries.push(clip(who ? `${who}: ${text}` : text, ENTRY_LIMIT));
  };
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const item = entry?.payload;
    if (entry?.type !== 'response_item' || !item || typeof item !== 'object') continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      if (item.role === 'user') {
        let image = false;
        for (const block of item.content) {
          if (block?.type === 'input_text') push('User', cleanUserText(block.text));
          else if (block?.type === 'input_image' && !image) { image = true; push('User', '[image]'); }
        }
      } else if (item.role === 'assistant') {
        for (const block of item.content) if (block?.type === 'output_text') push('Assistant', block.text);
      }
    } else if (item.type === 'function_call') push('', summarizeToolCall(item.name, item.arguments));
    else if (item.type === 'custom_tool_call') push('', summarizeToolCall(item.name, item.input));
    else if (item.type === 'local_shell_call') push('', summarizeToolCall('shell', item.action?.command ?? item.action));
    else if (item.type === 'web_search_call') push('', summarizeToolCall('web_search', item.action?.query ?? item.action));
  }
  return keepTail(entries.join('\n\n'), max);
}

/** The thread's working directory (latest turn_context, else session_meta) and condensed transcript. */
export function readSession(threadId) {
  const path = findRollout(threadId);
  if (!path) return { cwd: null, transcript: '' };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { cwd: null, transcript: '' }; }
  let cwd = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"cwd"')) continue;
    try {
      const entry = JSON.parse(line);
      if ((entry.type === 'session_meta' || entry.type === 'turn_context') && typeof entry.payload?.cwd === 'string') cwd = entry.payload.cwd;
    } catch {}
  }
  return { cwd, transcript: extractTranscript(text) };
}

function repoTitle(cwd) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5000 }).trim();
    if (top) return basename(top);
  } catch {}
  return basename(resolve(cwd)) || 'Codex';
}

// Codex starts this server in the plugin folder, so the process cwd says nothing about the session unless it differs.
const PLUGIN_ROOT = resolve(dirname(SCRIPT), '..');
const insidePlugin = (dir) => { try { const real = realpathSync(dir), root = realpathSync(PLUGIN_ROOT); return real === root || real.startsWith(`${root}${sep}`); } catch { return false; } };

export function sessionContext(threadId) {
  const session = readSession(threadId);
  const cwd = session.cwd || (insidePlugin(process.cwd()) ? '' : process.cwd());
  return { cwd: clip(cwd, LIMITS.cwd), title: clip(cwd ? repoTitle(cwd) : 'Codex', LIMITS.title), transcript: session.transcript };
}

// ---------------------------------------------------------------- links
// One Visual chat per Codex thread: links/codex-<threadId>.json holds the id and secret that let a later
// visual_open rejoin that chat. The secret goes only to the gateway; it is never logged or returned.

const linksDir = () => join(stateDir(), 'links');
export const linkKey = (threadId) => `codex-${threadId}`;
const linkPath = (key) => join(linksDir(), `${key}.json`);
function writePrivate(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
export function loadLink(key) {
  if (!KEY_RE.test(key ?? '')) return null;
  try {
    const link = JSON.parse(readFileSync(linkPath(key), 'utf8'));
    if (!UUID_RE.test(link.linkId ?? '') || !/^[A-Za-z0-9_-]{32,128}$/.test(link.secret ?? '')) return null;
    return { linkId: link.linkId, secret: link.secret, chatId: UUID_RE.test(link.chatId ?? '') ? link.chatId : null, createdAt: link.createdAt ?? null };
  } catch { return null; }
}
function saveLink(key, link) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  chmodSync(stateDir(), 0o700);
  mkdirSync(linksDir(), { recursive: true, mode: 0o700 });
  chmodSync(linksDir(), 0o700);
  writePrivate(linkPath(key), JSON.stringify({ linkId: link.linkId, secret: link.secret, chatId: link.chatId ?? null, createdAt: link.createdAt }, null, 2));
}
/** Removes the link file, only if it still names `linkId` when one is given. */
function removeLink(key, linkId) {
  if (!KEY_RE.test(key ?? '')) return;
  if (linkId && loadLink(key)?.linkId !== linkId) return;
  rmSync(linkPath(key), { force: true });
}
const newLink = () => ({ linkId: randomUUID(), secret: randomBytes(32).toString('base64url'), chatId: null, createdAt: new Date().toISOString() });
const rejoinFrame = (link, { title, cwd, prompt = '', brief = '', transcript = '' }) =>
  ({ type: 'rejoin', version: 1, agent: AGENT, linkId: link.linkId, secret: link.secret, title, cwd, prompt, brief, transcript });

// ---------------------------------------------------------------- browser, codex queue

function openBrowser(url) {
  if (process.env.VISUAL_BRIDGE_NO_OPEN) return false;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

export const questionMessage = (id, question) =>
  `Visual asks (question ${id}): ${question}\nInvestigate read-only, then answer with visual_reply (question_id "${id}"), or visual_decline if it can't be shared.`;

/** Queues a message into the live Codex thread. stdin must be /dev/null, or `codex` waits for it. */
function codexQueue(threadId, message, onSpawn) {
  const bin = process.env.CODEX_BIN || 'codex';
  let child;
  try { child = spawn(bin, ['queue', '--thread', threadId, '--message', message], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env }); } catch (error) {
    return log('codex queue failed:', error.message);
  }
  let stderr = '';
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, QUEUE_TIMEOUT_MS);
  timer.unref?.();
  child.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d; });
  child.on('spawn', onSpawn);
  child.on('error', (error) => { clearTimeout(timer); log('codex queue failed:', error.message); });
  child.on('exit', (code) => { clearTimeout(timer); if (code) log(`codex queue exited ${code}:`, clip(stderr.trim().replace(/\s+/g, ' '), 300)); });
}

// ---------------------------------------------------------------- one thread's connection to Visual

// mode 'hello' pairs a new chat under `link`; 'rejoin' reconnects the thread's linked chat. `ready` resolves with
// {type: 'paired', claimUrl} | {type: 'rejoined', chatId, open} | {type: 'unknown-link'} | {type: 'error', message}.
class Connection {
  constructor({ threadId, hello, link, mode, onEnd }) {
    Object.assign(this, { threadId, hello, link, mode, onEnd });
    this.key = linkKey(threadId);
    this.bridgeId = null; this.secret = null; this.claimUrl = null; this.claimed = false; this.chatId = null;
    this.state = 'connecting'; this.ended = false; this.fatal = null;
    this.ws = null; this.attempt = 0; this.downSince = null; this.lastActivity = Date.now();
    this.requests = new Map(); this.questions = new Map(); this.outbox = [];
    this.ready = new Promise((done) => { this.settle = done; });
    this.pairTimer = setTimeout(() => this.end(`Visual did not answer within ${PAIR_TIMEOUT_MS / 1000} s (${wsUrl()}).`), PAIR_TIMEOUT_MS);
    this.idleTimer = setInterval(() => { if (Date.now() - this.lastActivity > IDLE_MS) this.stop('idle for 3 hours'); }, 60_000);
    this.idleTimer.unref?.();
    this.connect();
  }

  get connected() { return !this.ended && this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN; }

  send(frame) {
    if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(frame)); return true; }
    return false;
  }

  resolveReady(result) {
    clearTimeout(this.pairTimer);
    const settle = this.settle;
    this.settle = null;
    settle?.(result);
  }

  // The chat this connection feeds; remembered in the link file so a later visual_open rejoins it.
  setChat(chatId) {
    if (typeof chatId !== 'string' || !UUID_RE.test(chatId) || chatId === this.chatId) return;
    this.chatId = chatId;
    if (this.link && !this.ended) {
      this.link.chatId = chatId;
      const onFile = loadLink(this.key);
      if (!onFile || onFile.linkId === this.link.linkId) try { saveLink(this.key, this.link); } catch (error) { log('cannot save link:', error.message); }
    }
  }

  end(reason, failure = { type: 'error', message: reason }) {
    if (this.ended) return;
    this.ended = true;
    this.state = 'ended';
    clearInterval(this.idleTimer);
    if (this.bridgeId) log(`thread ${this.threadId}: ended (${reason})`);
    this.resolveReady(failure);
    for (const done of this.requests.values()) done(null);
    this.requests.clear();
    try { this.ws?.close(1000, 'bye'); } catch {}
    this.onEnd?.(this);
  }

  // A linked connection `leave`s (Visual keeps the chat); `forget` or an unlinked one says `bye`.
  stop(reason, { forget = false } = {}) {
    const type = this.link && !forget ? 'leave' : 'bye';
    const sent = !this.ended && this.send({ type });
    this.end(reason);
    return sent;
  }

  onFrame(sock, data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (sock !== this.ws || this.ended) return;
    switch (msg.type) {
      case 'paired': {
        if (!ID_RE.test(msg.bridgeId ?? '') || typeof msg.code !== 'string' || typeof msg.secret !== 'string') return log('bad paired frame');
        Object.assign(this, { bridgeId: msg.bridgeId, secret: msg.secret, state: 'connected', attempt: 0 });
        this.claimUrl = `${webUrl()}/connect?code=${encodeURIComponent(msg.code)}`;
        if (this.link && msg.bridgeId !== this.link.linkId) { log('Visual did not take the link; this chat is not linked'); this.link = null; }
        if (this.link) try { saveLink(this.key, this.link); } catch (error) { log('cannot save link:', error.message); this.link = null; }
        return this.resolveReady({ type: 'paired', claimUrl: this.claimUrl });
      }
      case 'rejoined': {
        if (!this.link || msg.bridgeId !== this.link.linkId) return log('bad rejoined frame');
        const first = !this.bridgeId;
        Object.assign(this, { bridgeId: this.link.linkId, state: 'connected', claimed: true, attempt: 0, downSince: null });
        this.setChat(msg.chatId);
        if (first) this.resolveReady({ type: 'rejoined', chatId: this.chatId, open: !!msg.open });
        this.flush();
        return;
      }
      case 'resumed':
        Object.assign(this, { state: 'connected', attempt: 0, downSince: null });
        if (msg.claimed) this.claimed = true;
        this.setChat(msg.chatId);
        this.flush();
        return;
      case 'claimed':
        this.lastActivity = Date.now();
        this.claimed = true;
        return;
      case 'chat':
        this.setChat(msg.chatId);
        return;
      case 'ask': return this.onAsk(msg);
      case 'request-ack': {
        const done = this.requests.get(msg.id);
        if (done) { this.requests.delete(msg.id); done(msg); }
        this.setChat(msg.chatId);
        return;
      }
      case 'error':
        this.fatal = clip(String(msg.message ?? 'error'), 300);
        return log(`thread ${this.threadId}: server error:`, this.fatal);
      default:
    }
  }

  // Visual → Codex: the question is queued into the live thread, and Visual is told the answer awaits the user's
  // approval (visual_reply asks first), so it waits up to 5 minutes.
  onAsk(msg) {
    if (!ID_RE.test(msg.id ?? '') || typeof msg.question !== 'string') return log('bad ask frame');
    this.lastActivity = Date.now();
    if (this.questions.has(msg.id)) return;
    const question = clip(msg.question, LIMITS.question);
    this.questions.set(msg.id, { id: msg.id, question, at: Date.now(), answered: false });
    for (const [id, q] of this.questions) if (Date.now() - q.at > 60 * 60_000) this.questions.delete(id);
    codexQueue(this.threadId, questionMessage(msg.id, question), () => {
      const q = this.questions.get(msg.id);
      if (q && !q.answered) this.send({ type: 'status', id: msg.id, state: 'awaiting-approval' });
    });
  }

  answer(id, text) {
    const q = this.questions.get(id);
    if (!q) return { error: `No question ${id} from Visual in this thread.` };
    if (q.answered) return { error: `Question ${id} was already answered.` };
    q.answered = true;
    this.lastActivity = Date.now();
    const frame = { type: 'answer', id, text: clip(text, LIMITS.answer, '\n[… answer truncated …]') };
    const delivered = this.send(frame);
    if (!delivered) this.outbox.push(frame);
    return { delivered };
  }

  /** A new request for the chat this connection already has; resolves with the ack or null. */
  request(prompt, brief) {
    const id = randomBytes(12).toString('base64url');
    const ack = new Promise((done) => {
      this.requests.set(id, done);
      setTimeout(() => { if (this.requests.delete(id)) done(null); }, 5000).unref?.();
    });
    if (!this.send({ type: 'request', id, prompt, brief })) { this.requests.delete(id); return Promise.resolve(null); }
    this.lastActivity = Date.now();
    return ack;
  }

  flush() { while (this.outbox.length && this.send(this.outbox[0])) this.outbox.shift(); }

  onClose(sock, code, reason) {
    if (sock !== this.ws || this.ended) return;
    // 4001: Visual no longer knows this link. A first rejoin lets visual_open pair afresh; later, the link is dead.
    if (code === 4001 && !this.bridgeId) return this.end('unknown link', { type: 'unknown-link' });
    if (code === 4001 && this.link) removeLink(this.key, this.link.linkId);
    if (!this.bridgeId) return this.end(this.fatal || `Could not reach Visual at ${wsUrl()} (${code}${reason ? ` ${reason}` : ''}).`);
    if (code === 4000 || reason === 'ended' || this.fatal) return this.end(this.fatal || 'ended by Visual');
    // Anything else (a dropped network, a gateway restart's 1012) reconnects with backoff.
    if (this.state !== 'disconnected') { this.state = 'disconnected'; this.downSince = Date.now(); }
    if (Date.now() - this.downSince > RECONNECT_GIVE_UP_MS) return this.end('could not reconnect');
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
    setTimeout(() => this.connect(), delay).unref?.();
  }

  // A linked connection rejoins (empty prompt when reconnecting) once Visual has bound it to a chat, which is when the
  // gateway stores the link; before that, and for unlinked connections, a reconnect resumes with the pairing secret.
  firstFrame() {
    if (!this.bridgeId) {
      if (this.link && this.mode === 'rejoin') return rejoinFrame(this.link, this.hello);
      const hello = { type: 'hello', version: 1, agent: AGENT, ...this.hello };
      return this.link ? { ...hello, link: { id: this.link.linkId, secret: this.link.secret } } : hello;
    }
    if (this.link && (this.chatId || !this.secret)) return rejoinFrame(this.link, { title: this.hello.title, cwd: this.hello.cwd });
    return { type: 'resume', bridgeId: this.bridgeId, secret: this.secret };
  }

  connect() {
    if (this.ended) return;
    let sock;
    try { sock = new WebSocket(wsUrl()); } catch (error) { return this.onClose(this.ws, 1006, error.message); }
    this.ws = sock;
    sock.onopen = () => sock.send(JSON.stringify(this.firstFrame()));
    sock.onmessage = (event) => this.onFrame(sock, event.data);
    sock.onerror = () => {};
    sock.onclose = (event) => this.onClose(sock, event.code, event.reason);
  }

  /** Resolves once the socket is closed (or after `ms`). */
  closed(ms = 1500) {
    const sock = this.ws;
    if (!sock || sock.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((done) => {
      const timer = setTimeout(done, ms);
      sock.addEventListener('close', () => { clearTimeout(timer); done(); });
    });
  }
}

/** Best effort: rejoins an old link just to say `bye`, so Visual forgets it. */
function forgetLink(link, { title, cwd }) {
  return new Promise((done) => {
    let sock;
    const finish = () => { clearTimeout(timer); try { sock?.close(); } catch {} done(); };
    const timer = setTimeout(finish, 5000);
    try { sock = new WebSocket(wsUrl()); } catch { return finish(); }
    sock.onopen = () => sock.send(JSON.stringify(rejoinFrame(link, { title, cwd })));
    sock.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.type === 'rejoined') sock.send(JSON.stringify({ type: 'bye' }));
      else if (msg.type === 'error') finish();
    };
    sock.onerror = () => {};
    sock.onclose = finish;
  });
}

// ---------------------------------------------------------------- tools

const threads = new Map(); // threadId -> Connection (live or reconnecting)

function track(conn) {
  threads.set(conn.threadId, conn);
  return conn;
}
const untrack = (conn) => { if (threads.get(conn.threadId) === conn) threads.delete(conn.threadId); };
const liveConnection = (threadId) => { const conn = threads.get(threadId); return conn && !conn.ended ? conn : null; };

function reusedText(chatId, open) {
  const url = chatId ? `${webUrl()}/chat/${chatId}` : null;
  if (open) return `Reused this thread's Visual chat: the request was sent to the open chat${url ? ` (${url})` : ''}.`;
  const opened = url ? openBrowser(url) : false;
  return `Reused this thread's Visual chat and sent it the request${url ? `: ${url}` : ''}${opened ? ' (reopened in the browser).' : url ? ' (open this URL in your browser).' : '.'}`;
}

async function visualOpen(threadId, args) {
  if (typeof WebSocket !== 'function') throw new Error(`visual needs Node.js 22 or newer (running ${process.version}).`);
  const prompt = clip(cleanText(args.request), LIMITS.prompt);
  if (!prompt) throw new Error('visual_open needs a non-empty "request".');
  if (args.brief !== undefined && typeof args.brief !== 'string') throw new Error('"brief" must be text.');
  const brief = clip(String(args.brief ?? '').replace(CONTROL, ''), LIMITS.brief, '\n[… brief truncated …]');
  const key = linkKey(threadId);
  const context = sessionContext(threadId);
  let conn = liveConnection(threadId);
  let link = loadLink(key);

  if (args.new === true) {
    // Start over: the old chat's link is said goodbye to (by the live connection, else by a one-shot rejoin) and deleted.
    const sent = conn ? conn.stop('replaced by a new chat', { forget: true }) : false;
    if (conn) await conn.closed();
    if (link && !(sent && conn?.bridgeId === link.linkId)) await forgetLink(link, { title: context.title, cwd: context.cwd });
    if (link) removeLink(key, link.linkId);
    link = null;
  } else if (conn) {
    // (1) This thread's connection is live: ask in the Visual chat it already has.
    if (conn.connected && conn.claimed) {
      const ack = await conn.request(prompt, brief);
      if (ack?.accepted) return reusedText(conn.chatId || ack.chatId, !!ack.open);
    }
    // Never claimed: nothing to come back to, so start afresh. Otherwise (not connected now) rejoin below.
    const forget = !conn.claimed;
    conn.stop('replaced by a new connection', { forget });
    await conn.closed();
    if (forget && link?.linkId === conn.bridgeId) { removeLink(key, link.linkId); link = null; }
  }

  const hello = { title: context.title, cwd: context.cwd, prompt, brief, transcript: context.transcript };
  if (link) {
    // (2) This thread had a Visual chat: rejoin it with the new request, no connect page.
    const rejoining = track(new Connection({ threadId, hello, link, mode: 'rejoin', onEnd: untrack }));
    const result = await rejoining.ready;
    if (result.type === 'rejoined') return reusedText(result.chatId, result.open);
    if (result.type !== 'unknown-link') throw new Error(result.message || 'could not reach Visual.');
    removeLink(key, link.linkId); // Visual forgot it: pair a new chat
  }
  // (3) A new Visual chat, linked to this thread.
  const pairing = track(new Connection({ threadId, hello, link: newLink(), mode: 'hello', onEnd: untrack }));
  const result = await pairing.ready;
  if (result.type !== 'paired') throw new Error(result.message || 'pairing failed.');
  const opened = openBrowser(result.claimUrl);
  return `Started a new Visual chat. Connect page: ${result.claimUrl}${opened ? ' (opened in the browser).' : ' (open this URL in your browser).'}`;
}

function visualReply(threadId, args) {
  const conn = liveConnection(threadId);
  if (!conn) throw new Error('This thread is not connected to Visual; run $visual first.');
  if (typeof args.question_id !== 'string' || !ID_RE.test(args.question_id)) throw new Error('"question_id" is required.');
  if (typeof args.answer !== 'string' || !args.answer.trim()) throw new Error('"answer" must be non-empty text.');
  const result = conn.answer(args.question_id, args.answer);
  if (result.error) throw new Error(result.error);
  return result.delivered ? `Answered ${args.question_id}.` : `Answered ${args.question_id} (queued until Visual reconnects).`;
}

function visualDecline(threadId, args) {
  const conn = liveConnection(threadId);
  if (!conn) throw new Error('This thread is not connected to Visual.');
  if (typeof args.question_id !== 'string' || !ID_RE.test(args.question_id)) throw new Error('"question_id" is required.');
  const result = conn.answer(args.question_id, DECLINED);
  if (result.error) throw new Error(result.error);
  return `Declined ${args.question_id}.`;
}

function visualStatus(threadId) {
  const conn = liveConnection(threadId);
  const link = loadLink(linkKey(threadId));
  if (!conn) return JSON.stringify({ connection: 'none', linked: !!link, chatUrl: link?.chatId ? `${webUrl()}/chat/${link.chatId}` : null });
  return JSON.stringify({
    connection: conn.state, claimed: conn.claimed, linked: !!conn.link,
    chatUrl: conn.chatId ? `${webUrl()}/chat/${conn.chatId}` : null, claimUrl: conn.claimed ? null : conn.claimUrl,
    unanswered: [...conn.questions.values()].filter((q) => !q.answered).map((q) => q.id),
  });
}

export const TOOLS = [
  {
    name: 'visual_open',
    title: 'Open in Visual',
    description: 'Open (or continue) this Codex thread\'s Visual chat with a request, a short brief and the thread transcript. The first call opens a connect page in the browser; later calls continue in the same chat. Pass new: true to start a fresh chat.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'What the user wants explained, e.g. "explain this commit".' },
        brief: { type: 'string', description: 'The essentials Visual needs to start (under ~20,000 characters): key diffs or file excerpts with paths. No secrets.' },
        new: { type: 'boolean', description: 'Start a new Visual chat instead of continuing this thread\'s chat.' },
      },
      required: ['request'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'visual_reply',
    title: 'Answer Visual',
    description: 'Send the answer to a question Visual asked this thread ("Visual asks (question <id>): …"). Sends the answer text off this machine to Visual.',
    inputSchema: {
      type: 'object',
      properties: {
        question_id: { type: 'string', description: 'The id from "Visual asks (question <id>)".' },
        answer: { type: 'string', description: 'The concise, factual answer (no secrets).' },
      },
      required: ['question_id', 'answer'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'visual_decline',
    title: 'Decline Visual question',
    description: 'Tell Visual a question will not be answered (sends no content). Use when the user declined sending the answer or it cannot be shared.',
    inputSchema: {
      type: 'object',
      properties: { question_id: { type: 'string', description: 'The id from "Visual asks (question <id>)".' } },
      required: ['question_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'visual_status',
    title: 'Visual status',
    description: 'Show whether this Codex thread is connected to a Visual chat.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const HANDLERS = { visual_open: visualOpen, visual_reply: visualReply, visual_decline: visualDecline, visual_status: visualStatus };

/** The Codex thread of a tools/call: `_meta.threadId` (Codex also sends it in x-codex-turn-metadata). */
export function threadOf(params) {
  const meta = params?._meta;
  const id = meta?.threadId ?? meta?.['x-codex-turn-metadata']?.thread_id;
  return typeof id === 'string' && THREAD_RE.test(id) ? id : null;
}

async function callTool(params) {
  const handler = HANDLERS[params?.name];
  const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });
  if (!handler) return text(`Unknown tool ${clip(String(params?.name), 60)}.`, true);
  const threadId = threadOf(params);
  if (!threadId) return text('No Codex thread id in this call (_meta.threadId), so Visual cannot tell which session it belongs to.', true);
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  try { return text(await handler(threadId, args)); } catch (error) { return text(`Visual: ${error.message}`, true); }
}

// ---------------------------------------------------------------- JSON-RPC over stdio

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const write = (message) => { try { process.stdout.write(`${JSON.stringify(message)}\n`); } catch {} };

async function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  const { id, method, params } = message;
  if (typeof method !== 'string') return; // a response to nothing we sent
  const isRequest = id !== undefined && id !== null;
  if (!isRequest) return; // notifications (initialized, cancelled, …) need no answer
  const reply = (result) => write({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'visual', title: 'Visual', version: VERSION },
        instructions: 'Visual (visualunderstanding.ai) explains things from this Codex thread on a whiteboard. Use the $visual skill; messages starting "Visual asks (question <id>)" are questions from Visual, answered with visual_reply or visual_decline.',
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': return reply(await callTool(params));
    default: return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${clip(method, 60)}` } });
  }
}

let shuttingDown = false;
/** Codex stopped us: every thread's connection leaves (links are kept), then exit. */
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  const conns = [...threads.values()];
  for (const conn of conns) conn.stop(reason);
  await Promise.all(conns.map((conn) => conn.closed(1500)));
  process.exit(0);
}

export function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    handle(message).catch((error) => log('handler failed:', error.message));
  });
  rl.on('close', () => shutdown('Codex closed the MCP server'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('uncaughtException', (error) => { log('crash:', error.stack ?? error.message); shutdown('crashed'); });
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1]) === realpathSync(SCRIPT); } catch { return false; } })();
if (invokedDirectly) main();
