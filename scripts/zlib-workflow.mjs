#!/usr/bin/env node
// Stable Cloud entry: do not import workflow code before synchronization.
import { fileURLToPath } from 'node:url';
import { runSynchronized } from './zlib-sync.mjs';
await runSynchronized(fileURLToPath(new URL('../', import.meta.url)), process.argv.slice(2));
