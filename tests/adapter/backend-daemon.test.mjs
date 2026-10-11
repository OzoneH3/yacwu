import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptKey, createDecoder, createHeldMessages, encodeFrame, messageKind, parseArgs, runDaemon } from '../../scripts/backend-daemon.mjs';

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

/** A minimal WebSocket client for the daemon's socket. */
function connectClient(socketPath) {
  const socket = createConnection(socketPath);
  let buffered = Buffer.alloc(0);
  let upgraded = false;
  let status = '';
  const received = [];
  const waiters = [];
  const deliver = () => { while (received.length && waiters.length) waiters.shift()(received.shift()); };
  const opened = new Promise((resolve, reject) => {
    socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) return;
        status = buffered.subarray(0, end).toString().split('\r\n')[0];
        upgraded = true;
        buffered = buffered.subarray(end + 4);
        resolve(status);
      }
      // Test messages stay under 126 bytes: a one-byte length.
      while (buffered.length >= 2 && buffered.length >= 2 + buffered[1]) {
        const opcode = buffered[0] & 0x0f;
        const payload = buffered.subarray(2, 2 + buffered[1]);
        buffered = buffered.subarray(2 + buffered[1]);
        // Answer the daemon's liveness pings, as Yacwu does.
        if (opcode === 0x9) frame(0xa, payload);
        else if (opcode === 0x1) received.push(JSON.parse(payload.toString()));
      }
      deliver();
    });
  });
  function frame(opcode, payload) {
    const mask = Buffer.from([9, 8, 7, 6]);
    socket.write(Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]));
  }
  return {
    opened,
    send(message) { frame(0x1, Buffer.from(JSON.stringify(message))); },
    next: () => new Promise((resolve) => { waiters.push(resolve); deliver(); }),
    pending: () => received.length,
    close: () => new Promise((resolve) => { if (socket.destroyed) { resolve(); return; } socket.once('close', resolve); socket.destroy(); })
  };
}

test('what the backend sends between clients waits for the next client\'s handshake', { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'yacwu-backend-daemon-'));
  const socketPath = join(dir, 'b.sock');
  // A stand-in backend: answers every request; on "later" it sends a
  // notification and a request of its own shortly afterwards.
  const backend = `require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);
    if(m.id!==undefined&&m.method)console.log(JSON.stringify({id:m.id,result:{}}));
    if(m.method==='later')setTimeout(()=>{console.log(JSON.stringify({method:'item/completed',params:{n:1}}));console.log(JSON.stringify({id:'q1',method:'item/tool/requestUserInput',params:{}}))},300);
    if(m.id==='q1')console.log(JSON.stringify({method:'answered',params:{}}))})`;
  const { child, server } = runDaemon({ socketPath, command: [process.execPath, '-e', backend] });
  t.after(() => { child.removeAllListeners('exit'); child.kill(); server.close(); });
  await new Promise((resolve) => server.on('listening', resolve));

  const first = connectClient(socketPath);
  await first.opened;
  first.send({ id: 1, method: 'initialize' });
  assert.deepEqual(await first.next(), { id: 1, result: {} });
  first.send({ method: 'initialized' });
  first.send({ id: 2, method: 'later' });
  assert.deepEqual(await first.next(), { id: 2, result: {} });
  // Gone before the backend's messages arrive, like Yacwu restarting.
  await first.close();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const second = connectClient(socketPath);
  await second.opened;
  second.send({ id: 1, method: 'initialize' });
  // The handshake reply comes first; nothing held is sent before `initialized`.
  assert.deepEqual(await second.next(), { id: 1, result: {} });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(second.pending(), 0);
  second.send({ method: 'initialized' });
  assert.deepEqual(await second.next(), { method: 'item/completed', params: { n: 1 } });
  assert.deepEqual(await second.next(), { id: 'q1', method: 'item/tool/requestUserInput', params: {} });
  // The new client can answer the request the backend has been waiting on.
  second.send({ id: 'q1', result: {} });
  assert.deepEqual(await second.next(), { method: 'answered', params: {} });
  await second.close();
});

test('a second client is refused while the current one answers, and accepted once it is gone', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'yacwu-backend-daemon-'));
  const socketPath = join(dir, 'b.sock');
  const backend = "require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!==undefined)console.log(JSON.stringify({id:m.id,result:{}}))})";
  const { child, server } = runDaemon({ socketPath, command: [process.execPath, '-e', backend] });
  t.after(() => { child.removeAllListeners('exit'); child.kill(); server.close(); });
  await new Promise((resolve) => server.on('listening', resolve));

  const first = connectClient(socketPath);
  assert.match(await first.opened, / 101 /);
  first.send({ id: 1, method: 'initialize' });
  assert.deepEqual(await first.next(), { id: 1, result: {} });

  // Another server (a test copy, say) must not push the working one out.
  const intruder = connectClient(socketPath);
  assert.match(await intruder.opened, / 409 /);
  first.send({ id: 2, method: 'still-here' });
  assert.deepEqual(await first.next(), { id: 2, result: {} });

  // Once the first is gone, a newcomer gets in.
  await first.close();
  const next = connectClient(socketPath);
  assert.match(await next.opened, / 101 /);
  next.send({ id: 3, method: 'initialize' });
  assert.deepEqual(await next.next(), { id: 3, result: {} });
  await next.close();
  await intruder.close();
});

test('held messages are bounded, oldest notifications first, requests kept', () => {
  const held = createHeldMessages(3);
  held.hold('r1', true);
  for (const n of [1, 2, 3, 4]) held.hold(`n${n}`, false);
  assert.deepEqual(held.take(), ['r1', 'n3', 'n4']);
  assert.equal(held.size, 0);
  assert.equal(messageKind('{"id":1,"method":"x"}'), 'request');
  assert.equal(messageKind('{"method":"x"}'), 'notification');
  assert.equal(messageKind('{"id":1,"result":{}}'), 'response');
});

test('server frames carry their length correctly', () => {
  assert.deepEqual([...encodeFrame(1, Buffer.from('hi'))], [0x81, 2, 104, 105]);
  const medium = encodeFrame(1, Buffer.alloc(300));
  assert.deepEqual([...medium.subarray(0, 4)], [0x81, 126, 1, 44]);
  assert.equal(encodeFrame(2, Buffer.alloc(70000))[1], 127);
});
