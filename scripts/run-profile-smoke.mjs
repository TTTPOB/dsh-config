#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.ok(Array.isArray(argv) && argv.length > 2 && argv.every(value => typeof value === 'string'));
const result = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
