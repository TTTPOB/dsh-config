import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test('standalone plugins rebuild offline from public sources without helper catalogs or Word skill files', async () => {
  await execute(process.execPath, [fileURLToPath(new URL('../scripts/check-plugin-builds.mjs', import.meta.url))]);
});
