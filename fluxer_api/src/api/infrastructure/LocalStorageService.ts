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
const STORAGE_ROOT_DIR = path.resolve(__dirname, '../../../.sync_data/storage');
const METADATA_FILE_PATH = path.resolve(__dirname, '../../../.sync_data/storage_objects.json');
const LEGACY_CATBOX_FILE_PATH = path.resolve(__dirname, '../../../.sync_data/catbox_objects.json');

export interface LocalStoredObject {
	bucket: string;
	key: string;
	localPath: string;
	url?: string;
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

export class LocalStorageService implements IStorageService {
	private objects: Map<string, LocalStoredObject> = new Map();
	private multipartUploads: Map<
		string,
		{
			parts: Map<number, Uint8Array>;
			key: string;
			bucket: string;
			contentType?: string;
		}
	> = new Map();
	private legacyCatboxObjects: Map<string, any> = new Map();

	constructor() {
		this.ensureDirectories();
		this.loadFromDisk();
	}

	private ensureDirectories(): void {
		if (!fs.existsSync(STORAGE_ROOT_DIR)) {
			fs.mkdirSync(STORAGE_ROOT_DIR, {recursive: true});
		}
	}

	private getTargetFilePath(bucket: string, key: string): string {
		const safeKey = key.replace(/^\/+/, '').split('/').join(path.sep);
		return path.join(STORAGE_ROOT_DIR, bucket, safeKey);
	}

	private loadFromDisk(): void {
		// 1. Load local objects
		try {
			if (fs.existsSync(METADATA_FILE_PATH)) {
				const raw = fs.readFileSync(METADATA_FILE_PATH, 'utf-8');
				const data = JSON.parse(raw) as Record<string, LocalStoredObject>;
				for (const [k, v] of Object.entries(data)) {
					this.objects.set(k, v);
				}
				console.log(`[LocalStorageService] Loaded ${this.objects.size} local storage objects from disk.`);
			}
		} catch (err) {
			console.warn('[LocalStorageService] Could not load storage_objects.json:', err);
		}

		// 2. Load legacy Catbox objects for backwards compatibility
		try {
			if (fs.existsSync(LEGACY_CATBOX_FILE_PATH)) {
				const raw = fs.readFileSync(LEGACY_CATBOX_FILE_PATH, 'utf-8');
				const data = JSON.parse(raw) as Record<string, any>;
				for (const [k, v] of Object.entries(data)) {
					this.legacyCatboxObjects.set(k, v);
				}
			}
		} catch {}
	}

	private saveToDisk(): void {
		try {
			const dir = path.dirname(METADATA_FILE_PATH);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, {recursive: true});
			}
			const data: Record<string, LocalStoredObject> = {};
			for (const [k, v] of this.objects.entries()) {
				data[k] = v;
			}
			fs.writeFileSync(METADATA_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
		} catch (err) {
			console.error('[LocalStorageService] Failed to persist storage objects:', err);
		}
	}

	/**
	 * Find local absolute file path for a key or partial path
	 */
	findLocalFilePath(keyOrPath: string): string | null {
		// 1. Direct object key match
		for (const obj of this.objects.values()) {
			if (obj.key === keyOrPath || keyOrPath.endsWith(obj.key) || obj.key.endsWith(keyOrPath)) {
				if (fs.existsSync(obj.localPath)) return obj.localPath;
			}
		}

		// 2. Filename match
		const filename = path.basename(keyOrPath);
		for (const obj of this.objects.values()) {
			if (obj.key.endsWith(`/${filename}`) || obj.key === filename) {
				if (fs.existsSync(obj.localPath)) return obj.localPath;
			}
		}

		// 3. Direct filesystem check across known buckets
		const buckets = ['fluxer', 'fluxer-uploads', 'cdn', 'uploads', 'avatars'];
		for (const b of buckets) {
			const candidate = this.getTargetFilePath(b, keyOrPath);
			if (fs.existsSync(candidate)) return candidate;
		}

		return null;
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
	 * Direct Catbox URL lookup for legacy files
	 */
	findDirectUrl(keyOrPath: string): string | null {
		for (const obj of this.legacyCatboxObjects.values()) {
			if (obj.key === keyOrPath || keyOrPath.endsWith(obj.key) || obj.key.endsWith(keyOrPath)) {
				return obj.url;
			}
		}
		const filename = path.basename(keyOrPath);
		for (const obj of this.legacyCatboxObjects.values()) {
			if (obj.key.endsWith(`/${filename}`) || obj.key === filename) {
				return obj.url;
			}
		}
		return null;
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

		const localPath = this.getTargetFilePath(params.bucket, params.key);
		fs.mkdirSync(path.dirname(localPath), {recursive: true});
		fs.writeFileSync(localPath, data);

		const obj: LocalStoredObject = {
			bucket: params.bucket,
			key: params.key,
			localPath,
			size: data.length,
			contentType: params.contentType || 'application/octet-stream',
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
		const targetPath = this.getTargetFilePath(params.bucket, params.key);
		fs.mkdirSync(path.dirname(targetPath), {recursive: true});
		fs.copyFileSync(params.filePath, targetPath);

		const stat = fs.statSync(targetPath);
		const data = fs.readFileSync(targetPath);

		const obj: LocalStoredObject = {
			bucket: params.bucket,
			key: params.key,
			localPath: targetPath,
			size: stat.size,
			contentType: params.contentType || 'application/octet-stream',
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
		const obj = this.objects.get(objectId);
		if (obj && fs.existsSync(obj.localPath)) {
			try {
				fs.unlinkSync(obj.localPath);
			} catch {}
		}
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
		if (obj) {
			return {
				contentLength: obj.size,
				contentType: obj.contentType,
				etag: obj.etag,
				lastModified: new Date(obj.lastModified),
			};
		}

		// Check local disk directly
		const targetPath = this.getTargetFilePath(bucket, key);
		if (fs.existsSync(targetPath)) {
			const stat = fs.statSync(targetPath);
			return {
				contentLength: stat.size,
				contentType: 'application/octet-stream',
				etag: `"${stat.mtimeMs}"`,
				lastModified: stat.mtime,
			};
		}

		// Check legacy Catbox object
		const legacy = this.legacyCatboxObjects.get(objectId);
		if (legacy) {
			return {
				contentLength: legacy.size,
				contentType: legacy.contentType,
				etag: legacy.etag,
				lastModified: new Date(legacy.lastModified),
			};
		}

		return null;
	}

	async computeObjectSha256(bucket: string, key: string): Promise<string> {
		const objectId = `${bucket}${OBJECT_ID_SEPARATOR}${key}`;
		const obj = this.objects.get(objectId);
		if (obj?.sha256) return obj.sha256;

		const bytes = await this.readObject(bucket, key);
		const sha = computeSha256(bytes);
		if (obj) {
			obj.sha256 = sha;
			this.saveToDisk();
		}
		return sha;
	}

	async readObject(bucket: string, key: string, maxBytes?: number): Promise<Uint8Array> {
		const objectId = `${bucket}${OBJECT_ID_SEPARATOR}${key}`;
		const obj = this.objects.get(objectId);
		if (obj && fs.existsSync(obj.localPath)) {
			const buffer = fs.readFileSync(obj.localPath);
			return maxBytes ? buffer.subarray(0, maxBytes) : buffer;
		}

		const targetPath = this.getTargetFilePath(bucket, key);
		if (fs.existsSync(targetPath)) {
			const buffer = fs.readFileSync(targetPath);
			return maxBytes ? buffer.subarray(0, maxBytes) : buffer;
		}

		// Legacy Catbox fetch
		const legacy = this.legacyCatboxObjects.get(objectId);
		if (legacy?.url) {
			const res = await fetch(legacy.url);
			if (res.ok) {
				const buf = Buffer.from(await res.arrayBuffer());
				return maxBytes ? buf.subarray(0, maxBytes) : buf;
			}
		}

		throw noSuchKeyError(key);
	}

	async readObjectStream(params: {
		bucket: string;
		key: string;
		range?: {start: number; end: number};
	}): Promise<{
		body: Readable;
		contentLength: number;
		contentType: string;
		etag: string;
	}> {
		const objectId = `${params.bucket}${OBJECT_ID_SEPARATOR}${params.key}`;
		const obj = this.objects.get(objectId);
		const filePath = obj?.localPath ?? this.getTargetFilePath(params.bucket, params.key);

		if (fs.existsSync(filePath)) {
			const stat = fs.statSync(filePath);
			let start = params.range?.start ?? 0;
			let end = params.range?.end ?? stat.size - 1;
			if (start > stat.size - 1) {
				throw new StorageObjectRangeNotSatisfiableError(stat.size);
			}
			const stream = fs.createReadStream(filePath, {start, end});
			return {
				body: stream,
				contentLength: end - start + 1,
				contentType: obj?.contentType || 'application/octet-stream',
				etag: obj?.etag || `"${stat.mtimeMs}"`,
			};
		}

		throw noSuchKeyError(params.key);
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
		const sourcePath = src?.localPath ?? this.getTargetFilePath(params.sourceBucket, params.sourceKey);

		if (fs.existsSync(sourcePath)) {
			const destPath = this.getTargetFilePath(params.destinationBucket, params.destinationKey);
			fs.mkdirSync(path.dirname(destPath), {recursive: true});
			fs.copyFileSync(sourcePath, destPath);

			const stat = fs.statSync(destPath);
			const data = fs.readFileSync(destPath);

			const destObj: LocalStoredObject = {
				bucket: params.destinationBucket,
				key: params.destinationKey,
				localPath: destPath,
				size: stat.size,
				contentType: params.newContentType || src?.contentType || 'application/octet-stream',
				etag: computeEtag(data),
				sha256: computeSha256(data),
				lastModified: new Date().toISOString(),
			};

			const destObjectId = `${params.destinationBucket}${OBJECT_ID_SEPARATOR}${params.destinationKey}`;
			this.objects.set(destObjectId, destObj);
			this.saveToDisk();
			return;
		}

		// Fallback for legacy catbox object
		const legacy = this.legacyCatboxObjects.get(sourceObjectId);
		if (legacy) {
			const destObjectId = `${params.destinationBucket}${OBJECT_ID_SEPARATOR}${params.destinationKey}`;
			this.legacyCatboxObjects.set(destObjectId, {
				...legacy,
				bucket: params.destinationBucket,
				key: params.destinationKey,
			});
			return;
		}

		throw noSuchKeyError(params.sourceKey);
	}

	async getPresignedDownloadURL(params: {
		bucket: string;
		key: string;
		expiresIn?: number;
		responseContentType?: string;
		responseContentDisposition?: string;
	}): Promise<string> {
		return `http://localhost:3000/media/${params.key}`;
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
