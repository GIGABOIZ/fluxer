// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import fs from 'node:fs';
import {Config} from '@app/api/Config';
import {
	IMediaService,
	type MediaProxyMetadataRequest,
	type MediaProxyMetadataResponse,
	type MediaProxySniffResponse,
	type MediaProxyStorageObject,
	type MediaProxyStrippedObject,
} from '@app/api/infrastructure/IMediaService';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';

export class TestMediaService extends IMediaService {
	constructor(private readonly storageService: IStorageService) {
		super();
	}

	async getMetadata(request: MediaProxyMetadataRequest): Promise<MediaProxyMetadataResponse | null> {
		if (request.type === 'base64') {
			return this.analyzeBase64Image(request.base64);
		}
		if (request.type === 's3') {
			let stored: Buffer | null = null;
			try {
				stored = Buffer.from(await this.storageService.readObject(request.bucket, request.key));
			} catch {
				stored = null;
			}
			const format = (stored ? this.detectImageFormat(stored) : null) ?? this.getFormatFromFilename(request.key);
			if (!format) {
				return null;
			}
			const dimensions = this.readMediaDimensions(stored, format);
			return {
				format,
				content_type: this.contentTypeForFormat(format),
				content_hash: crypto.createHash('md5').update(request.key).digest('hex'),
				size: stored?.length ?? 1024,
				width: dimensions.width,
				height: dimensions.height,
				animated: stored ? this.isAnimatedImage(stored, format) : format === 'gif',
				nsfw: false,
				placeholder: this.fakePlaceholder(request.key),
			};
		}
		if (request.type === 'upload') {
			const filename = request.upload_filename.toLowerCase();
			let stored: Buffer | null = null;
			try {
				stored = Buffer.from(await this.storageService.readObject(Config.s3.buckets.uploads, request.upload_filename));
			} catch {
				stored = null;
			}
			const format = (stored ? this.detectImageFormat(stored) : null) ?? this.getFormatFromFilename(filename);
			if (!format) {
				return null;
			}
			const dimensions = this.readMediaDimensions(stored, format);
			const uploadedFile = await this.storageService.getObjectMetadata(
				Config.s3.buckets.uploads,
				request.upload_filename,
			);
			return {
				format,
				content_type: this.contentTypeForFormat(format),
				content_hash: crypto.createHash('md5').update(request.upload_filename).digest('hex'),
				size: uploadedFile?.contentLength ?? stored?.length ?? 1024,
				width: dimensions.width,
				height: dimensions.height,
				animated: stored ? this.isAnimatedImage(stored, format) : format === 'gif',
				nsfw: false,
				placeholder: this.fakePlaceholder(request.upload_filename),
			};
		}
		if (request.type === 'external') {
			return {
				format: 'png',
				content_type: 'image/png',
				content_hash: crypto.createHash('md5').update(request.url).digest('hex'),
				size: 1024,
				width: 1280,
				height: 720,
				animated: false,
				nsfw: false,
				placeholder: this.fakePlaceholder(request.url),
			};
		}
		return null;
	}

	private fakePlaceholder(seed: string): string {
		return crypto.createHash('sha256').update(seed).digest('base64').slice(0, 24);
	}

	getExternalMediaProxyURL(): string {
		return 'https://media-proxy.test';
	}

	async sniffUpload(uploadFilename: string): Promise<MediaProxySniffResponse | null> {
		const format = this.getFormatFromFilename(uploadFilename);
		if (!format) {
			return null;
		}
		return {content_type: this.contentTypeForFormat(format)};
	}

	async stripObjectMetadata(
		source: MediaProxyStorageObject,
		contentType: string,
		outputPath: string,
	): Promise<MediaProxyStrippedObject | null> {
		const bytes = await this.storageService.readObject(source.bucket, source.key);
		await fs.promises.writeFile(outputPath, bytes);
		const format = this.detectImageFormat(Buffer.from(bytes)) ?? this.getFormatFromFilename(source.key);
		const dimensions = this.readMediaDimensions(Buffer.from(bytes), format);
		return {contentType, width: dimensions.width, height: dimensions.height};
	}

	async stripImageMetadata(image: Uint8Array): Promise<Uint8Array | null> {
		return image;
	}

	async getAudioDurationSeconds(base64: string): Promise<number | null> {
		const buffer = Buffer.from(base64, 'base64');
		if (!this.isWav(buffer) || buffer.length < 44) {
			return null;
		}
		const byteRate = buffer.readUInt32LE(28);
		return byteRate > 0 ? buffer.readUInt32LE(40) / byteRate : null;
	}

	private analyzeBase64Image(base64: string): MediaProxyMetadataResponse | null {
		try {
			const buffer = Buffer.from(base64, 'base64');
			if (buffer.length === 0) {
				return null;
			}
			const format = this.detectImageFormat(buffer) ?? (this.isWav(buffer) ? 'wav' : null);
			if (!format) {
				return null;
			}
			const dimensions = this.readPngDimensions(buffer, format);
			return {
				format,
				content_type: this.contentTypeForFormat(format),
				content_hash: crypto.createHash('md5').update(buffer).digest('hex'),
				size: buffer.length,
				width: dimensions?.width ?? 128,
				height: dimensions?.height ?? 128,
				animated: this.isAnimatedImage(buffer, format),
				nsfw: false,
			};
		} catch (_error) {
			return null;
		}
	}

	private readMediaDimensions(buffer: Buffer | null, format: string): {width: number; height: number} {
		if (!buffer || buffer.length < 8) {
			if (['mp4', 'webm', 'mov', 'm4v', 'ogg', 'mkv'].includes(format)) {
				return {width: 1920, height: 1080};
			}
			return {width: 1280, height: 720};
		}

		// 1. PNG
		if (format === 'png' && buffer.length >= 24) {
			if (buffer.toString('latin1', 12, 16) === 'IHDR') {
				const width = buffer.readUInt32BE(16);
				const height = buffer.readUInt32BE(20);
				if (width > 0 && height > 0) return {width, height};
			}
		}

		// 2. GIF
		if (format === 'gif' && buffer.length >= 10) {
			const width = buffer.readUInt16LE(6);
			const height = buffer.readUInt16LE(8);
			if (width > 0 && height > 0) return {width, height};
		}

		// 3. JPEG
		if (format === 'jpeg' && buffer.length >= 4) {
			let offset = 2;
			while (offset < buffer.length - 8) {
				if (buffer[offset] !== 0xff) {
					offset++;
					continue;
				}
				const marker = buffer[offset + 1];
				if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
					const height = buffer.readUInt16BE(offset + 5);
					const width = buffer.readUInt16BE(offset + 7);
					if (width > 0 && height > 0) return {width, height};
					break;
				}
				const length = buffer.readUInt16BE(offset + 2);
				offset += 2 + length;
			}
		}

		// 4. WEBP
		if (format === 'webp' && buffer.length >= 30) {
			const chunk = buffer.toString('latin1', 12, 16);
			if (chunk === 'VP8X' && buffer.length >= 30) {
				const width = 1 + buffer.readUIntLE(24, 3);
				const height = 1 + buffer.readUIntLE(27, 3);
				if (width > 0 && height > 0) return {width, height};
			} else if (chunk === 'VP8 ' && buffer.length >= 30) {
				const width = buffer.readUInt16LE(26) & 0x3fff;
				const height = buffer.readUInt16LE(28) & 0x3fff;
				if (width > 0 && height > 0) return {width, height};
			} else if (chunk === 'VP8L' && buffer.length >= 25) {
				const b0 = buffer[21];
				const b1 = buffer[22];
				const b2 = buffer[23];
				const b3 = buffer[24];
				const width = 1 + (((b1 & 0x3f) << 8) | b0);
				const height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
				if (width > 0 && height > 0) return {width, height};
			}
		}

		if (['mp4', 'webm', 'mov', 'm4v', 'ogg', 'mkv'].includes(format)) {
			return {width: 1920, height: 1080};
		}

		return {width: 1280, height: 720};
	}

	private readPngDimensions(buffer: Buffer, format: string): {width: number; height: number} | null {
		if (format !== 'png' || buffer.length < 24 || buffer.toString('latin1', 12, 16) !== 'IHDR') {
			return null;
		}
		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);
		return width > 0 && height > 0 ? {width, height} : null;
	}

	private detectImageFormat(buffer: Buffer): string | null {
		if (this.isSvg(buffer)) {
			return 'svg';
		}
		if (buffer.length < 12) {
			return null;
		}
		const first12Bytes = buffer.subarray(0, 12);
		if (this.isPng(first12Bytes)) {
			return 'png';
		}
		if (this.isGif(first12Bytes)) {
			return 'gif';
		}
		if (this.isWebP(first12Bytes)) {
			return 'webp';
		}
		if (this.isJpeg(first12Bytes)) {
			return 'jpeg';
		}
		return null;
	}

	private isSvg(buffer: Buffer): boolean {
		const prefix = buffer
			.subarray(0, 1024)
			.toString('utf8')
			.replace(/^\uFEFF/, '')
			.trimStart()
			.toLowerCase();
		return prefix.startsWith('<svg') || (prefix.startsWith('<?xml') && prefix.includes('<svg'));
	}

	private isPng(bytes: Buffer): boolean {
		return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	}

	private isGif(bytes: Buffer): boolean {
		return (
			bytes[0] === 0x47 &&
			bytes[1] === 0x49 &&
			bytes[2] === 0x46 &&
			bytes[3] === 0x38 &&
			(bytes[4] === 0x37 || bytes[4] === 0x39) &&
			bytes[5] === 0x61
		);
	}

	private isWebP(bytes: Buffer): boolean {
		return (
			bytes[0] === 0x52 &&
			bytes[1] === 0x49 &&
			bytes[2] === 0x46 &&
			bytes[3] === 0x46 &&
			bytes[8] === 0x57 &&
			bytes[9] === 0x45 &&
			bytes[10] === 0x42 &&
			bytes[11] === 0x50
		);
	}

	private isWav(bytes: Buffer): boolean {
		return bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE';
	}

	private isJpeg(bytes: Buffer): boolean {
		return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	}

	private isAnimatedImage(buffer: Buffer, format: string): boolean {
		if (format === 'gif') return true;
		if (format === 'webp') return buffer.includes(Buffer.from('ANIM'));
		if (format === 'png') return buffer.includes(Buffer.from('acTL'));
		return false;
	}

	private getFormatFromFilename(filename: string): string | null {
		const ext = filename.split('.').pop()?.toLowerCase();
		if (!ext) return null;
		if (['png', 'gif', 'webp', 'jpeg', 'jpg', 'svg', 'bmp', 'avif', 'ico'].includes(ext)) {
			return ext === 'jpg' ? 'jpeg' : ext;
		}
		if (['mp4', 'webm', 'mov', 'm4v', 'ogg', 'mkv'].includes(ext)) {
			return ext;
		}
		if (['mp3', 'wav', 'm4a', 'flac', 'aac'].includes(ext)) {
			return ext;
		}
		return null;
	}

	private contentTypeForFormat(format: string | null): string {
		if (!format) return 'application/octet-stream';
		if (format === 'jpeg') return 'image/jpeg';
		if (format === 'svg') return 'image/svg+xml';
		if (format === 'wav') return 'audio/wav';
		if (format === 'mp3') return 'audio/mpeg';
		if (format === 'm4a') return 'audio/mp4';
		if (format === 'flac') return 'audio/flac';
		if (format === 'aac') return 'audio/aac';
		if (format === 'mp4' || format === 'mov' || format === 'm4v') return 'video/mp4';
		if (format === 'webm') return 'video/webm';
		if (format === 'ogg' || format === 'mkv') return 'video/ogg';
		return `image/${format}`;
	}
}
