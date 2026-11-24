// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto, {createHash} from 'node:crypto';
import fs from 'node:fs';
import path, {dirname} from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {
	type IStorageService,
	StorageObjectListingOverflowError,
	StorageObjectRangeNotSatisfiableError,
} from '@app/api/infrastructure/IStorageService';
import {compareText} from '@app/api/utils/StringComparison';
import {S3ServiceException} from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OBJECT_ID_SEPARATOR = '\u0000';
const CATBOX_API_ENDPOINT = 'https://catbox.moe/user/api.php';
const PERSIST_FILE_PATH = path.resolve(__dirname, '../../../.sync_data/catbox_objects.json');

export interface CatboxStoredObject {
	bucket: string;
	key: string;
	url: string;
	size: number;
	contentType: string;
	etag: string;
	sha256: string;
	lastModified: string;
}

function computeEtag(data: Uint8Array): string {
	return `"${createHash('md5').update(data).digest('hex')}"`;
}

function computeSha256(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

function noSuchKeyError(key: string): S3ServiceException {
	return new S3ServiceException({
		name: 'NoSuchKey',
		$fault: 'client',
		$metadata: {},
		message: `The specified key does not exist: ${key}`,
	});
}

async function streamToBuffer(readable: Readable): Promise<Buffer> {
	const chunks: Array<Buffer> = [];
	for await (const chunk of readable) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

export class CatboxStorageService implements IStorageService {
	private objects: Map<string, CatboxStoredObject> = new Map();
	private ramCache: Map<string, { buffer: Buffer; contentType: string }> = new Map();
	private multipartUploads: Map<
		string,
		{
			parts: Map<number, Uint8Array>;
			key: string;
			bucket: string;
			contentType?: string;
		}
	> = new Map();
	private saveTimer: NodeJS.Timeout | null = null;

	constructor() {
		this.loadFromDisk();
	}

	private loadFromDisk(): void {
		try {
			if (fs.existsSync(PERSIST_FILE_PATH)) {
				const raw = fs.readFileSync(PERSIST_FILE_PATH, 'utf-8');
				const data = JSON.parse(raw) as Record<string, CatboxStoredObject>;
				for (const [k, v] of Object.entries(data)) {
					this.objects.set(k, v);
				}
				console.log(`[CatboxStorageService] Loaded ${this.objects.size} stored file mappings from disk.`);
			}
		} catch (err) {
			console.warn('[CatboxStorageService] Could not load persisted catbox_objects.json:', err);
		}
	}

	private saveToDisk(): void {
		try {
			const dir = path.dirname(PERSIST_FILE_PATH);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, {recursive: true});
			}
			const data: Record<string, CatboxStoredObject> = {};
			for (const [k, v] of this.objects.entries()) {
				data[k] = v;
			}
			fs.writeFileSync(PERSIST_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
		} catch (err) {
			console.error('[CatboxStorageService] Failed to persist catbox objects:', err);
		}
	}

	private lookupInMemory(keyOrPath: string): string | null {
		for (const obj of this.objects.values()) {
			if (obj.key === keyOrPath || keyOrPath.endsWith(obj.key) || obj.key.endsWith(keyOrPath)) {
				return obj.url;
			}
		}
		const segments = keyOrPath.split('/');
		const filename = segments[segments.length - 1];
		for (const obj of this.objects.values()) {
			if (obj.key.endsWith(`/${filename}`) || obj.key === filename) {
				return obj.url;
			}
		}
		return null;
	}

	/**
	 * In-memory RAM buffer for instant playback without writing to disk
	 */
	getInMemoryBuffer(keyOrPath: string): { buffer: Buffer; contentType: string } | null {
		for (const [k, v] of this.ramCache.entries()) {
			if (k === keyOrPath || keyOrPath.endsWith(k) || k.endsWith(keyOrPath)) {
				return v;
			}
		}
		const filename = path.basename(keyOrPath);
		for (const [k, v] of this.ramCache.entries()) {
			if (k.endsWith(`/${filename}`) || k === filename) {
				return v;
			}
		}
		return null;
	}

	setInMemoryBuffer(key: string, buffer: Buffer, contentType: string): void {
		if (this.ramCache.size > 50) {
			const firstKey = this.ramCache.keys().next().value;
			if (firstKey) this.ramCache.delete(firstKey);
		}
		this.ramCache.set(key, { buffer, contentType });
	}

	/**
	 * Infer MIME type from file extension
	 */
	inferMimeType(filePath: string): string {
		const ext = path.extname(filePath).toLowerCase();
		switch (ext) {
			case '.jpg':
			case '.jpeg':
				return 'image/jpeg';
			case '.png':
				return 'image/png';
			case '.gif':
				return 'image/gif';
			case '.webp':
				return 'image/webp';
			case '.svg':
				return 'image/svg+xml';
			case '.bmp':
				return 'image/bmp';
			case '.ico':
				return 'image/x-icon';
			case '.mp4':
				return 'video/mp4';
			case '.webm':
				return 'video/webm';
			case '.mov':
				return 'video/quicktime';
			case '.mkv':
				return 'video/x-matroska';
			case '.mp3':
				return 'audio/mpeg';
			case '.ogg':
				return 'audio/ogg';
			case '.wav':
				return 'audio/wav';
			case '.flac':
				return 'audio/flac';
			case '.pdf':
				return 'application/pdf';
			case '.json':
				return 'application/json';
			case '.txt':
				return 'text/plain';
			default:
				return 'application/octet-stream';
		}
	}

	/**
	 * Direct Catbox URL lookup by key or partial path
	 */
	findDirectUrl(keyOrPath: string): string | null {
		let match = this.lookupInMemory(keyOrPath);
		if (!match) {
			this.loadFromDisk();
			match = this.lookupInMemory(keyOrPath);
		}
		return match;
	}

	private async uploadToCatbox(bytes: Uint8Array, filename: string): Promise<string> {
		const form = new FormData();
		form.append('reqtype', 'fileupload');
		const blob = new Blob([bytes]);
		form.append('fileToUpload', blob, filename);

		console.log(`[CatboxStorageService] Uploading ${filename} (${bytes.length} bytes) to Catbox...`);
		const response = await fetch(CATBOX_API_ENDPOINT, {
			method: 'POST',
			body: form,
		});

		const rawText = (await response.text()).trim();
		if (rawText.startsWith('http://') || rawText.startsWith('https://')) {
			console.log(`[CatboxStorageService] Successfully uploaded ${filename} -> ${rawText}`);
			return rawText;
		}

		if (!response.ok) {
			throw new Error(`Catbox upload failed with status ${response.status}: ${rawText}`);
		}

		throw new Error(`Catbox returned invalid response: ${rawText}`);
	}

	async uploadObject(params: {
		bucket: string;
		key: string;
		body: Uint8Array | Readable;
		contentType?: string;
		expiresAt?: Date;
	}): Promise<void> {
		let data: Uint8Array;
		if (params.body instanceof Uint8Array) {
			data = params.body;
		} else {
			data = await streamToBuffer(params.body);
		}

		const filename = path.basename(params.key) || 'attachment.bin';
		const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
		const inferred = this.inferMimeType(filename);
		const cType = (!params.contentType || params.contentType === 'application/octet-stream')
			? (inferred !== 'application/octet-stream' ? inferred : (params.contentType || 'application/octet-stream'))
			: params.contentType;
		this.setInMemoryBuffer(params.key, buffer, cType);
		const directUrl = await this.uploadToCatbox(data, filename);

		const obj: CatboxStoredObject = {
			bucket: params.bucket,
			key: params.key,
			url: directUrl,
			size: data.length,
			contentType: cType,
			etag: computeEtag(data),
			sha256: computeSha256(data),
			lastModified: new Date().toISOString(),
		};

		const objectId = `${params.bucket}${OBJECT_ID_SEPARATOR}${params.key}`;
		this.objects.set(objectId, obj);
		this.saveToDisk();
	}

	async uploadObjectFromFile(params: {
		bucket: string;
		key: string;
		filePath: string;
		contentType?: string;
		contentLength?: number;
		expiresAt?: Date;
	}): Promise<void> {
		const data = await fs.promises.readFile(params.filePath);
		const filename = path.basename(params.key) || path.basename(params.filePath);
		const directUrl = await this.uploadToCatbox(data, filename);
		const inferred = this.inferMimeType(filename);
		const cType = (!params.contentType || params.contentType === 'application/octet-stream')
			? (inferred !== 'application/octet-stream' ? inferred : (params.contentType || 'application/octet-stream'))
			: params.contentType;

		const obj: CatboxStoredObject = {
			bucket: params.bucket,
			key: params.key,
			url: directUrl,
			size: data.length,
			contentType: cType,
			etag: computeEtag(data),
			sha256: computeSha256(data),
			lastModified: new Date().toISOString(),
		};

		const objectId = `${params.bucket}${OBJECT_ID_SEPARATOR}${params.key}`;
		this.objects.set(objectId, obj);
		this.saveToDisk();
	}

	async deleteObject(bucket: string, key: string): Promise<void> {
		const objectId = `${bucket}${OBJECT_ID_SEPARATOR}${key}`;
		this.objects.delete(objectId);
		this.saveToDisk();
	}

	async getObjectMetadata(
		bucket: string,
		key: string,
	): Promise<{
		contentLength: number;
		contentType: string;
		etag?: string;
		lastModified?: Date;
	} | null> {
		const objectId = `${bucket}${OBJECT_ID_SEPARATOR}${key}`;
		const obj = this.objects.get(objectId);
		if (!obj) return null;
		return {
			contentLength: obj.size,
			contentType: obj.contentType,
			etag: obj.etag,
			lastModified: new Date(obj.lastModified),
		};
	}

	async computeObjectSha256(bucket: string, key: string): Promise<string> {
		const objectId = `${bucket}${OBJECT_ID_SEPARATOR}${key}`;
		const obj = this.objects.get(objectId);
		if (!obj) throw noSuchKeyError(key);
		if (obj.sha256) return obj.sha256;

		const bytes = await this.readObject(bucket, key);
		obj.sha256 = computeSha256(bytes);
		this.saveToDisk();
		return obj.sha256;
	}

	async readObject(bucket: string, key: string, maxBytes?: number): Promise<Uint8Array> {
		const objectId = `${bucket}${OBJECT_ID_SEPARATOR}${key}`;
		const obj = this.objects.get(objectId);
		if (!obj) throw noSuchKeyError(key);

		const res = await fetch(obj.url);
		if (!res.ok) {
			throw new Error(`Failed to fetch from Catbox (${obj.url}): status ${res.status}`);
		}
		const ab = await res.arrayBuffer();
		let result = new Uint8Array(ab);
		if (maxBytes !== undefined && result.length > maxBytes) {
			result = result.subarray(0, maxBytes);
		}
		return result;
	}

	async streamObject(params: {bucket: string; key: string; range?: string}): Promise<{
		body: Readable;
		contentLength: number;
		contentRange?: string | null;
		contentType?: string | null;
		etag?: string | null;
		lastModified?: Date | null;
	} | null> {
		const objectId = `${params.bucket}${OBJECT_ID_SEPARATOR}${params.key}`;
		const obj = this.objects.get(objectId);
		if (!obj) return null;

		const headers: Record<string, string> = {};
		if (params.range) {
			headers['Range'] = params.range;
		}

		const res = await fetch(obj.url, {headers});
		if (!res.ok && res.status !== 206) {
			throw new Error(`Catbox stream error (${obj.url}): HTTP ${res.status}`);
		}

		const body = Readable.fromWeb(res.body as any);
		return {
			body,
			contentLength: Number(res.headers.get('content-length') || obj.size),
			contentRange: res.headers.get('content-range'),
			contentType: res.headers.get('content-type') || obj.contentType,
			etag: obj.etag,
			lastModified: new Date(obj.lastModified),
		};
	}

	async writeObjectToDisk(bucket: string, key: string, filePath: string): Promise<void> {
		const objectId = `${bucket}${OBJECT_ID_SEPARATOR}${key}`;
		const obj = this.objects.get(objectId);
		if (!obj) throw noSuchKeyError(key);

		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) {
			await fs.promises.mkdir(dir, {recursive: true});
		}

		const res = await fetch(obj.url);
		const arrayBuffer = await res.arrayBuffer();
		await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
	}

	async copyObject(params: {
		sourceBucket: string;
		sourceKey: string;
		destinationBucket: string;
		destinationKey: string;
		newContentType?: string;
	}): Promise<void> {
		const sourceObjectId = `${params.sourceBucket}${OBJECT_ID_SEPARATOR}${params.sourceKey}`;
		const src = this.objects.get(sourceObjectId);
		if (!src) {
			throw noSuchKeyError(params.sourceKey);
		}

		const destObj: CatboxStoredObject = {
			bucket: params.destinationBucket,
			key: params.destinationKey,
			url: src.url,
			size: src.size,
			contentType: params.newContentType || src.contentType,
			etag: src.etag,
			sha256: src.sha256,
			lastModified: new Date().toISOString(),
		};

		const destObjectId = `${params.destinationBucket}${OBJECT_ID_SEPARATOR}${params.destinationKey}`;
		this.objects.set(destObjectId, destObj);
		this.saveToDisk();
	}

	async getPresignedDownloadURL(params: {
		bucket: string;
		key: string;
		expiresIn?: number;
		responseContentType?: string;
		responseContentDisposition?: string;
	}): Promise<string> {
		const objectId = `${params.bucket}${OBJECT_ID_SEPARATOR}${params.key}`;
		const obj = this.objects.get(objectId);
		if (obj) {
			return obj.url;
		}
		return `https://files.catbox.moe/${path.basename(params.key)}`;
	}

	async getPresignedUploadURL(params: {
		bucket: string;
		key: string;
		contentType?: string;
		contentLength?: number;
		expiresIn?: number;
	}): Promise<string> {
		return `http://localhost:3000/upload-relay/${params.bucket}/${params.key}`;
	}

	async getPresignedUploadPartURL(params: {
		bucket: string;
		key: string;
		uploadId: string;
		partNumber: number;
		contentLength?: number;
		expiresIn?: number;
	}): Promise<string> {
		return `http://localhost:3000/upload-relay/${params.bucket}/${params.key}?uploadId=${params.uploadId}&partNumber=${params.partNumber}`;
	}

	async uploadAvatar(params: {prefix: string; key: string; body: Uint8Array}): Promise<void> {
		await this.uploadObject({
			bucket: 'avatars',
			key: `${params.prefix}/${params.key}`,
			body: params.body,
			contentType: 'image/png',
		});
	}

	async deleteAvatar(params: {prefix: string; key: string}): Promise<void> {
		await this.deleteObject('avatars', `${params.prefix}/${params.key}`);
	}

	async listObjects(params: {bucket: string; prefix: string; maxObjects?: number}): Promise<
		ReadonlyArray<{
			key: string;
			lastModified?: Date;
		}>
	> {
		const prefix = params.prefix;
		const max = params.maxObjects ?? 1000;
		const matches: Array<{key: string; lastModified: Date}> = [];

		for (const obj of this.objects.values()) {
			if (obj.bucket === params.bucket && obj.key.startsWith(prefix)) {
				matches.push({key: obj.key, lastModified: new Date(obj.lastModified)});
				if (matches.length > max) {
					throw new StorageObjectListingOverflowError(params.bucket, prefix, max);
				}
			}
		}

		matches.sort((a, b) => compareText(a.key, b.key));
		return matches;
	}

	async createMultipartUpload(params: {bucket: string; key: string; contentType?: string}): Promise<{
		uploadId: string;
	}> {
		const uploadId = crypto.randomUUID();
		this.multipartUploads.set(uploadId, {
			parts: new Map(),
			key: params.key,
			bucket: params.bucket,
			contentType: params.contentType,
		});
		return {uploadId};
	}

	async listParts(params: {bucket: string; key: string; uploadId: string}): Promise<
		Array<{
			partNumber: number;
			etag: string;
			size?: number;
		}>
	> {
		const upload = this.multipartUploads.get(params.uploadId);
		if (!upload) return [];
		const parts: Array<{partNumber: number; etag: string; size?: number}> = [];
		for (const [partNumber, partData] of upload.parts.entries()) {
			parts.push({
				partNumber,
				etag: computeEtag(partData),
				size: partData.length,
			});
		}
		parts.sort((a, b) => a.partNumber - b.partNumber);
		return parts;
	}

	async uploadPart(params: {
		bucket: string;
		key: string;
		uploadId: string;
		partNumber: number;
		body: Uint8Array | Readable;
	}): Promise<string> {
		const upload = this.multipartUploads.get(params.uploadId);
		if (!upload) throw new Error(`Invalid uploadId: ${params.uploadId}`);
		let data: Uint8Array;
		if (params.body instanceof Uint8Array) {
			data = params.body;
		} else {
			data = await streamToBuffer(params.body);
		}
		upload.parts.set(params.partNumber, data);
		return computeEtag(data);
	}

	async completeMultipartUpload(params: {
		bucket: string;
		key: string;
		uploadId: string;
		parts: Array<{
			partNumber: number;
			etag: string;
		}>;
	}): Promise<void> {
		const upload = this.multipartUploads.get(params.uploadId);
		if (!upload) {
			throw new Error(`Invalid uploadId: ${params.uploadId}`);
		}

		const sortedParts = [...params.parts].sort((a, b) => a.partNumber - b.partNumber);
		const chunks: Array<Uint8Array> = [];
		for (const p of sortedParts) {
			const part = upload.parts.get(p.partNumber);
			if (part) {
				chunks.push(part);
			}
		}

		const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
		const combined = new Uint8Array(totalLength);
		let offset = 0;
		for (const c of chunks) {
			combined.set(c, offset);
			offset += c.length;
		}

		await this.uploadObject({
			bucket: params.bucket,
			key: params.key,
			body: combined,
			contentType: upload.contentType,
		});

		this.multipartUploads.delete(params.uploadId);
	}

	async abortMultipartUpload(params: {bucket: string; key: string; uploadId: string}): Promise<void> {
		this.multipartUploads.delete(params.uploadId);
	}
}
