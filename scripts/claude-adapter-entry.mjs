import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installClaudeBackgroundSupport } from './claude-background-runtime.mjs';
import { installClaudeReadOnlySupport } from './claude-readonly.mjs';
import { installThreadDelete } from './claude-thread-delete.mjs';

const adapterPath = process.argv[2];
const { NativeClaudeRuntime } = await import(pathToFileURL(join(dirname(adapterPath), 'native-runtime.mjs')).href);
installClaudeBackgroundSupport(NativeClaudeRuntime);
// The adapter can archive but not delete threads; Yacwu adds thread/delete.
const { CodexClaudeAppServer } = await import(pathToFileURL(join(dirname(adapterPath), 'server.mjs')).href);
installThreadDelete(CodexClaudeAppServer);
installClaudeReadOnlySupport(NativeClaudeRuntime, CodexClaudeAppServer);
// The adapter reads its CLI flags from argv[2..].
process.argv.splice(1, 2, adapterPath);
await import(pathToFileURL(adapterPath).href);
