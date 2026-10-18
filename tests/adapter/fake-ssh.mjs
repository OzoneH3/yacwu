#!/usr/bin/env node
// An offline SSH stand-in: askpass transport and remote key-edit scripts are
// real; no network, account password, live HOME or daemon is touched.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2), root = process.env.FAKE_SSH_ROOT;
appendFileSync(join(root, 'argv.jsonl'), JSON.stringify(args) + '\n');
const passwordMode = args.includes('-oBatchMode=no');
const ask = prompt => execFileSync(process.env.SSH_ASKPASS, [prompt], { env: process.env, encoding: 'utf8' });
if (passwordMode) {
 if (!existsSync(join(root, 'trusted'))) {
  const answer = ask('The host key fingerprint is SHA256:TESTFINGERPRINT. Are you sure you want to continue connecting (yes/no/[fingerprint])?');
  if (answer !== 'yes') process.exit(1);
  writeFileSync(join(root, 'trusted'), 'yes');
 }
 if (ask("test@host's password: ") !== 'test-password-value') process.exit(1);
} else {
 if (process.env.FAKE_REJECT_KEY === '1') process.exit(1);
 const key = args[args.indexOf('-i') + 1];
 let authorized = ''; try { authorized = readFileSync(join(root, 'remote/.ssh/authorized_keys'), 'utf8'); } catch {}
 if (!authorized.includes(readFileSync(key + '.pub', 'utf8').trim())) process.exit(1);
}
const result = spawnSync('sh', [], { input: readFileSync(0), env: { ...process.env, HOME: join(root, 'remote') }, encoding: 'utf8' });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
