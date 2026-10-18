#!/usr/bin/env node
// Persistent home for a stdio app-server backend (e.g. Yacwu's Claude
// wrapper), so it and its running turns outlive Yacwu restarts.
//
//   node backend-daemon.mjs app-server --listen unix:///path.sock -- <command…>
//
// The backend runs once, as a child speaking newline-delimited JSON-RPC on
// stdio. Yacwu connects over the Unix socket with the same WebSocket framing
// codex's own Unix-socket transport uses (one JSON-RPC message per text
// frame). One client at a time: a newcomer replaces the current client
// only if that one no longer answers a ping (otherwise it is refused, so a
// second Yacwu server cannot push out a working one).
// Notifications and requests the backend sends while no client is ready
// (between connections, e.g. while Yacwu restarts, or before the new
// client's `initialized`) are held and delivered once it is: a dropped
// request would leave the backend waiting for an answer forever. Responses
// are never held; one arriving with no client was for a client that is gone.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Matches Yacwu's own cap on one message. */
const MAX_MESSAGE = 64 * 1024 * 1024;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const listenAt = argv.indexOf('--listen');
  const split = argv.indexOf('--');
  const listen = listenAt >= 0 ? argv[listenAt + 1] : '';
  if (!listen?.startsWith('unix://') || listen.length <= 'unix://'.length) throw new Error('usage: backend-daemon.mjs app-server --listen unix://PATH -- COMMAND…');
  const command = split >= 0 ? argv.slice(split + 1) : [];
  if (!command.length) throw new Error('backend-daemon.mjs: no backend command after --');
  return { socketPath: listen.slice('unix://'.length), command };
}

/** @param {string} key */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** An unmasked server frame. @param {number} opcode @param {Buffer} payload */
export function encodeFrame(opcode, payload) {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  return Buffer.concat([header, payload]);
}

/**
 * Incremental decoder for (masked) client frames, reassembling fragments.
 * Returns complete messages as { opcode, payload }.
 */
export function createDecoder() {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  return {
    /** @param {Buffer} chunk */
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const out = [];
      for (;;) {
        if (buffer.length < 2) break;
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (length > MAX_MESSAGE) throw new Error('frame too large');
        const maskAt = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) break;
        let payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i % 4)];
        buffer = buffer.subarray(offset + length);
        if (opcode >= 0x8) { out.push({ opcode, payload }); continue; }
        if (opcode !== 0) { fragmentOpcode = opcode; fragments = []; }
        fragments.push(payload);
        if (fragments.reduce((sum, part) => sum + part.length, 0) > MAX_MESSAGE) throw new Error('message too large');
        if (fin) { out.push({ opcode: fragmentOpcode, payload: Buffer.concat(fragments) }); fragments = []; }
      }
      return out;
    }
  };
}

/** Held messages kept at most; beyond it the oldest notifications go first. */
const MAX_HELD = 20_000;

/** How long the current client has to answer before a newcomer replaces it. */
const PROBE_MS = 2000;

/** @param {string} line @returns {'request' | 'notification' | 'response'} */
export function messageKind(line) {
  try {
    const message = JSON.parse(line);
    if (message && typeof message.method === 'string') return message.id === undefined ? 'notification' : 'request';
  } catch { /* not JSON: pass it on like a notification */ return 'notification'; }
  return 'response';
}

/**
 * What the backend sent while no client was ready, in order. Requests are
 * never silently dropped: a full queue rejects new requests with an RPC error.
 */
export function createHeldMessages(limit = MAX_HELD, byteLimit = 16 * 1024 * 1024) {
  /** @type {{ line: string, request: boolean }[]} */
  let held = [];
  let bytes = 0;
  return {
    /** @param {string} line @param {boolean} request */
    hold(line, request) {
      const size = Buffer.byteLength(line);
      if (size > byteLimit) return false;
      while (held.length >= limit || bytes + size > byteLimit) {
        const oldest = held.findIndex((entry) => !entry.request);
        if (oldest < 0) return false;
        bytes -= Buffer.byteLength(held[oldest].line);
        held.splice(oldest, 1);
      }
      held.push({ line, request }); bytes += size;
      return true;
    },
    /** @returns {string[]} */
    take() {
      const lines = held.map((entry) => entry.line);
      held = []; bytes = 0;
      return lines;
    },
    shift() { const entry = held.shift(); if (entry) bytes -= Buffer.byteLength(entry.line); return entry?.line; },
    get bytes() { return bytes; },
    get size() { return held.length; }
  };
}

/** Wait without accumulating writes; a disconnect releases the producer. */
export function waitForDrain(stream) {
  if (stream.destroyed || !stream.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      stream.off('drain', done); stream.off('close', done); stream.off('error', done);
      resolve();
    };
    stream.once('drain', done); stream.once('close', done); stream.once('error', done);
  });
}

/** Bound unterminated backend lines too. Discard oversize output through its newline. */
export async function* boundedLines(stream, limit = MAX_MESSAGE) {
  let parts = [], size = 0, dropping = false;
  for await (const chunk of stream) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (!dropping) {
        size += piece.length;
        if (size > limit) {
          parts = []; dropping = true;
          console.error('yacwu backend output: oversized line discarded');
        } else parts.push(piece);
      }
      if (end < 0) break;
      if (!dropping) yield Buffer.concat(parts, size).toString('utf8');
      parts = []; size = 0; dropping = false; start = end + 1;
    }
  }
  if (size && !dropping) yield Buffer.concat(parts, size).toString('utf8');
}

/** @param {Buffer} payload */
function isInitialized(payload) {
  try { return JSON.parse(payload.toString('utf8'))?.method === 'initialized'; } catch { return false; }
}

/**
 * Run the daemon: one backend child, one socket server.
 * @param {{ socketPath: string, command: string[], heldMessageLimit?: number, heldByteLimit?: number }} options
 */
export function runDaemon({ socketPath, command, heldMessageLimit = MAX_HELD, heldByteLimit = 16 * 1024 * 1024 }) {
  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
  /** @type {import('node:net').Socket | null} */
  let client = null;
  /** The client has finished its handshake (sent `initialized`). */
  let ready = false;
  const held = createHeldMessages(heldMessageLimit, heldByteLimit);
  const connected = () => Boolean(client && !client.destroyed);
  // Pause stdout consumption while a connected client is not draining.
  const send = async (opcode, payload) => {
    const target = client;
    if (!target || target.destroyed) return;
    if (!target.write(encodeFrame(opcode, payload))) await waitForDrain(target);
  };
  const hold = async (line, kind) => {
    if (held.hold(line, kind === 'request') || kind !== 'request') return;
    const { id } = JSON.parse(line);
    const error = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Yacwu output queue is full; reconnect and retry the request.' } });
    if (!child.stdin.write(`${error}\n`)) await waitForDrain(child.stdin);
  };
  let flushing = null;
  const flush = () => flushing ??= (async () => {
    while (connected() && ready && held.size) await send(0x1, Buffer.from(held.shift(), 'utf8'));
  })().finally(() => { flushing = null; });
  void (async () => {
    for await (const line of boundedLines(child.stdout)) {
      if (!line) continue;
      const kind = messageKind(line);
      if (kind === 'response') { await send(0x1, Buffer.from(line, 'utf8')); continue; }
      if (connected() && ready) await flush();
      if (connected() && ready) await send(0x1, Buffer.from(line, 'utf8'));
      else await hold(line, kind);
    }
  })().catch((error) => {
    console.error(`yacwu backend output: ${error.message}`);
    client?.destroy();
  });
  const cleanup = () => { try { rmSync(socketPath, { force: true }); } catch { /* gone */ } };
  child.on('exit', (code, signal) => { cleanup(); process.exit(code ?? (signal ? 1 : 0)); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { child.kill('SIGTERM'); });

  /** Called when the current client answers a liveness ping. */
  let onPong = null;
  /**
   * Whether the current client still answers. A second Yacwu server (a test
   * copy, say) must not push out a working one: the two would keep
   * replacing each other. A client that doesn't answer is gone or stuck.
   * @returns {Promise<boolean>}
   */
  const clientAlive = () => new Promise((resolve) => {
    if (!connected()) { resolve(false); return; }
    const timer = setTimeout(() => { onPong = null; resolve(false); }, PROBE_MS);
    onPong = () => { clearTimeout(timer); onPong = null; resolve(true); };
    client.write(encodeFrame(0x9, Buffer.from('yacwu-daemon-probe')));
  });

  const server = createServer((socket) => {
    let header = Buffer.alloc(0);
    let decoder = null;
    /** Frames that arrived while deciding whether to accept this client. */
    let early = [];
    let earlyBytes = 0;
    let deciding = false;
    const receive = (chunk) => {
      let messages;
      try { messages = decoder.push(chunk); } catch { socket.destroy(); return; }
      for (const { opcode, payload } of messages) {
        if (opcode === 0x1) {
          if (!child.stdin.write(`${payload.toString('utf8')}\n`)) {
            socket.pause();
            child.stdin.once('drain', () => { if (!socket.destroyed) socket.resume(); });
          }
          if (!ready && socket === client && isInitialized(payload)) {
            ready = true;
            void flush().catch(() => socket.destroy());
          }
        } else if (opcode === 0x9) socket.write(encodeFrame(0xa, payload));
        else if (opcode === 0xa) { if (socket === client) onPong?.(); }
        else if (opcode === 0x8) { socket.end(encodeFrame(0x8, Buffer.alloc(0))); }
      }
    };
    const accept = (key, rest) => {
      if (socket.destroyed) return;
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
      // Replaces a previous client that no longer answers.
      if (client && client !== socket) client.destroy();
      client = socket;
      ready = false;
      decoder = createDecoder();
      for (const chunk of [rest, ...early]) if (chunk.length) receive(chunk);
      early = [];
    };
    socket.on('data', (chunk) => {
      if (decoder) { receive(chunk); return; }
      if (deciding) { earlyBytes += chunk.length; if (earlyBytes > MAX_MESSAGE) socket.destroy(); else early.push(chunk); return; }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) { if (header.length > 16384) socket.destroy(); return; }
      const request = header.subarray(0, end).toString('latin1');
      const key = /^sec-websocket-key:\s*(.+)$/im.exec(request)?.[1]?.trim();
      if (!/^get /i.test(request) || !/^upgrade:\s*websocket/im.test(request) || !key) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const rest = header.subarray(end + 4);
      header = Buffer.alloc(0);
      deciding = true;
      void clientAlive().then((alive) => {
        deciding = false;
        if (alive) socket.end('HTTP/1.1 409 Conflict\r\nContent-Type: text/plain\r\n\r\nanother Yacwu server is attached to this backend\n');
        else accept(key, rest);
      });
    });
    socket.on('close', () => { if (client === socket) { client = null; ready = false; } });
    socket.on('error', () => {});
  });
  cleanup();
  server.listen(socketPath);
  return { child, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDaemon(parseArgs(process.argv.slice(2)));
}
