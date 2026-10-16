import { readFileSync } from 'node:fs';
import { inspectInstallation } from './deployment.mjs';

try {
  const { machine, targets } = JSON.parse(readFileSync(0, 'utf8'));
  console.log(JSON.stringify(await inspectInstallation(machine, targets)));
} catch (error) {
  console.error(error?.code === 'ERR_ASSERTION' ? 'Installation validation failed.' : error.message);
  process.exitCode = 1;
}
