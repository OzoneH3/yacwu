import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installClaudeBackgroundSupport } from './claude-background-runtime.mjs';

const adapterPath = process.argv[2];
const { NativeClaudeRuntime } = await import(pathToFileURL(join(dirname(adapterPath), 'native-runtime.mjs')).href);
installClaudeBackgroundSupport(NativeClaudeRuntime);
// The adapter reads its CLI flags from argv[2..].
process.argv.splice(1, 2, adapterPath);
await import(pathToFileURL(adapterPath).href);
