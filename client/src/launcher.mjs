// Stable installed entry point. Never writes credentials or operation state.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const current = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8'));
if (current.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(current.version)) throw new Error('Invalid installed runtime pointer');
await import(pathToFileURL(path.join(root, 'versions', current.version, 'src', 'server.mjs')).href);
