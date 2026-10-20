import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(t, mode = 'success', env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-switch-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'bin'));
  copyFileSync(new URL('../scripts/host-switch.sh', import.meta.url), join(dir, 'scripts/host-switch.sh'));
  const executable = (name, body) => writeFileSync(join(dir, 'bin', name), '#!/usr/bin/env bash\n' + body, { mode: 0o755 });
  executable('systemctl', `
 echo "$*" >> "$FIXTURE/events"
 case "$2" in
   stop) [[ $MODE != stop-fail ]] ;;
   start) [[ $MODE != start-fail ]] ;;
   is-active) exit 0 ;;
 esac
`);
  executable('curl', '[[ $1 == --noproxy && $2 == "*" ]] || exit 8; if [[ $MODE == unhealthy ]] && ! test -e "$FIXTURE/rollback-argv"; then echo 503; else echo 200; fi\n');
  executable('node', `
 echo "$2" >> "$FIXTURE/events"
 [[ $CI == true ]] || { echo "non-interactive install requires CI=true" >&2; exit 8; }
 hang() {
   bash -c 'trap "" TERM; echo "$BASHPID" > "$FIXTURE/descendant"; while :; do sleep 1; done' &
   [[ $MODE == apply-orphan-timeout ]] || trap '' TERM
   wait
 }
 if [[ $2 == update ]]; then
   if [[ $MODE == gated ]]; then
     echo '[apply] progress before completion' >&2
     while [[ ! -e $FIXTURE/release ]]; do sleep 0.02; done
   fi
   case "$MODE" in
     no-backup) echo 'preflight failed' >&2; exit 3 ;;
     retained) echo "error; backup retained: $FIXTURE/backup with spaces. Installation may have changed; Host was not started or stopped." >&2; exit 4 ;;
     apply-timeout|apply-orphan-timeout) echo "[apply] backup ready: $FIXTURE/backup with spaces" >&2; hang ;;
     rollback-timeout|rollback-fail|start-fail) echo "[apply] backup ready: $FIXTURE/backup with spaces" >&2; exit 4 ;;
     *) printf '{\n  "backup": "%s/backup with spaces"\n}\n' "$FIXTURE" ;;
   esac
 else
   printf '%s\n' "$@" > "$FIXTURE/rollback-argv"
   [[ $MODE != rollback-timeout ]] || hang
   [[ $MODE != rollback-fail ]] || exit 9
 fi
`);
  const child = spawn('bash', [join(dir, 'scripts/host-switch.sh'), 'fixture'], {
    detached: true,
    env: { ...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH,
      FIXTURE: dir, MODE: mode, DSH_HEALTH_TIMEOUT: '1', DSH_APPLY_TIMEOUT: '2', DSH_ROLLBACK_TIMEOUT: '2', ...env },
  });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  t.after(kill);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    // The apply cannot finish until progress reaches the caller (no timing-only assertion).
    if (mode === 'gated' && stderr.includes('progress before completion')) writeFileSync(join(dir, 'release'), '');
  });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { kill(); reject(new Error('switch did not finish within test deadline')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  return { dir, result, events: () => existsSync(join(dir, 'events')) ? readFileSync(join(dir, 'events'), 'utf8').trim().split('\n') : [] };
}

for (const mode of ['success', 'gated']) {
  test(mode + ': streams apply output and starts the Host', async t => {
    const f = fixture(t, mode);
    const result = await f.result;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /"backup"/);
    assert.deepEqual(f.events(), ['--user stop dsh-web.service', 'update', '--user start dsh-web.service', '--user is-active --quiet dsh-web.service']);
  });
}

test('stop failure never applies or restarts', async t => {
  const f = fixture(t, 'stop-fail');
  assert.equal((await f.result).code, 1);
  assert.deepEqual(f.events(), ['--user stop dsh-web.service']);
});

test('invalid deadlines fail before stopping the Host', async t => {
  const f = fixture(t, 'success', { DSH_APPLY_TIMEOUT: '0' });
  assert.equal((await f.result).code, 1);
  assert.deepEqual(f.events(), []);
});

for (const mode of ['retained', 'unhealthy', 'rollback-fail', 'no-backup', 'start-fail', 'apply-timeout', 'apply-orphan-timeout', 'rollback-timeout']) {
  test(mode + ': recovers or reports incomplete restoration honestly', async t => {
    const f = fixture(t, mode);
    const result = await f.result;
    assert.equal(result.code, 1);
    const output = result.stdout + result.stderr;
    assert.ok(f.events().includes('--user start dsh-web.service'));
    if (mode === 'no-backup') {
      assert.ok(!f.events().includes('rollback'));
      assert.doesNotMatch(output, /previous installation restored/);
    } else {
      assert.ok(f.events().includes('rollback'));
      assert.ok(readFileSync(join(f.dir, 'rollback-argv'), 'utf8').endsWith(f.dir + '/backup with spaces\n'));
      if (mode === 'retained' || mode === 'unhealthy' || mode === 'apply-timeout' || mode === 'apply-orphan-timeout') assert.match(output, /previous installation restored and answering/);
      else assert.doesNotMatch(output, /previous installation restored/);
    }
    if (mode.endsWith('timeout')) {
      const pid = Number(readFileSync(join(f.dir, 'descendant'), 'utf8'));
      // Reparented zombies may await init reaping, but must not remain running after recovery.
      const stat = '/proc/' + pid + '/stat';
      assert.ok(!existsSync(stat) || /\) Z /.test(readFileSync(stat, 'utf8')), 'installer descendant survived its process-group timeout');
    }
  });
}
