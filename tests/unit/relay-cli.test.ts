import { describe, expect, test } from 'bun:test';
import { buildRequest, parseArgs, run, target } from '../../scripts/yacwu-relay.mjs';

const env = { YACWU_RELAY_URL: 'http://127.0.0.1:3000', YACWU_RELAY_AUTH_FILE: '/run/yacwu/relay.auth' };
const readFile = () => 'secret\n';
const noSleep = async () => {};

describe('yacwu-relay CLI', () => {
	test('parses flags and free text', () => {
		expect(parseArgs(['send', '--from', 'a', '--to', 'b', 'hello', 'there'])).toEqual({
			command: 'send', flags: { from: 'a', to: 'b' }, text: 'hello there'
		});
		expect(parseArgs(['send', '--to', 'b', '--', '--not-a-flag'])).toMatchObject({ text: '--not-a-flag' });
		expect(() => parseArgs(['send', '--to'])).toThrow('missing value');
	});

	test('send keeps a given id and generates one otherwise', () => {
		const given = buildRequest(parseArgs(['send', '--from', 'a', '--to', 'b', '--id', 'msg-123456', 'hi']));
		expect(given.body).toEqual({ id: 'msg-123456', from: 'a', to: 'b', text: 'hi' });
		const generated = buildRequest(parseArgs(['send', '--from', 'a', '--to', 'b', 'hi']));
		expect(generated.id).toMatch(/^rm-[0-9a-f]{24}$/);
		expect(() => buildRequest(parseArgs(['send', '--from', 'a', '--to', 'b']))).toThrow('text is required');
		expect(buildRequest(parseArgs(['send', '--from', 'a', '--to', 'b', '-']), 'from stdin').body).toMatchObject({ text: 'from stdin' });
	});

	test('read commands are plain GETs and never consume', () => {
		expect(buildRequest(parseArgs(['inbox', '--session', 's 1']))).toEqual({ method: 'GET', path: '/api/relay/inbox?session=s%201' });
		expect(buildRequest(parseArgs(['status', '--id', 'rm-1']))).toEqual({ method: 'GET', path: '/api/relay/message?id=rm-1' });
	});

	test('unix socket and tcp targets', () => {
		expect(target('unix:/run/yacwu.sock')).toEqual({ socketPath: '/run/yacwu.sock' });
		expect(target('http://127.0.0.1:3000')).toEqual({ hostname: '127.0.0.1', port: 3000 });
		expect(target('http://[::1]:3000')).toEqual({ hostname: '::1', port: 3000 });
	});

	test('retries after connection failures resend the same id', async () => {
		const seen: unknown[] = [];
		let calls = 0;
		const result = await run({
			argv: ['send', '--from', 'a', '--to', 'b', 'hi'], env, readFile, sleep: noSleep,
			send: async (_url, credential, req) => {
				expect(credential).toBe('secret');
				seen.push((req.body as { id: string }).id);
				calls += 1;
				if (calls < 3) throw new Error('ECONNRESET');
				return { status: 200, body: { duplicate: calls > 1, message: { state: 'queued' } } };
			}
		});
		expect(result.code).toBe(0);
		expect(new Set(seen).size).toBe(1);
		expect(seen.length).toBe(3);
	});

	test('reports the id to reuse when the relay stays unreachable', async () => {
		const result = await run({
			argv: ['send', '--from', 'a', '--to', 'b', 'hi'], env, readFile, sleep: noSleep,
			send: async () => { throw new Error('ECONNREFUSED'); }
		});
		expect(result.code).toBe(1);
		const output = result.output as { id: string; hint: string };
		expect(output.hint).toContain(`--id ${output.id}`);
	});

	test('HTTP refusals are not retried and exit 2', async () => {
		let calls = 0;
		const result = await run({
			argv: ['send', '--from', 'a', '--to', 'b', 'hi'], env, readFile, sleep: noSleep,
			send: async () => { calls += 1; return { status: 404, body: { error: 'unknown recipient session' } }; }
		});
		expect(calls).toBe(1);
		expect(result.code).toBe(2);
	});

	test('missing environment is explained', async () => {
		const result = await run({ argv: ['peers', '--session', 'a'], env: {}, readFile });
		expect(result.code).toBe(1);
		expect(JSON.stringify(result.output)).toContain('YACWU_RELAY_URL');
	});
});
