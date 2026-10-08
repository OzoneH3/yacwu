import { expect, test } from 'bun:test';
import { runtimeOutcome, interruptionReason } from '../../src/lib/runtime-reconciliation';

test('interruption reason uses the latest backend error and does not invent restart causes', () => {
	expect(interruptionReason({ turns: [{ id: 'old', status: 'failed', error: { message: 'old failure' } }, { id: 'new', status: 'interrupted', error: { message: 'server restarted before completing turn' } }] }, true)).toBe('server restarted before completing turn');
	expect(interruptionReason({}, true)).toContain('supplied no reason');
	expect(interruptionReason({}, false)).toContain('no longer loaded');
});

test('loaded idle Claude thread with a restart-interrupted turn needs recovery', () => {
	expect(runtimeOutcome({ status: { type: 'idle' }, turns: [{ id: 'old', status: 'interrupted', error: { message: 'server restarted before completing turn' } }] })).toBe('interrupted');
});

test('active reasoning is not a stall and normal completion is not an interruption', () => {
	expect(runtimeOutcome({ status: { type: 'active' }, turns: [{ id: 'old', status: 'interrupted' }, { id: 'new', status: 'inProgress' }] })).toBe('running');
	expect(runtimeOutcome({ status: { type: 'idle' }, turns: [{ id: 'done', status: 'completed' }] })).toBe('idle');
	expect(runtimeOutcome({})).toBe('unknown');
});
