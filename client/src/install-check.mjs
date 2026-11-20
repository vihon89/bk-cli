import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// No credential is forwarded and no tools/call is made by this verifier.
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('MUBAI_')) delete env[key];
let temporary;
let launcher;
if (process.argv.length === 4 && process.argv[2] === '--launcher' && path.isAbsolute(process.argv[3])) launcher = process.argv[3];
else if (process.argv.length > 2) throw new Error('Expected --launcher ABSOLUTE_PATH');
else {
  // Staging has no installed pointer yet: exercise the real launcher with an isolated layout.
  temporary = await mkdtemp(path.join(tmpdir(), 'bk-launcher-check-'));
  launcher = path.join(temporary, 'launch.mjs');
  await writeFile(launcher, await readFile(new URL('./launcher.mjs', import.meta.url)));
  await writeFile(path.join(temporary, 'current.json'), JSON.stringify({ schema: 1, version: '0.4.1' }));
  const directory = path.join(temporary, 'versions', '0.4.1', 'src'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'server.mjs'), `await import(${JSON.stringify(new URL('./server.mjs', import.meta.url).href)});`);
}
const transport = new StdioClientTransport({ command: process.execPath, args: [launcher], env, stderr: 'pipe' });
const client = new Client({ name: 'mubai-install-check', version: '0.4.1' });
const deadline = setTimeout(() => { process.stderr.write('MCP discovery timed out\n'); process.exit(1); }, 15000);
try {
  await client.connect(transport);
  const response = await client.listTools();
  const names = response.tools.map(tool => tool.name).sort();
  const expected = ['chat_reply', 'check_video_env', 'check_windows_credentials', 'create_batch', 'discover_skills', 'generate_image', 'generate_video', 'get_account', 'get_batch', 'get_motion_case', 'get_task', 'list_models', 'quote_generation', 'render_motion_case', 'report_motion_result', 'upload_asset', 'upload_video', 'wait_task'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('MCP tool catalog did not match the installed client');
  process.stdout.write(JSON.stringify({ status: 'ok', tools: names.length, launcher_verified: true, credentials: 'not-used', website_requests: 0 }) + '\n');
} finally { clearTimeout(deadline); await client.close(); if (temporary) await rm(temporary, { recursive: true, force: true }); }
