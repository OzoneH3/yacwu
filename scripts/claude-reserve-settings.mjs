import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Read on each guard check so Settings changes apply without a new prompt.
 * Missing means this installation has not migrated its browser preference yet.
 * @param {string} [path]
 * @returns {number | null}
 */
export function readClaudeReserve(path = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'yacwu/claude-reserve.json')) {
 let text;
 try { text = readFileSync(path, 'utf8'); }
 catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null; throw error; }
 const { reserve } = JSON.parse(text);
 if (!Number.isInteger(reserve) || reserve < 0 || reserve > 50) throw new Error('Invalid Claude reserve setting');
 return reserve;
}
