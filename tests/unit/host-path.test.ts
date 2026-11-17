import { expect, test } from 'bun:test';
import { normalizeHostPath, parentHostPath, isWindowsPath } from '../../src/lib/host-path';
import { sessionWorkspace, withSharedChannelContext } from '../../src/lib/shared-channel';
import { parseCodexMarkdown } from '../../src/lib/markdown';

test('drive and UNC roots survive normalization and parent navigation', () => {
  expect(normalizeHostPath('C:\\')).toBe('C:/');
  expect(parentHostPath('C:\\Users')).toBe('C:/');
  expect(parentHostPath('C:/')).toBe('C:/');
  expect(normalizeHostPath('\\\\server\\share\\My project\\')).toBe('//server/share/My project');
  expect(parentHostPath('\\\\server\\share')).toBe('//server/share');
  expect(parentHostPath('//server/share/project')).toBe('//server/share');
  expect(isWindowsPath('C:relative')).toBe(false);
  expect(parentHostPath('/home/user')).toBe('/home');
});
test('workspace instructions preserve network shares and use PowerShell environment syntax', () => {
  expect(sessionWorkspace('C:\\')).toBe('C:/.workspace');
  expect(sessionWorkspace('\\\\server\\share')).toBe('//server/share/.workspace');
  expect(withSharedChannelContext('work', 'C:/project/.workspace/coordination', 'id')).toContain('$env:YACWU_RELAY_CLI');
  expect(withSharedChannelContext('work', '/work/.workspace/coordination', 'id')).toContain('"$YACWU_RELAY_CLI"');
});
test('Windows markdown file links are not dropped as unknown URL schemes', () => {
  expect(JSON.stringify(parseCodexMarkdown('[file](<C:/My project/日本.txt:5>)'))).toContain('C:/My project/日本.txt:5');
});
