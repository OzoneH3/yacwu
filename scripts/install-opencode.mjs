// Installs only in this project's ignored workspace. Does not start/restart backends.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPENCODE_VERSION, MAGIC_CONTEXT_VERSION, runtimeRoot, prepareEnvironment } from './opencode-backend.mjs';
const root=runtimeRoot;
mkdirSync(join(root,'tools'),{recursive:true});
writeFileSync(join(root,'tools/package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@opencode/cli':OPENCODE_VERSION,'@cortexkit/opencode-magic-context':MAGIC_CONTEXT_VERSION}},null,2));
const installed=spawnSync('npm',['install','--prefix',join(root,'tools'),'--cache',join(root,'npm-cache'),'--no-audit','--no-fund'],{stdio:'inherit'});
if(installed.status !== 0)process.exit(installed.status || 1);
// npm versions that block dependency scripts still install the platform package.
// OpenCode's reviewed installer copies that binary into its declared bin path.
const postinstall=spawnSync(process.execPath,[join(root,'tools/node_modules/@opencode/cli/postinstall.mjs')],{env:{...process.env,npm_config_cache:join(root,'npm-cache')},stdio:'inherit'});
if(postinstall.status !== 0)process.exit(postinstall.status || 1);
prepareEnvironment(root);
writeFileSync(join(root,'enabled'),'1\n');
console.log('Installed pinned OpenCode + Magic Context. Authenticate: node scripts/opencode-backend.mjs auth');
console.log('Add opencode=node ./scripts/opencode-backend.mjs to YACWU_BACKENDS, preserving existing entries.');
