#!/usr/bin/env node
// ESM entry so `node desktop/launcher.js` works from the repo.
// The real implementation lives in launcher.cjs (CommonJS) because pkg — used to
// build desktop/WorkTracker.exe — cannot bundle an ESM entry point.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./launcher.cjs');
