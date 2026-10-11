import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptKey, createDecoder, encodeFrame, parseArgs, runDaemon } from '../../scripts/backend-daemon.mjs';

test('arguments name the socket and the backend command', () => {
  assert.deepEqual(parseArgs(['app-server', '--listen', 'unix:///tmp/x.sock', '--', 'node', 'b.mjs', 'a']), { socketPath: '/tmp/x.sock', command: ['node', 'b.mjs', 'a'] });
  assert.throws(() => parseArgs(['app-server', '--listen', 'stdio://', '--', 'x']), /usage/);
  assert.throws(() => parseArgs(['app-server', '--listen', 'unix:///tmp/x.sock']), /no backend command/);
});

test('handshake accept key follows RFC 6455', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('masked, fragmented and long client frames decode', () => {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = (opcode, text, fin = true) => {
    const payload = Buffer.from(text);
    const out = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
    const header = payload.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    return Buffer.concat([header, mask, out]);
  };
  const decoder = createDecoder();
  const long = 'x'.repeat(300);
  const bytes = Buffer.concat([masked(1, '{"a":1}'), masked(1, 'par', false), masked(0, 'tial'), masked(1, long), masked(9, 'p')]);
  // Delivered in awkward chunks.
  const messages = [...decoder.push(bytes.subarray(0, 5)), ...decoder.push(bytes.subarray(5))];
  assert.deepEqual(messages.map((m) => [m.opcode, m.payload.toString()]), [[1, '{"a":1}'], [1, 'partial'], [1, long], [9, 'p']]);
});

test('the daemon relays JSON lines to its backend and keeps it across reconnects', { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'yacwu-backend-daemon-'));
  const socketPath = join(dir, 'b.sock');
  // A stand-in backend: echoes every request line back as a result.
  const { child, server } = runDaemon({ socketPath, command: [process.execPath, '-e', "require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);console.log(JSON.stringify({id:m.id,result:{pid:process.pid}}))})"] });
  t.after(() => { child.removeAllListeners('exit'); child.kill(); server.close(); });
  await new Promise((resolve) => server.on('listening', resolve));
  const roundTrip = (id) => new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    let upgraded = false;
    socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    socket.on('data', (chunk) => { try {
      buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffered.subarray(0, end).toString();
        assert.ok(head.startsWith('HTTP/1.1 101 Switching Protocols'), head);
        assert.ok(head.includes('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo='), head);
        upgraded = true;
        buffered = buffered.subarray(end + 4);
        const payload = Buffer.from(JSON.stringify({ id, method: 'ping' }));
        const mask = Buffer.from([9, 8, 7, 6]);
        socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]));
      }
      if (buffered.length >= 2 && buffered.length >= 2 + buffered[1]) {
        const message = JSON.parse(buffered.subarray(2, 2 + buffered[1]).toString());
        socket.destroy();
        resolve(message);
      }
    } catch (error) { socket.destroy(); reject(error); } });
    socket.on('error', reject);
  });
  const first = await roundTrip(1);
  const second = await roundTrip(2);
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  // The same backend process answered both connections.
  assert.equal(first.result.pid, second.result.pid);
  assert.equal(first.result.pid, child.pid);
});

test('server frames carry their length correctly', () => {
  assert.deepEqual([...encodeFrame(1, Buffer.from('hi'))], [0x81, 2, 104, 105]);
  const medium = encodeFrame(1, Buffer.alloc(300));
  assert.deepEqual([...medium.subarray(0, 4)], [0x81, 126, 1, 44]);
  assert.equal(encodeFrame(2, Buffer.alloc(70000))[1], 127);
});
