// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptDir = import.meta.dirname;
const appDir = resolve(scriptDir, '..');

const requiredArtifacts = [
	resolve(appDir, 'pkgs/libfluxcore/libfluxcore_bg.wasm'),
	resolve(appDir, 'pkgs/libfluxwebp/libfluxwebp_bg.wasm'),
	resolve(appDir, 'pkgs/libfluxwebp/libfluxwebp_simd_bg.wasm'),
	resolve(appDir, 'src/features/messaging/utils/markdown/parser/MarkdownParserWasmBytes.ts'),
];

const allExist = requiredArtifacts.every((file) => existsSync(file));

if (allExist) {
	console.log('[wasm] Reusing committed wasm artifacts.');
	process.exit(0);
}

console.log('[wasm] Missing wasm artifacts, attempting compilation...');
const result = spawnSync('../tools/ci/run.sh', ['build-app-wasm'], {
	cwd: appDir,
	stdio: 'inherit',
	shell: true,
});

process.exit(result.status ?? 1);
