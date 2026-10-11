// Short notification sounds, synthesized with Web Audio (no audio files).
// Kept quiet and soft on purpose: two gentle notes each, no percussion.

export type SoundKind = 'finish' | 'question' | 'error';

interface Note { frequency: number; at: number; length: number }

/** Finished: a rising fourth. Question: a lighter rising fourth, higher up. Error: a soft falling third. */
export const SOUND_NOTES: Record<SoundKind, { wave: OscillatorType; volume: number; notes: Note[] }> = {
	finish: { wave: 'sine', volume: 0.12, notes: [{ frequency: 659.25, at: 0, length: 0.22 }, { frequency: 880, at: 0.13, length: 0.34 }] },
	question: { wave: 'triangle', volume: 0.09, notes: [{ frequency: 783.99, at: 0, length: 0.16 }, { frequency: 1046.5, at: 0.15, length: 0.26 }] },
	error: { wave: 'sine', volume: 0.1, notes: [{ frequency: 440, at: 0, length: 0.24 }, { frequency: 349.23, at: 0.2, length: 0.38 }] }
};

/** Volume setting (0–100) as a gain multiplier; 25 is the original level. */
export function volumeGain(volume: number): number {
	return Math.max(0, Math.min(100, volume)) / 25;
}

/** One sound per session at a time: a question or error just played covers its "finished". */
export const SESSION_COOLDOWN_MS = 2500;

type Signal = Exclude<SoundKind, 'finish'> | null;

/**
 * Sounds for sessions whose question or error signal just appeared. Only
 * live sessions count: a signal that shows up because history loaded must
 * stay silent.
 */
export function signalSounds(
	previous: Record<string, Signal>,
	next: Record<string, Signal>,
	isLive: (sessionId: string) => boolean
): Array<[string, SoundKind]> {
	return Object.entries(next).flatMap(([sessionId, signal]) =>
		signal && previous[sessionId] !== signal && isLive(sessionId) ? [[sessionId, signal] as [string, SoundKind]] : []
	);
}

export function createSoundPlayer(createContext: () => AudioContext | null = () => (typeof AudioContext === 'undefined' ? null : new AudioContext())) {
	let context: AudioContext | null = null;
	const lastBySession = new Map<string, number>();
	const audio = () => (context ??= createContext());
	function render(kind: SoundKind, gain: number) {
		const ctx = audio();
		if (!ctx || ctx.state !== 'running' || gain <= 0) return;
		const { wave, volume, notes } = SOUND_NOTES[kind];
		for (const note of notes) {
			const start = ctx.currentTime + note.at;
			const oscillator = ctx.createOscillator();
			const envelope = ctx.createGain();
			oscillator.type = wave;
			oscillator.frequency.value = note.frequency;
			// Soft attack and a smooth exponential fade: no clicks.
			envelope.gain.setValueAtTime(0.0001, start);
			envelope.gain.exponentialRampToValueAtTime(volume * gain, start + 0.015);
			envelope.gain.exponentialRampToValueAtTime(0.0001, start + note.length);
			oscillator.connect(envelope).connect(ctx.destination);
			oscillator.start(start);
			oscillator.stop(start + note.length + 0.02);
		}
	}
	return {
		/** Browsers start audio suspended until the user interacts with the page. */
		unlock() {
			const ctx = audio();
			if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
		},
		/** Play unless this session made a sound moments ago; returns whether it played. */
		play(kind: SoundKind, sessionId: string, now = Date.now(), volume = 25): boolean {
			const last = lastBySession.get(sessionId);
			if (last !== undefined && now - last < SESSION_COOLDOWN_MS) return false;
			lastBySession.set(sessionId, now);
			render(kind, volumeGain(volume));
			return true;
		},
		/** Try a volume from Settings, outside any session's cooldown. */
		preview(volume: number, kind: SoundKind = 'finish') {
			render(kind, volumeGain(volume));
		}
	};
}
