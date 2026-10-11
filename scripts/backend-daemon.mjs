#!/usr/bin/env node
// Persistent home for a stdio app-server backend (e.g. Yacwu's Claude
// wrapper), so it and its running turns outlive Yacwu restarts.
//
//   node backend-daemon.mjs app-server --listen unix:///path.sock -- <command…>
//
// The backend runs once, as a child speaking newline-delimited JSON-RPC on
// stdio. Yacwu connects over the Unix socket with the same WebSocket framing
// codex's own Unix-socket transport uses (one JSON-RPC message per text
// frame). One client at a time: a reconnect replaces the previous one.
// Messages the backend sends while no client is connected are dropped;
// Yacwu re-resumes its threads and re-reads their history on reconnect.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
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

/**
 * Run the daemon: one backend child, one socket server.
 * @param {{ socketPath: string, command: string[] }} options
 */
export function runDaemon({ socketPath, command }) {
  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
  /** @type {import('node:net').Socket | null} */
  let client = null;
  const send = (opcode, payload) => { if (client && !client.destroyed) client.write(encodeFrame(opcode, payload)); };
  createInterface({ input: child.stdout }).on('line', (line) => { if (line) send(0x1, Buffer.from(line, 'utf8')); });
  const cleanup = () => { try { rmSync(socketPath, { force: true }); } catch { /* gone */ } };
  child.on('exit', (code, signal) => { cleanup(); process.exit(code ?? (signal ? 1 : 0)); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { child.kill('SIGTERM'); });

  const server = createServer((socket) => {
    let header = Buffer.alloc(0);
    let decoder = null;
    socket.on('data', (chunk) => {
      if (!decoder) {
        header = Buffer.concat([header, chunk]);
        const end = header.indexOf('\r\n\r\n');
        if (end < 0) { if (header.length > 16384) socket.destroy(); return; }
        const request = header.subarray(0, end).toString('latin1');
        const key = /^sec-websocket-key:\s*(.+)$/im.exec(request)?.[1]?.trim();
        if (!/^get /i.test(request) || !/^upgrade:\s*websocket/im.test(request) || !key) {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
          return;
        }
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
        // A reconnect replaces the previous connection.
        if (client && client !== socket) client.destroy();
        client = socket;
        decoder = createDecoder();
        chunk = header.subarray(end + 4);
        header = Buffer.alloc(0);
        if (!chunk.length) return;
      }
      let messages;
      try { messages = decoder.push(chunk); } catch { socket.destroy(); return; }
      for (const { opcode, payload } of messages) {
        if (opcode === 0x1) child.stdin.write(`${payload.toString('utf8')}\n`);
        else if (opcode === 0x9) socket.write(encodeFrame(0xa, payload));
        else if (opcode === 0x8) { socket.end(encodeFrame(0x8, Buffer.alloc(0))); }
      }
    });
    socket.on('close', () => { if (client === socket) client = null; });
    socket.on('error', () => {});
  });
  cleanup();
  server.listen(socketPath);
  return { child, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDaemon(parseArgs(process.argv.slice(2)));
}
