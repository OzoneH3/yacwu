#!/usr/bin/env node
// Yacwu session relay CLI for agents. Sends short messages to other Yacwu
// sessions on this machine and reads delivery status.
//
//   node "$YACWU_RELAY_CLI" peers  --session <your-session-id>
//   node "$YACWU_RELAY_CLI" send   --from <your-session-id> --to <session-id> [--id <message-id>] <text | ->
//   node "$YACWU_RELAY_CLI" inbox  --session <your-session-id>
//   node "$YACWU_RELAY_CLI" status --id <message-id>
//
// Reads YACWU_RELAY_URL and YACWU_RELAY_AUTH_FILE (set by the Yacwu server
// for its backends). Prints one JSON object. Exit codes: 0 success,
// 2 refused by the relay (bad input, unknown/disabled recipient, …),
// 1 the relay could not be reached or answered with a server error.
//
// `send` generates a message id unless --id is given and reuses it when it
// retries after a connection failure, so the relay can drop a duplicate. To
// retry a send yourself, pass the printed id back with --id.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';

const USAGE = `usage:
  yacwu-relay peers  --session <your-session-id>
  yacwu-relay send   --from <your-session-id> --to <session-id> [--id <message-id>] <text | ->
  yacwu-relay inbox  --session <your-session-id>
  yacwu-relay status --id <message-id>`;

const RETRIES = 2;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  /** @type {Record<string, string>} */
  const flags = {};
  const words = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--') {
      words.push(...rest.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${name}`);
      flags[name] = value;
      i += 1;
    } else {
      words.push(arg);
    }
  }
  return { command, flags, text: words.join(' ') };
}

export function newMessageId() {
  return `rm-${randomBytes(12).toString('hex')}`;
}

/**
 * The HTTP request a command makes.
 * @param {{command: string, flags: Record<string, string>, text: string}} args
 * @param {string} stdinText
 */
export function buildRequest(args, stdinText = '') {
  const need = (/** @type {string} */ name) => {
    const value = args.flags[name];
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  switch (args.command) {
    case 'send': {
      const text = args.text === '-' ? stdinText : args.text;
      if (!text.trim()) throw new Error('message text is required (or "-" to read stdin)');
      const id = args.flags.id || newMessageId();
      return {
        method: 'POST',
        path: '/api/relay/send',
        body: { id, from: need('from'), to: need('to'), text },
        id,
      };
    }
    case 'peers':
      return { method: 'GET', path: `/api/relay/peers?session=${encodeURIComponent(need('session'))}` };
    case 'inbox':
      return { method: 'GET', path: `/api/relay/inbox?session=${encodeURIComponent(need('session'))}` };
    case 'status':
      return { method: 'GET', path: `/api/relay/message?id=${encodeURIComponent(need('id'))}` };
    default:
      throw new Error(USAGE);
  }
}

/** @param {string} url */
export function target(url) {
  if (url.startsWith('unix:')) return { socketPath: url.slice('unix:'.length) };
  const parsed = new URL(url);
  return { hostname: parsed.hostname.replace(/^\[|\]$/g, ''), port: Number(parsed.port || 80) };
}

/**
 * Perform one HTTP exchange. Rejects only for transport failures.
 * @param {string} url
 * @param {string} credential
 * @param {{method: string, path: string, body?: unknown}} req
 * @returns {Promise<{status: number, body: unknown}>}
 */
export function exchange(url, credential, req) {
  return new Promise((resolve, reject) => {
    const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
    const call = httpRequest(
      {
        ...target(url),
        method: req.method,
        path: req.path,
        headers: {
          authorization: `Bearer ${credential}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
        },
        timeout: 30_000
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let body;
          try { body = JSON.parse(data); } catch { body = { raw: data }; }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    call.on('timeout', () => call.destroy(new Error('relay request timed out')));
    call.on('error', reject);
    if (payload) call.write(payload);
    call.end();
  });
}

/**
 * @param {{argv: string[], env: Record<string, string | undefined>, readFile?: (path: string) => string,
 *   readStdin?: () => string, send?: typeof exchange, sleep?: (ms: number) => Promise<void>}} io
 * @returns {Promise<{code: number, output: unknown}>}
 */
export async function run(io) {
  const readFile = io.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const send = io.send ?? exchange;
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let req;
  try {
    const args = parseArgs(io.argv);
    req = buildRequest(args, args.text === '-' ? (io.readStdin?.() ?? '') : '');
  } catch (error) {
    return { code: 2, output: { error: error instanceof Error ? error.message : String(error) } };
  }
  const url = io.env.YACWU_RELAY_URL;
  const authFile = io.env.YACWU_RELAY_AUTH_FILE;
  if (!url || !authFile) {
    return { code: 1, output: { error: 'YACWU_RELAY_URL and YACWU_RELAY_AUTH_FILE are not set; run this from a Yacwu session' } };
  }
  let credential;
  try {
    credential = readFile(authFile).trim();
  } catch (error) {
    return { code: 1, output: { error: `cannot read the relay credential: ${error instanceof Error ? error.message : String(error)}` } };
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      // Retries resend the identical request, including the message id.
      const { status, body } = await send(url, credential, req);
      const output = req.id && body && typeof body === 'object' ? { id: req.id, ...body } : body;
      if (status >= 200 && status < 300) return { code: 0, output };
      return { code: status >= 500 ? 1 : 2, output: { status, ...(/** @type {object} */ (output)) } };
    } catch (error) {
      if (attempt >= RETRIES) {
        return {
          code: 1,
          output: {
            error: `relay unreachable: ${error instanceof Error ? error.message : String(error)}`,
            ...(req.id ? { id: req.id, hint: `it may have been received; retry with --id ${req.id} to avoid a duplicate` } : {})
          }
        };
      }
      await sleep(250 * (attempt + 1));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({
    argv: process.argv.slice(2),
    env: process.env,
    readStdin: () => readFileSync(0, 'utf8')
  });
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.code;
}
