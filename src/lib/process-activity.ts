/** A process a session runs on this machine, as GET /api/threads/:id/processes lists it. */
export interface SessionProcess {
	pid: number;
	ppid: number;
	command: string;
	elapsedSeconds: number;
	cpuCentiseconds: number;
}

export interface ProcessSample {
	/** When it was taken (ms). */
	at: number;
	processes: SessionProcess[];
}

const program = (command: string) => (command.split(' ')[0] ?? '').split('/').pop() ?? '';
// The session's own Claude process and the shells that wrap its commands.
const isPlumbing = (command: string) =>
	program(command) === 'claude' || command.includes('claude-agent-sdk') || /shell-snapshots\//.test(command) || /^(\S*\/)?(ba)?sh -c /.test(command);

/**
 * What a session's processes are doing, from two samples: its busiest worker
 * processes with their CPU use, or that none is running. Null when the
 * session's processes are not tagged (a backend started before tagging), so
 * nothing is claimed.
 */
export function workerSummary(previous: ProcessSample | null, current: ProcessSample): string | null {
	if (current.processes.length === 0) return null;
	const workers = current.processes.filter((process) => !isPlumbing(process.command));
	if (workers.length === 0) return 'no worker process running';
	const seconds = previous ? (current.at - previous.at) / 1000 : 0;
	const cpu = (process: SessionProcess) => {
		const before = previous?.processes.find((other) => other.pid === process.pid);
		return before && seconds > 0 ? Math.max(0, (process.cpuCentiseconds - before.cpuCentiseconds) / seconds) : null;
	};
	const ranked = workers
		.map((process) => ({ process, cpu: cpu(process) }))
		.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || b.process.elapsedSeconds - a.process.elapsedSeconds);
	const shown = ranked.slice(0, 2).map(({ process, cpu }) => (cpu === null ? program(process.command) : `${program(process.command)} ${Math.round(cpu)}% CPU`));
	const more = ranked.length - shown.length;
	return `${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`;
}
