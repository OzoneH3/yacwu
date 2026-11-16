/// <reference types="bun" />
import { expect, test } from 'bun:test';
import {
	formatMagicContextStatus,
	magicContextStatusFromReply,
	magicContextWarnings,
	type MagicContextStatus
} from '../../src/lib/magic-context-status';

const live: MagicContextStatus = {
	usagePercentage: 49.62023809523809,
	inputTokens: 83362,
	contextLimit: 168000,
	cacheTtl: '5m',
	compaction_enabled: true,
	executeThreshold: 65,
	compartmentCount: 0,
	historianRunning: false,
	compartmentInProgress: false,
	memoryCount: 0,
	sessionNoteCount: 0,
	embedding: { state: 'off' },
	tailHygiene: { reclaimableToolOutputCount: 47, u: 66961 },
	pluginVersion: '0.49.56'
};

test('Magic Context status renders the plugin summary fields', () => {
	const text = formatMagicContextStatus(live);
	expect(text.split('\n')[0]).toBe('Magic Context Status');
	expect(text).toContain('Context: 49.6% of usable context (83,362 / 168,000 tokens)');
	expect(text).toContain('Cache lifetime: 5m');
	expect(text).toContain('Automatic compression: at 65.0% of usable context');
	expect(text).toContain('History compression: Waiting for enough conversation history');
	expect(text).toContain('Reclaimable: 47 spent tool outputs (~67k tokens)');
	expect(text).toContain('Memory: 0 memories · 0 notes');
	expect(text).toContain('Search indexing: Off');
	expect(text).toContain('Plugin: 0.49.56');
	expect(text).not.toContain('Warning:');
});

test('Magic Context status distinguishes compression states', () => {
	const off = formatMagicContextStatus({ ...live, compaction_enabled: false });
	expect(off).toContain('Automatic compression: Off');
	expect(off).toContain('History compression: Off');

	const ready = formatMagicContextStatus({ ...live, compartmentCount: 3 });
	expect(ready).toContain('History compression: Ready · 3 history blocks');

	const compressing = formatMagicContextStatus({
		...live,
		compartmentCount: 1,
		compartmentInProgress: true
	});
	expect(compressing).toContain('History compression: Compressing history · 1 history block');
});

test('Magic Context status names indexing coverage and singular reclaimables', () => {
	const text = formatMagicContextStatus({
		...live,
		tailHygiene: { reclaimableToolOutputCount: 1, u: 2048 },
		embedding: { state: 'paused', indexed: 1200, total: 3400 }
	});
	expect(text).toContain('Reclaimable: 1 spent tool output (~2k tokens)');
	expect(text).toContain('Search indexing: Paused · 1,200 / 3,400 history blocks indexed');
});

test('Magic Context status reports an unknown context window without inventing one', () => {
	const text = formatMagicContextStatus({ ...live, contextLimit: 0 });
	expect(text).toContain('Context: 49.6% of usable context (83,362 tokens)');
});

test('Magic Context warnings follow the plugin order and deduplicate host limitations', () => {
	const warnings = magicContextWarnings({
		...live,
		lastTransformError: 'boom',
		historianFailureCount: 2,
		configParseFailures: ['bad'],
		embedding: { state: 'stopped' },
		memoryMirror: { stalled: true },
		memoryAuthorityMismatch: true,
		hostLimitations: ['transform_update_failed', 'imageless_host'],
		hiddenVariantWarnings: ['variant dropped']
	});
	expect(warnings).toEqual([
		'transform_update_failed',
		'historian_unavailable',
		'configuration_warning',
		'embedding_unavailable',
		'memory_mirror_stalled',
		'memory_authority_mismatch',
		'imageless_host'
	]);
	const text = formatMagicContextStatus({
		...live,
		lastTransformError: 'boom',
		hostLimitations: ['imageless_host'],
		hiddenVariantWarnings: ['variant dropped']
	});
	expect(text).toContain('Warning: The last context update failed; the next message retries it.');
	expect(text).toContain('Warning: imageless_host');
	expect(text).toContain('Warning: variant dropped');
});

test('Magic Context status accepts the wrapped route body and a bare plugin payload', () => {
	expect(magicContextStatusFromReply({ status: live })?.usagePercentage).toBe(49.62023809523809);
	expect(magicContextStatusFromReply(live)?.inputTokens).toBe(83362);
	expect(magicContextStatusFromReply({ error: 'unavailable' })).toBeNull();
	expect(magicContextStatusFromReply(null)).toBeNull();
	expect(magicContextStatusFromReply({ status: [] })).toBeNull();
});
