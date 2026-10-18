import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
test('CI exercises browser and built adapter integrations without model credentials', () => {
 const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
 expect(workflow).toContain('bun run test:adapter');
 expect(workflow).toContain('bunx playwright test');
 expect(workflow).toContain('fuergaosi233/claude-codex');
 expect(workflow).toContain('YACWU_PERSISTENT_BACKENDS:');
 expect(workflow).toContain('test -f claude-codex/dist/src/adapter.mjs');
});
