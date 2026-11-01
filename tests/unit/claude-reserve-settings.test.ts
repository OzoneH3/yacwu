import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeReserve } from '../../scripts/claude-reserve-settings.mjs';

test('shared reserve is reread from disk, including disabled value; invalid data does not fall back to 10', () => {
 const dir = mkdtempSync(join(tmpdir(), 'claude-reserve-'));
 const path = join(dir, 'reserve.json');
 try {
  expect(readClaudeReserve(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ reserve: 8 }));
  expect(readClaudeReserve(path)).toBe(8);
  writeFileSync(path, JSON.stringify({ reserve: 0 }));
  expect(readClaudeReserve(path)).toBe(0);
  writeFileSync(path, JSON.stringify({ reserve: 51 }));
  expect(() => readClaudeReserve(path)).toThrow();
  writeFileSync(path, '{broken');
  expect(() => readClaudeReserve(path)).toThrow();
 } finally { rmSync(dir, { recursive: true }); }
});
