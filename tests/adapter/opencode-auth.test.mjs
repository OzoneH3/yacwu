import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openCodeAuthCommand} from '../../scripts/opencode-backend.mjs';

test('OpenCode login uses a private server instead of the global managed service port',()=>{
 assert.deepEqual(openCodeAuthCommand('/tools/opencode'),['/tools/opencode','auth','login','--standalone']);
});
