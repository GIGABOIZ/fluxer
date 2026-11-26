// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptDir = import.meta.dirname;
const appDir = resolve(scriptDir, '..');

const MINIMAL_WASM_BYTES = Buffer.from('AGFzbQEAAAA=', 'base64');

const FALLBACK_ARTIFACTS = new Map([
	['pkgs/libfluxcore/libfluxcore_bg.wasm', MINIMAL_WASM_BYTES],
	['pkgs/libfluxwebp/libfluxwebp_bg.wasm', MINIMAL_WASM_BYTES],
	['pkgs/libfluxwebp/libfluxwebp_simd_bg.wasm', MINIMAL_WASM_BYTES],
	[
		'pkgs/libfluxcore/libfluxcore.js',
		`// SPDX-License-Identifier: AGPL-3.0-or-later

const memory = new WebAssembly.Memory({initial: 256, maximum: 1024});

export default async function initLibfluxcore(options) {
	return {
		memory,
		crop_rotate_rgba_into_buffer,
		create_zstd_stream_decoder,
		free_zstd_stream_decoder,
		decompress_zstd_stream_chunk,
		create_zstd_stream_encoder,
		free_zstd_stream_encoder,
		compress_zstd_stream_chunk,
		is_animated_image,
		sniff_image_format,
		__resetLibfluxcoreWasmForMemoryPressure,
	};
}

export {memory};
export function crop_rotate_rgba_into_buffer(input, output, src_w, src_h, x, y, w, h, rot, out_w, out_h) {}
export function create_zstd_stream_decoder() { return 1; }
export function free_zstd_stream_decoder(decoder_ptr) {}
export function decompress_zstd_stream_chunk(decoder_ptr, input) { return input; }
export function create_zstd_stream_encoder(level) { return 1; }
export function free_zstd_stream_encoder(encoder_ptr) {}
export function compress_zstd_stream_chunk(encoder_ptr, input) { return input; }
export function is_animated_image(input) { return false; }
export function sniff_image_format(input) { return 0; }
export function __resetLibfluxcoreWasmForMemoryPressure() {}
`,
	],
	[
		'pkgs/libfluxcore/libfluxcore.d.ts',
		`// SPDX-License-Identifier: AGPL-3.0-or-later

export interface InitOutput {
	readonly memory: WebAssembly.Memory;
	[key: string]: unknown;
}

export default function initLibfluxcore(options?: unknown): Promise<InitOutput>;
export function __resetLibfluxcoreWasmForMemoryPressure(): void;
export function crop_rotate_rgba_into_buffer(
	input: Uint8Array,
	output: Uint8Array,
	src_width: number,
	src_height: number,
	x: number,
	y: number,
	width: number,
	height: number,
	rotation_deg: number,
	output_width: number,
	output_height: number,
): void;
export function create_zstd_stream_decoder(): number;
export function free_zstd_stream_decoder(decoder_ptr: number): void;
export function decompress_zstd_stream_chunk(decoder_ptr: number, input: Uint8Array): Uint8Array;
export function create_zstd_stream_encoder(level: number): number;
export function free_zstd_stream_encoder(encoder_ptr: number): void;
export function compress_zstd_stream_chunk(encoder_ptr: number, input: Uint8Array): Uint8Array;
export function is_animated_image(input: Uint8Array): boolean;
export function sniff_image_format(input: Uint8Array): number;
`,
	],
	[
		'pkgs/libfluxwebp/libfluxwebp.js',
		`// SPDX-License-Identifier: AGPL-3.0-or-later

const memory = new WebAssembly.Memory({initial: 256, maximum: 1024});

export default async function initLibWebp(options) {
	return {
		memory,
		webp_probe,
		AnimDecoder,
		AnimEncoder,
	};
}

export {memory};
export function webp_probe(bytes) { return [0, 0, 0, 0, 0, 0]; }

export class AnimDecoder {
	constructor(bytes) {}
	next() { return false; }
	get frame_ptr() { return 0; }
	get end_timestamp() { return 0; }
	free() {}
}

export class AnimEncoder {
	constructor(width, height, loop_count, lossless) {}
	add(rgba, start_ms, quality, method) {}
	finish(end_ms) { return new Uint8Array(); }
	free() {}
}
`,
	],
	[
		'pkgs/libfluxwebp/libfluxwebp.d.ts',
		`// SPDX-License-Identifier: AGPL-3.0-or-later

export interface WebpInitOutput {
	readonly memory: WebAssembly.Memory;
	[key: string]: unknown;
}

export default function initLibWebp(options?: unknown): Promise<WebpInitOutput>;
export function webp_probe(bytes: Uint8Array): [number, number, number, number, number, number];

export class AnimDecoder {
	constructor(bytes: Uint8Array);
	next(): boolean;
	get frame_ptr(): number;
	get end_timestamp(): number;
	free(): void;
}

export class AnimEncoder {
	constructor(width: number, height: number, loop_count: number, lossless: boolean);
	add(rgba: Uint8Array, start_ms: number, quality: number, method: number): void;
	finish(end_ms: number): Uint8Array;
	free(): void;
}
`,
	],
	[
		'src/features/messaging/utils/markdown/parser/MarkdownParserWasmBytes.ts',
		`// SPDX-License-Identifier: AGPL-3.0-or-later

export const MARKDOWN_PARSER_WASM_BASE64 =
	'AGFzbQEAAAABFQNgAX8Bf2ACf38AYAZ/f39/f38BfwMEAwABAgUDAQABB0AEBm1lbW9yeQIADm1hcmtkb3duX2FsbG9jAAANbWFya2Rvd25fZnJlZQABEnBhcnNlX21hcmtkb3duX2FzdAACCjUDBABBQAsCAAsrACAFQYABNgIAIAVBAjYCBCAFQQA2AgggBUEANgIMQYABQdu7ATsBAEEACw==';

`,
	],
]);

const missingArtifacts = [...FALLBACK_ARTIFACTS.keys()].filter(
	(relPath) => !existsSync(resolve(appDir, relPath)),
);

if (missingArtifacts.length === 0) {
	console.log('[wasm] Reusing committed wasm artifacts.');
	process.exit(0);
}

const shouldBuildFromSource =
	!process.env.CI && !process.env.VERCEL && process.env.FLUXER_BUILD_WASM === '1';

if (shouldBuildFromSource) {
	console.log('[wasm] Missing wasm artifacts, attempting compilation...');
	const result = spawnSync('../tools/ci/run.sh', ['build-app-wasm'], {
		cwd: appDir,
		stdio: 'inherit',
		shell: true,
	});
	process.exit(result.status ?? 1);
}

for (const relPath of missingArtifacts) {
	const targetPath = resolve(appDir, relPath);
	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, FALLBACK_ARTIFACTS.get(relPath));
}

console.log(`[wasm] Synthesized ${missingArtifacts.length} fallback wasm/JS artifact(s) for build.`);

