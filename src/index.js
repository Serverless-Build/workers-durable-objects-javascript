import { DurableObject } from 'cloudflare:workers';

const MARKER = 'SERVERLESS_BUILD_DURABLE_OBJECTS_JAVASCRIPT_V1';
const MIN = -1_000_000;
const MAX = 1_000_000;
const MAX_BODY_BYTES = 1024;
const NAME = /^[A-Za-z0-9_-]{1,40}$/;

/** Each named object owns an independent, persistent SQLite database. */
export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
    ctx.storage.sql.exec('INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)');
  }

  read() {
    return this.ctx.storage.sql.exec('SELECT value FROM counter WHERE id = 1').one().value;
  }

  change(delta) {
    // One synchronous SQL statement makes concurrent RPC updates atomic.
    const rows = this.ctx.storage.sql.exec(
      'UPDATE counter SET value = value + ? WHERE id = 1 AND value + ? BETWEEN ? AND ? RETURNING value',
      delta, delta, MIN, MAX,
    ).toArray();
    return rows[0]?.value ?? null;
  }

  setCount(value) {
    return this.ctx.storage.sql.exec(
      'UPDATE counter SET value = ? WHERE id = 1 RETURNING value', value,
    ).one().value;
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/' || path === '/health') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      if (path === '/health') return json({ ok: true, marker: MARKER });
      return json({
        pattern: 'SQLite-backed named counters', runtime: 'JavaScript', marker: MARKER,
        endpoints: ['GET /counter/{name}', 'POST /counter/{name}/increment',
          'POST /counter/{name}/decrement', 'POST /counter/{name}/reset', 'POST /counter/{name}/set'],
        limits: { min: MIN, max: MAX, name: '1–40 ASCII letters, numbers, hyphens, or underscores' },
        note: 'Each name has independent, persistent storage. Demo names are public; use a unique name.',
      });
    }

    const match = /^\/counter\/([^/]+)(?:\/(increment|decrement|reset|set))?$/.exec(path);
    if (!match) return json({ error: 'Not found' }, 404);
    const [, name, operation] = match;
    if (!NAME.test(name)) return json({ error: 'Name must be 1–40 ASCII letters, numbers, hyphens, or underscores.' }, 400);
    if (request.method !== (operation ? 'POST' : 'GET')) return json({ error: 'Method not allowed' }, 405);

    let value;
    if (operation === 'set') {
      const parsed = await parseSetValue(request);
      if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
      value = parsed.value;
    }

    const stub = env.COUNTER.getByName(name);
    let count;
    if (!operation) count = await stub.read();
    else if (operation === 'increment') count = await stub.change(1);
    else if (operation === 'decrement') count = await stub.change(-1);
    else count = await stub.setCount(operation === 'reset' ? 0 : value);
    if (count === null) return json({ error: `Counter must stay between ${MIN} and ${MAX}.` }, 409);
    return json({ name, count, ...(operation ? { operation } : {}), marker: MARKER });
  },
};

async function parseSetValue(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return { ok: false, status: 400, error: 'Send a JSON object with one integer value.' };
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'JSON body exceeds 1024 bytes.' };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: 'Send a JSON object with one integer value.' };
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413, error: 'JSON body exceeds 1024 bytes.' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !Object.hasOwn(body, 'value') ||
      !Number.isSafeInteger(body.value) || body.value < MIN || body.value > MAX) throw new Error('Invalid value');
    return { ok: true, value: body.value };
  } catch {
    return { ok: false, status: 400, error: `Value must be an integer between ${MIN} and ${MAX}.` };
  }
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}
