import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith('--')) args.set(key, process.argv[i + 1] ?? '');
}
const actorId = args.get('--actor');
const reservationId = args.get('--reservation');
const candidateFile = args.get('--candidate-file');
const operatorId = args.get('--operator') || 'local-operator';
const apply = args.has('--apply');
const inspect = args.has('--inspect');
if (!actorId || !/^[0-9a-f-]{36}$/iu.test(actorId) || (!inspect && (!reservationId || !candidateFile || !/^[0-9a-f-]{36}$/iu.test(reservationId)))) {
  console.error('Usage: node scripts/staging-operator-reconcile.mjs --actor <uuid> --inspect [--operator <id>]');
  console.error('   or: node scripts/staging-operator-reconcile.mjs --actor <uuid> --reservation <uuid> --candidate-file <json> [--operator <id>] [--apply]');
  process.exit(2);
}
const candidate = inspect ? undefined : JSON.parse(readFileSync(candidateFile, 'utf8'));
const nonce = randomBytes(32).toString('hex');
const port = 8799;
const logFile = join(process.env.TEMP || '.', 'heisei-operator-local.log');
const wrangler = join(root, 'apps', 'api', 'node_modules', '.bin', 'wrangler.cmd');
const wranglerArgs = ['dev', '--remote', '--config', 'wrangler.operator.local.jsonc', '--ip', '127.0.0.1', '--port', String(port), '--log-level', 'error', '--var', `HEISEI_OPERATOR_NONCE:${nonce}`];
const commandLine = [`"${wrangler}"`, ...wranglerArgs.map((value) => `"${value.replaceAll('"', '\\"')}"`)].join(' ');
const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], { cwd: join(root, 'apps', 'api'), windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
const stop = () => { if (!child.killed) child.kill(); };
process.on('exit', stop);
try {
  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.status !== 404) { ready = true; break; } } catch { /* startup wait */ }
  }
  if (!ready) throw new Error('operator worker did not start; inspect the local Wrangler log');
  const response = await fetch(`http://127.0.0.1:${port}/operator/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-heisei-operator-nonce': nonce, 'x-heisei-operator-id': operatorId }, body: JSON.stringify(inspect ? { mode: 'inspect', actorId } : { actorId, reservationId, candidates: Array.isArray(candidate) ? candidate : [candidate], dryRun: !apply }) });
  console.log(`HTTP ${response.status}`);
  console.log(await response.text());
} finally {
  stop();
  try { unlinkSync(logFile); } catch { /* no log was created */ }
}
