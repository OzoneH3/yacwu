import { expect, test } from 'bun:test';
import { mcpActivityLabel, mcpActivityDetails } from '../../src/lib/mcp-activity';
import { compactActivity } from '../../src/lib/compact-activity';

test('Claude MCP calls describe tools and useful arguments rather than their protocol type', () => {
	const item = { id: 'read', type: 'mcpToolCall', server: 'claude-code', tool: 'Read', arguments: JSON.stringify({ file_path: '/project/README.md' }), result: { content: [{ type: 'text', text: 'File contents' }] } };
	expect(mcpActivityLabel(item)).toBe('claude-code · Read — /project/README.md');
	expect(mcpActivityDetails(item)).toContain('File contents');
	expect(mcpActivityLabel({ ...item, tool: 'Read /project/README.md' })).toBe('claude-code · Read /project/README.md');
	expect(mcpActivityLabel({ ...item, arguments: 'invalid JSON' })).toBe('claude-code · Read');
});

test('older MCP calls fold away but interactive questions and terminal MCP failures stay visible', () => {
	const items = [{ id: 'read', type: 'mcpToolCall', status: 'completed' }, { id: 'question', type: 'dynamicToolCall', tool: 'AskUserQuestion' }, { id: 'failed', type: 'mcpToolCall', status: 'failed' }];
	expect(compactActivity(items, () => false, false).map((item) => item.id)).toEqual(['activity-group:read', 'question', 'failed']);
});
