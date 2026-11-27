// SPDX-License-Identifier: AGPL-3.0-or-later

const SAVED_BACKEND_ORIGIN_STORAGE_KEY = 'sync:backend:origin';
const BACKEND_QUERY_PARAMS = ['server', 'backend', 'api'] as const;

function defaultSchemeForHost(rawInput: string): string {
	const lower = rawInput.trim().toLowerCase();
	if (
		lower.startsWith('localhost') ||
		lower.startsWith('127.0.0.1') ||
		lower.startsWith('[::1]') ||
		lower.startsWith('0.0.0.0') ||
		/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(lower)
	) {
		return 'http://';
	}
	return 'https://';
}

export function normalizeBackendOrigin(rawInput: string | null | undefined): string | null {
	const trimmed = rawInput?.trim() ?? '';
	if (trimmed.length === 0) {
		return null;
	}
	const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
		? trimmed
		: `${defaultSchemeForHost(trimmed)}${trimmed}`;
	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return null;
	}
	if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password) {
		return null;
	}
	const normalizedPath = parsed.pathname.replace(/\/+$/u, '');
	if (normalizedPath && normalizedPath !== '/') {
		return `${parsed.origin}${normalizedPath}`;
	}
	return parsed.origin;
}

export function getBuildConfiguredBackendOrigin(): string | null {
	return normalizeBackendOrigin(import.meta.env?.SYNC_BACKEND_URL);
}

export function getSavedBackendOrigin(): string | null {
	if (typeof window === 'undefined') {
		return null;
	}
	try {
		return normalizeBackendOrigin(window.localStorage.getItem(SAVED_BACKEND_ORIGIN_STORAGE_KEY));
	} catch {
		return null;
	}
}

export function setSavedBackendOrigin(rawInput: string): string {
	const normalized = normalizeBackendOrigin(rawInput);
	if (normalized === null) {
		throw new Error('Enter a valid http:// or https:// SYNC server address.');
	}
	if (typeof window !== 'undefined') {
		try {
			window.localStorage.setItem(SAVED_BACKEND_ORIGIN_STORAGE_KEY, normalized);
		} catch {
			// Ignore storage quota / private mode failures cleanly
		}
	}
	return normalized;
}

export function clearSavedBackendOrigin(): void {
	if (typeof window === 'undefined') {
		return;
	}
	try {
		window.localStorage.removeItem(SAVED_BACKEND_ORIGIN_STORAGE_KEY);
	} catch {
		// Ignore storage access failures cleanly
	}
}

export function consumeBackendQueryOverride(): string | null {
	if (typeof window === 'undefined') {
		return null;
	}
	try {
		const url = new URL(window.location.href);
		for (const key of BACKEND_QUERY_PARAMS) {
			const candidate = url.searchParams.get(key);
			if (candidate != null && candidate.trim().length > 0) {
				const normalized = normalizeBackendOrigin(candidate);
				if (normalized !== null) {
					setSavedBackendOrigin(normalized);
					url.searchParams.delete(key);
					const nextUrl = `${url.pathname}${url.search}${url.hash}`;
					window.history.replaceState(window.history.state, '', nextUrl);
					return normalized;
				}
			}
		}
	} catch {
		// Ignore malformed location URLs
	}
	return null;
}

export function getConfiguredBackendOrigin(): string {
	if (typeof window === 'undefined') {
		throw new Error('Cannot resolve the SYNC server address: document is unavailable');
	}
	return (
		consumeBackendQueryOverride() ??
		getSavedBackendOrigin() ??
		getBuildConfiguredBackendOrigin() ??
		(() => {
			const documentUrl = new URL(window.location.href);
			if (documentUrl.protocol !== 'https:' && documentUrl.protocol !== 'http:') {
				throw new Error(`Unsupported document protocol "${documentUrl.protocol}"`);
			}
			return documentUrl.origin;
		})()
	);
}
