// Session relay: browser-side state and transcript attribution.
//
// The server is the only authority on who sent a relayed message and what
// happened to it. A relayed block in a transcript gets a sender label only
// when it matches a delivery record from the server — same recipient, same
// acknowledged turn, same id, same sender and identical text. Everything
// else (no record after a restart, an uncertain delivery, malformed or
// user-typed lookalikes) is shown verbatim as ordinary user text.

export interface RelayAddress {
	host: string;
	thread: string;
}

export type RelayState = 'queued' | 'sending' | 'accepted' | 'uncertain' | 'rejected';

export interface RelayRecord {
	id: string;
	from: RelayAddress;
	to: RelayAddress;
	text: string;
	state: RelayState;
	reason: string;
	submission: string;
	turnId: string;
	createdAt: number;
	version: number;
	/** What an acknowledgement means for the recipient's backend. */
	ack: 'backend' | 'adapterRecorded';
}

export interface RelayStore {
	epoch: string | null;
	/** Sequence number at which `epoch` was adopted. */
	epochSeq: number;
	records: Record<string, RelayRecord>;
}

export function emptyRelayStore(): RelayStore {
	return { epoch: null, epochSeq: 0, records: {} };
}

function mergeRecords(records: Record<string, RelayRecord>, incoming: RelayRecord[]): Record<string, RelayRecord> {
	const next = { ...records };
	for (const record of incoming) {
		const current = next[record.id];
		if (!current || record.version > current.version) next[record.id] = record;
	}
	return next;
}

/**
 * A live update from the current event stream. Events are always current:
 * a new epoch means the server restarted, so everything known before is
 * dropped. `seq` is the caller's next sequence number.
 */
export function applyRelayEvent(store: RelayStore, epoch: string, record: RelayRecord, seq: number): RelayStore {
	if (store.epoch === epoch) return { ...store, records: mergeRecords(store.records, [record]) };
	return { epoch, epochSeq: seq, records: mergeRecords({}, [record]) };
}

/**
 * A snapshot answering a request issued at `requestSeq`. Same epoch: merge,
 * keeping newer versions. Different epoch: adopt it only if no epoch was
 * adopted after the request was issued — otherwise the snapshot is from a
 * server generation we already moved past and is dropped.
 */
export function applyRelaySnapshot(
	store: RelayStore,
	snapshot: { epoch: string; messages: RelayRecord[] },
	requestSeq: number,
	seq: number
): RelayStore {
	if (store.epoch === snapshot.epoch) return { ...store, records: mergeRecords(store.records, snapshot.messages) };
	if (store.epoch !== null && store.epochSeq > requestSeq) return store;
	return { epoch: snapshot.epoch, epochSeq: seq, records: mergeRecords({}, snapshot.messages) };
}

export interface RelayFrame {
	id: string;
	fromThread: string;
	fromHost: string;
	body: string;
}

const HEADER = /^\[Yacwu relay: [^\n]*\]$/;
const OPEN = /^\[Yacwu relay message ([A-Za-z0-9_-]{6,80}) from session (\S+) on (\S+)\]$/;

/**
 * Parse an input part that consists entirely of a relay block, as the
 * server writes it. Anything else returns null.
 */
export function parseRelayBlock(text: string): RelayFrame[] | null {
	const lines = text.replace(/\s+$/, '').split('\n');
	if (!HEADER.test(lines[0] ?? '')) return null;
	const frames: RelayFrame[] = [];
	let index = 1;
	while (index < lines.length) {
		const open = OPEN.exec(lines[index]);
		if (!open) return null;
		const [, id, fromThread, fromHost] = open;
		const close = `[/Yacwu relay message ${id}]`;
		const end = lines.indexOf(close, index + 1);
		if (end < 0) return null;
		frames.push({ id, fromThread, fromHost, body: lines.slice(index + 1, end).join('\n') });
		index = end + 1;
	}
	return frames.length ? frames : null;
}

export interface AttributedFrame extends RelayFrame {
	record: RelayRecord;
}

/**
 * Attribute a transcript input part to server delivery records. Every frame
 * must match a record for this recipient, delivered into this very turn,
 * from the sender the frame names, with identical text, all from one
 * submission. Otherwise null, and the part is shown as written.
 */
export function attributeRelayPart(
	text: string,
	context: { threadId: string; turnId: string | null | undefined },
	records: Record<string, RelayRecord>
): AttributedFrame[] | null {
	const frames = parseRelayBlock(text);
	if (!frames || !context.turnId) return null;
	const attributed: AttributedFrame[] = [];
	let submission: string | null = null;
	for (const frame of frames) {
		const record = records[frame.id];
		if (
			!record ||
			record.state !== 'accepted' ||
			record.to.thread !== context.threadId ||
			record.turnId !== context.turnId ||
			record.from.thread !== frame.fromThread ||
			record.from.host !== frame.fromHost ||
			record.text !== frame.body ||
			(submission !== null && record.submission !== submission)
		) {
			return null;
		}
		submission = record.submission;
		attributed.push({ ...frame, record });
	}
	return attributed;
}

/** User-facing status. Acknowledgement is never described as receipt. */
export function relayStatusLabel(record: RelayRecord): string {
	switch (record.state) {
		case 'queued':
			return 'Queued in server memory until the recipient starts or continues a turn (lost if the server restarts)';
		case 'sending':
			return 'Sending';
		case 'accepted':
			return record.ack === 'adapterRecorded'
				? 'Recorded by the Claude adapter on the recipient’s turn; the adapter may not forward it to the running model'
				: 'Accepted by the recipient’s backend; this does not confirm the model has read it';
		case 'uncertain':
			return `Outcome unknown: the backend may have accepted it, so it is not retried automatically${record.reason ? ` (${record.reason})` : ''}`;
		case 'rejected':
			return `Not delivered: ${record.reason || 'refused'}`;
	}
}

export function shortSession(id: string): string {
	return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}
