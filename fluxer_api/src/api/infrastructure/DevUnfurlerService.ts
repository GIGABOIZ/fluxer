// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MediaProxyNsfwMode } from './IMediaService';
import type { MessageEmbedResponse } from '@fluxer/schema/src/domains/message/EmbedSchemas';
import {
	type ExternalFetchRequest,
	type ExternalFetchResponse,
	IUnfurlerService,
	type UnfurlOptions,
	type UnfurlResult,
} from './IUnfurlerService';
import { getGifService } from '../middleware/ServiceSingletons';
import { Logger } from '../Logger';

export class DevUnfurlerService extends IUnfurlerService {
	private readonly cache = new Map<string, MessageEmbedResponse[]>();

	override async unfurlWithCachePolicy(
		url: string,
		_nsfwMode?: MediaProxyNsfwMode,
		_options?: UnfurlOptions,
	): Promise<UnfurlResult> {
		if (this.cache.has(url)) {
			return { embeds: this.cache.get(url)!, cacheTtlSeconds: 86400 };
		}

		try {
			const parsed = new URL(url);
			const hostname = parsed.hostname.toLowerCase();

			// 1. Klipy GIF link resolution
			if (hostname === 'klipy.com' || hostname === 'www.klipy.com') {
				const gifService = getGifService();
				const resolved = await gifService.resolveByUrl({
					url,
					locale: 'en-US',
					country: 'US',
				});

				if (resolved) {
					const videoMedia =
						resolved.media.mp4 ||
						resolved.media.webm ||
						resolved.media.mediummp4 ||
						resolved.media.mediumwebm ||
						resolved.media.tinywebm ||
						resolved.media.tinymp4;

					const imageMedia =
						resolved.media.gif ||
						resolved.media.webp ||
						resolved.media.mediumgif ||
						resolved.media.tinygif;

					const videoUrl = videoMedia?.src || resolved.src;
					const videoProxyUrl = videoMedia?.proxy_src || resolved.proxy_src;
					const thumbUrl = imageMedia?.src || videoUrl;
					const thumbProxyUrl = imageMedia?.proxy_src || videoProxyUrl;

					const embed: MessageEmbedResponse = {
						type: 'gifv',
						url: resolved.url,
						title: null,
						description: null,
						provider: {
							name: 'KLIPY',
							url: 'https://klipy.com',
						},
						thumbnail: {
							url: thumbUrl,
							proxy_url: thumbProxyUrl,
							width: resolved.width || 300,
							height: resolved.height || 300,
							content_type: 'image/gif',
							flags: 0,
						},
						video: {
							url: videoUrl,
							proxy_url: videoProxyUrl,
							width: resolved.width || 300,
							height: resolved.height || 300,
							content_type: videoMedia?.src.endsWith('.webm') ? 'video/webm' : 'video/mp4',
							flags: 0,
						},
					};

					const embeds = [embed];
					this.cache.set(url, embeds);
					Logger.info({ url, title: resolved.title }, '[DevUnfurlerService] Successfully unfurled Klipy GIF');
					return { embeds, cacheTtlSeconds: 86400 };
				}
			}

			// 2. Direct Image Link resolution
			if (/\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(parsed.pathname)) {
				const embed: MessageEmbedResponse = {
					type: 'image',
					url,
					title: null,
					thumbnail: {
						url,
						proxy_url: url,
						width: 400,
						height: 300,
						flags: 0,
					},
					image: {
						url,
						proxy_url: url,
						width: 400,
						height: 300,
						flags: 0,
					},
				};
				const embeds = [embed];
				this.cache.set(url, embeds);
				return { embeds, cacheTtlSeconds: 86400 };
			}

			// 3. Direct Video Link resolution
			if (/\.(mp4|webm|mov)(\?.*)?$/i.test(parsed.pathname)) {
				const embed: MessageEmbedResponse = {
					type: 'video',
					url,
					title: null,
					video: {
						url,
						proxy_url: url,
						width: 400,
						height: 300,
						flags: 0,
					},
				};
				const embeds = [embed];
				this.cache.set(url, embeds);
				return { embeds, cacheTtlSeconds: 86400 };
			}
		} catch (err) {
			Logger.warn({ err, url }, '[DevUnfurlerService] Failed to unfurl URL');
		}

		return { embeds: [], cacheTtlSeconds: null };
	}

	override async verifyDomain(_domain: string, _token: string): Promise<boolean> {
		return true;
	}

	override async fetchExternal(request: ExternalFetchRequest): Promise<ExternalFetchResponse> {
		const res = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
		});
		const headers: Array<[string, string]> = [];
		res.headers.forEach((v, k) => headers.push([k, v]));
		return {
			status: res.status,
			headers,
			body: await res.text(),
		};
	}

	override async resolveTxt(_name: string): Promise<Array<string>> {
		return [];
	}

	override async activityPubPublicKey(): Promise<string | null> {
		return null;
	}
}
