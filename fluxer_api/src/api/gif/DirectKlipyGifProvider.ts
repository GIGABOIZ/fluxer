// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {Logger} from '@app/api/Logger';
import type {GifApiKeyResolver} from '@app/api/gif/NatsGifProvider';
import {buildKlipyShareUrl, extractKlipySlugFromUrl} from '@app/api/gif/NatsGifProvider';
import type {GifProviderMeta, IGifProvider} from '@app/api/gif/IGifProvider';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import type {
	GifCategoryTagResponse,
	GifMediaFormat,
	GifResponse,
} from '@fluxer/schema/src/domains/gif/GifSchemas';
import {getExternalMediaProxyURL} from '@pkgs/media_proxy_utils/src/MediaProxyUtils';

const KLIPY_BASE_URL = 'https://api.klipy.com/v2';
const CLIENT_KEY = 'fluxer';
const DEFAULT_CONTENT_FILTER = 'low';

const GIF_PROVIDER_META: GifProviderMeta = {
	name: 'klipy',
	displayName: 'Klipy',
	attributionRequired: false,
};

function normalizeLocale(locale: string): string {
	const normalized = locale.replace('_', '-').trim().toLowerCase();
	const base = normalized.split('-')[0];
	return base || 'en';
}

function toMediaFormat(entry: any): GifMediaFormat | null {
	if (!entry || typeof entry !== 'object') return null;
	const src = typeof entry.url === 'string' ? entry.url.trim() : '';
	if (!src) return null;
	let width = 0;
	let height = 0;
	if (Array.isArray(entry.dims) && entry.dims.length >= 2) {
		width = Number(entry.dims[0]) || 0;
		height = Number(entry.dims[1]) || 0;
	} else if (typeof entry.width === 'number' && typeof entry.height === 'number') {
		width = entry.width;
		height = entry.height;
	}
	// Use direct CDN URL for proxy_src as static.klipy.com supports CORS universally
	const proxy_src = src;
	return {src, proxy_src, width, height};
}

function transformKlipyGif(gif: any): GifResponse | null {
	if (!gif || typeof gif !== 'object') return null;
	const id = String(gif.id ?? '');
	if (!id) return null;
	const slug = (typeof gif.slug === 'string' && gif.slug.trim()) || id;
	const title = typeof gif.title === 'string' ? gif.title : '';
	const url = typeof gif.itemurl === 'string' && gif.itemurl.trim() ? gif.itemurl.trim() : buildKlipyShareUrl(slug);

	const media: Record<string, GifMediaFormat> = {};

	if (gif.media_formats && typeof gif.media_formats === 'object') {
		for (const [format, entry] of Object.entries(gif.media_formats)) {
			const formatted = toMediaFormat(entry);
			if (formatted) {
				media[format] = formatted;
			}
		}
	}

	if (gif.file && typeof gif.file === 'object') {
		const sizePrefixes: [string, string][] = [
			['hd', ''],
			['md', 'medium'],
			['sm', 'tiny'],
			['xs', 'nano'],
		];
		const fileFormats = ['webm', 'mp4', 'webp', 'gif'];
		for (const [size, prefix] of sizePrefixes) {
			const bucket = gif.file[size];
			if (bucket && typeof bucket === 'object') {
				for (const format of fileFormats) {
					const entry = bucket[format];
					const formatted = toMediaFormat(entry);
					if (formatted) {
						const key = prefix ? `${prefix}${format}` : format;
						media[key] ??= formatted;
					}
				}
			}
		}
	}

	const preferred =
		media.tinygif ||
		media.gif ||
		media.mediumgif ||
		media.nanogif ||
		media.webp ||
		media.webm ||
		media.mp4 ||
		Object.values(media)[0];
	if (!preferred) return null;

	return {
		id,
		slug,
		provider: 'klipy',
		title,
		url,
		src: preferred.src,
		proxy_src: preferred.proxy_src,
		width: preferred.width,
		height: preferred.height,
		media,
		placeholder: null,
	};
}

export class DirectKlipyGifProvider implements IGifProvider {
	readonly meta = GIF_PROVIDER_META;

	constructor(private readonly apiKeyResolver: GifApiKeyResolver) {}

	async requireAvailable(): Promise<this> {
		if (!(await this.isAvailable())) {
			throw new FeatureTemporarilyDisabledError();
		}
		return this;
	}

	async isAvailable(): Promise<boolean> {
		const key = (await this.apiKeyResolver())?.trim();
		return Boolean(key);
	}

	private async getApiKey(): Promise<string> {
		const key = (await this.apiKeyResolver())?.trim();
		if (!key) {
			throw new FeatureTemporarilyDisabledError();
		}
		return key;
	}

	async search(params: {q: string; locale: string; country: string}): Promise<Array<GifResponse>> {
		const apiKey = await this.getApiKey();
		const locale = normalizeLocale(params.locale);
		const url = new URL(`${KLIPY_BASE_URL}/search`);
		url.searchParams.set('key', apiKey);
		url.searchParams.set('q', params.q);
		url.searchParams.set('locale', locale);
		url.searchParams.set('country', params.country || 'US');
		url.searchParams.set('limit', '30');
		url.searchParams.set('client_key', CLIENT_KEY);
		url.searchParams.set('contentfilter', DEFAULT_CONTENT_FILTER);

		const response = await fetch(url.toString(), {
			headers: {'User-Agent': 'Fluxerbot/1.0 (+https://fluxer.com)'},
		});
		if (!response.ok) {
			throw new ServiceUnavailableError({message: `Klipy search request failed with status ${response.status}`});
		}
		const json = (await response.json()) as {results?: any[]};
		if (!Array.isArray(json.results)) return [];
		return json.results.map(transformKlipyGif).filter((g): g is GifResponse => g !== null);
	}

	async getTrendingGifs(params: {locale: string; country: string}): Promise<Array<GifResponse>> {
		const apiKey = await this.getApiKey();
		const locale = normalizeLocale(params.locale);
		const url = new URL(`${KLIPY_BASE_URL}/featured`);
		url.searchParams.set('key', apiKey);
		url.searchParams.set('locale', locale);
		url.searchParams.set('country', params.country || 'US');
		url.searchParams.set('limit', '30');
		url.searchParams.set('client_key', CLIENT_KEY);
		url.searchParams.set('contentfilter', DEFAULT_CONTENT_FILTER);

		const response = await fetch(url.toString(), {
			headers: {'User-Agent': 'Fluxerbot/1.0 (+https://fluxer.com)'},
		});
		if (!response.ok) {
			throw new ServiceUnavailableError({message: `Klipy featured request failed with status ${response.status}`});
		}
		const json = (await response.json()) as {results?: any[]};
		if (!Array.isArray(json.results)) return [];
		return json.results.map(transformKlipyGif).filter((g): g is GifResponse => g !== null);
	}

	async getFeatured(params: {locale: string; country: string}): Promise<{
		gifs: Array<GifResponse>;
		categories: Array<GifCategoryTagResponse>;
	}> {
		const [gifs, categories] = await Promise.all([
			this.getTrendingGifs(params),
			this.getCategories(params.locale),
		]);
		return {gifs, categories};
	}

	private async getCategories(locale: string): Promise<Array<GifCategoryTagResponse>> {
		const apiKey = await this.getApiKey();
		const normalizedLocale = normalizeLocale(locale);
		const url = new URL(`${KLIPY_BASE_URL}/categories`);
		url.searchParams.set('key', apiKey);
		url.searchParams.set('country', 'US');
		url.searchParams.set('locale', normalizedLocale);
		url.searchParams.set('type', 'featured');
		url.searchParams.set('client_key', CLIENT_KEY);
		url.searchParams.set('contentfilter', DEFAULT_CONTENT_FILTER);

		try {
			const response = await fetch(url.toString(), {
				headers: {'User-Agent': 'Fluxerbot/1.0 (+https://fluxer.com)'},
			});
			if (!response.ok) return [];
			const json = (await response.json()) as {tags?: any[]};
			if (!Array.isArray(json.tags)) return [];
			return json.tags
				.map((tag: any) => ({
					name: tag.searchterm || tag.name || '',
					src: tag.image || '',
					proxy_src: tag.image || '',
					gif: null,
				}))
				.filter((c) => Boolean(c.name && c.src));
		} catch (error) {
			Logger.warn({error}, '[DirectKlipyGifProvider] Failed to fetch categories');
			return [];
		}
	}

	async suggest(params: {q: string; locale: string}): Promise<Array<string>> {
		const apiKey = await this.getApiKey();
		const locale = normalizeLocale(params.locale);
		const url = new URL(`${KLIPY_BASE_URL}/autocomplete`);
		url.searchParams.set('key', apiKey);
		url.searchParams.set('q', params.q);
		url.searchParams.set('locale', locale);
		url.searchParams.set('client_key', CLIENT_KEY);

		try {
			const response = await fetch(url.toString(), {
				headers: {'User-Agent': 'Fluxerbot/1.0 (+https://fluxer.com)'},
			});
			if (!response.ok) return [];
			const json = (await response.json()) as {results?: string[]};
			return Array.isArray(json.results) ? json.results : [];
		} catch {
			return [];
		}
	}

	async registerShare(params: {id: string; q: string; locale: string; country: string}): Promise<void> {
		const apiKey = await this.getApiKey();
		const locale = normalizeLocale(params.locale);
		const url = new URL(`${KLIPY_BASE_URL}/registershare`);
		url.searchParams.set('key', apiKey);
		url.searchParams.set('id', params.id);
		url.searchParams.set('q', params.q || '');
		url.searchParams.set('locale', locale);
		url.searchParams.set('country', params.country || 'US');
		url.searchParams.set('client_key', CLIENT_KEY);

		void fetch(url.toString(), {
			headers: {'User-Agent': 'Fluxerbot/1.0 (+https://fluxer.com)'},
		}).catch(() => {});
	}

	async resolveByUrl(params: {url: string; locale: string; country: string}): Promise<GifResponse | null> {
		const slug = this.extractSlugFromUrl(params.url);
		if (!slug) return null;
		const apiKey = await this.getApiKey();

		try {
			const queryParam = /^\d+$/.test(slug)
				? `ids=${encodeURIComponent(slug)}`
				: `slugs=${encodeURIComponent(slug)}`;
			const directUrl = `https://api.klipy.com/api/v1/${encodeURIComponent(apiKey)}/gifs/items?${queryParam}`;
			const response = await fetch(directUrl, {
				headers: {'User-Agent': 'Fluxerbot/1.0 (+https://fluxer.com)'},
			});
			if (response.ok) {
				const json = (await response.json()) as {data?: {data?: any[]}};
				const first = json?.data?.data?.[0];
				if (first) {
					return transformKlipyGif(first);
				}
			}
		} catch {}

		const results = await this.search({q: slug, locale: params.locale, country: params.country});
		return results[0] || null;
	}

	buildShareUrl(slug: string): string {
		return buildKlipyShareUrl(slug);
	}

	extractSlugFromUrl(url: string): string | null {
		return extractKlipySlugFromUrl(url);
	}
}
