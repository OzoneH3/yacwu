import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** @param {string} path */
export function quotaResumeStore(path) {
  return {
    load() {
      try { const entries = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(entries) ? entries : []; }
      catch { return []; }
    },
    /** @param {any[]} entries */
    save(entries) {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true });
      if (!existsSync(`${directory}/.gitignore`)) writeFileSync(`${directory}/.gitignore`, '*\n');
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
      renameSync(temporary, path);
    }
  };
}
