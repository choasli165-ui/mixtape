import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Windows shells do not expand wildcards for Node.js 20's test runner.
const directory = fileURLToPath(new URL('../test/', import.meta.url));
const files = readdirSync(directory).filter((name) => name.endsWith('.test.js')).sort();
if (!files.length) throw new Error('No test files found');
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files.map((name) => join(directory, name))], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
