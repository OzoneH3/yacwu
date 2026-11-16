/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { parseSlash } from '../../src/lib/slash';

test('/fast toggles Fast mode without arguments', () => {
	expect(parseSlash('/fast')).toEqual({ kind: 'fast' });
	expect(parseSlash('/FAST')).toEqual({ kind: 'fast' });
	expect(parseSlash('/fast on')).toEqual({ kind: 'unknown', command: '/fast' });
});

test('/model shows model choices without arguments', () => {
	expect(parseSlash('/model')).toEqual({ kind: 'model-show' });
});

test('/model accepts a model and optional effort', () => {
	expect(parseSlash('/model gpt-5.4')).toEqual({ kind: 'model-set', model: 'gpt-5.4' });
	expect(parseSlash('/model gpt-5.4 high')).toEqual({
		kind: 'model-set',
		model: 'gpt-5.4',
		effort: 'high'
	});
	expect(parseSlash('/model gpt-5.4 --effort HIGH')).toEqual({
		kind: 'model-set',
		model: 'gpt-5.4',
		effort: 'high'
	});
});

test('/model can change only the effort and rejects extra arguments', () => {
	expect(parseSlash('/model --effort xhigh')).toEqual({ kind: 'model-set', effort: 'xhigh' });
	expect(parseSlash('/model gpt-5.4 high extra')).toEqual({
		kind: 'unknown',
		command: '/model'
	});
});

test('/profile shows the current profile without arguments', () => {
	expect(parseSlash('/profile')).toEqual({ kind: 'profile-show' });
});

test('/profile selects a named profile', () => {
	expect(parseSlash('/profile fast')).toEqual({ kind: 'profile-set', profile: 'fast' });
	expect(parseSlash('/profile deep review')).toEqual({
		kind: 'profile-set',
		profile: 'deep review'
	});
});

test('/profile clear (or default) reverts to the base config', () => {
	expect(parseSlash('/profile clear')).toEqual({ kind: 'profile-clear' });
	expect(parseSlash('/profile DEFAULT')).toEqual({ kind: 'profile-clear' });
});

test('/todo queues a task, shows the queue, or clears pending tasks', () => {
	expect(parseSlash('/todo')).toEqual({ kind: 'todo-show' });
	expect(parseSlash('/todo clear')).toEqual({ kind: 'todo-clear' });
	expect(parseSlash('/todo fix session restore')).toEqual({ kind: 'todo-add', task: 'fix session restore' });
});

test('/btw starts an empty side conversation without arguments', () => {
	expect(parseSlash('/btw')).toEqual({ kind: 'btw' });
});

test('/btw carries the question as the first side-conversation message', () => {
	expect(parseSlash('/btw what does parseSlash do?')).toEqual({
		kind: 'btw',
		message: 'what does parseSlash do?'
	});
	expect(parseSlash('/side quick question')).toEqual({ kind: 'btw', message: 'quick question' });
});

test('SLASH_COMMANDS derives one popup entry per command with arg hints', async () => {
	const { SLASH_COMMANDS } = await import('../../src/lib/slash');
	const names = SLASH_COMMANDS.map((c) => c.name);
	expect(new Set(names).size).toBe(names.length);
	expect(names[0]).toBe('/status');
	const model = SLASH_COMMANDS.find((c) => c.name === '/model');
	expect(model?.args).toBe('<model> [effort]');
	expect(model?.description).toBe('show the current model and available choices');
	const goal = SLASH_COMMANDS.find((c) => c.name === '/goal');
	expect(goal?.args).toBe('<objective>');
});

test('filterSlashCommands lists all for an empty fragment and prefix-matches otherwise', async () => {
	const { SLASH_COMMANDS, filterSlashCommands } = await import('../../src/lib/slash');
	expect(filterSlashCommands('')).toEqual([...SLASH_COMMANDS]);
	expect(filterSlashCommands('mo').map((c) => c.name)).toEqual(['/model', '/mode']);
	expect(filterSlashCommands('f').map((c) => c.name)).toEqual(['/fast', '/fork']);
	expect(filterSlashCommands('FAST').map((c) => c.name)).toEqual(['/fast']);
	expect(filterSlashCommands('zzz')).toEqual([]);
});

test('read-only mode completion offers read-write access', async () => {
	const { filterSlashCommands } = await import('../../src/lib/slash');
	const mode = filterSlashCommands('mode', 'read-only').find((cmd) => cmd.name === '/mode');
	expect(mode?.args).toBe('rw');
	expect(mode?.completion).toBe('/mode rw');
	expect(mode?.description).toBe('set read-write file access');
	expect(filterSlashCommands('mode', 'read-write').find((cmd) => cmd.name === '/mode')?.completion).toBeUndefined();
});

test('/ctx-status is offered only to OpenCode sessions and takes no arguments', async () => {
	const { SLASH_COMMANDS, filterSlashCommands, parseSlash } = await import('../../src/lib/slash');
	expect(parseSlash('/ctx-status')).toEqual({ kind: 'ctx-status' });
	expect(parseSlash('/ctx-status now')).toEqual({ kind: 'unknown', command: '/ctx-status' });
	expect(parseSlash('/ctx')).toEqual({ kind: 'unknown', command: '/ctx' });

	expect(SLASH_COMMANDS.map((cmd) => cmd.name)).not.toContain('/ctx-status');
	expect(filterSlashCommands('ctx')).toEqual([]);
	expect(filterSlashCommands('ctx', undefined, true).map((cmd) => cmd.name)).toEqual(['/ctx-status']);
	const all = filterSlashCommands('', undefined, true).map((cmd) => cmd.name);
	expect(all.indexOf('/ctx-status')).toBe(all.indexOf('/compact') + 1);
	expect(filterSlashCommands('', 'read-only', true).map((cmd) => cmd.name)).toContain('/ctx-status');
});

test('help lists /ctx-status only for OpenCode sessions', async () => {
	const { SLASH_HELP, slashHelp } = await import('../../src/lib/slash');
	expect(SLASH_HELP).not.toContain('/ctx-status');
	expect(slashHelp()).toBe(SLASH_HELP);
	const opencode = slashHelp(true);
	expect(opencode).toContain('/ctx-status');
	expect(opencode.indexOf('/ctx-status')).toBeLessThan(opencode.indexOf('/help'));
	expect(opencode.trimEnd().endsWith('show this help')).toBe(true);
});

test('/fork accepts an optional provider without changing the native default', () => {
 expect(parseSlash('/fork')).toEqual({kind:'fork'});
 expect(parseSlash('/fork OpenCode')).toEqual({kind:'fork',provider:'opencode'});
 expect(parseSlash('/fork claude')).toEqual({kind:'fork',provider:'claude'});
 expect(parseSlash('/fork codex')).toEqual({kind:'fork',provider:'codex'});
 expect(parseSlash('/fork copilot')).toEqual({kind:'fork',provider:'copilot'});
 expect(parseSlash('/fork opencode extra')).toEqual({kind:'unknown',command:'/fork'});
});
