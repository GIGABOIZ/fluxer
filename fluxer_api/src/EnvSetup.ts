// SPDX-License-Identifier: AGPL-3.0-or-later

function setDefaultEnv(key: string, value: string): void {
	if (process.env[key] === undefined) {
		process.env[key] = value;
	}
}

function normalizeHttpOrigin(raw: string | undefined): string | null {
	const trimmed = raw?.trim();
	if (!trimmed) {
		return null;
	}
	const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(withScheme);
		if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
			return null;
		}
		return url.origin;
	} catch {
		return null;
	}
}

const detectedPort = process.env.PORT?.trim() || process.env.FLUXER_PORT?.trim() || '8080';
const detectedBackendOrigin =
	normalizeHttpOrigin(process.env.SYNC_BACKEND_URL) ??
	normalizeHttpOrigin(process.env.FLUXER_PUBLIC_ORIGIN) ??
	normalizeHttpOrigin(process.env.FLUXER_PUBLIC_URL) ??
	normalizeHttpOrigin(process.env.RAILWAY_PUBLIC_DOMAIN) ??
	normalizeHttpOrigin(process.env.RENDER_EXTERNAL_HOSTNAME) ??
	normalizeHttpOrigin(process.env.FLY_APP_NAME ? `${process.env.FLY_APP_NAME}.fly.dev` : undefined);
const detectedFrontendOrigin = normalizeHttpOrigin(process.env.SYNC_FRONTEND_URL);

// Initialize default environment variables before any Config modules are evaluated
setDefaultEnv('FLUXER_SELF_HOSTED', 'true');
setDefaultEnv('FLUXER_ENV', 'development');
setDefaultEnv('FLUXER_PORT', detectedPort);

if (detectedBackendOrigin) {
	const parsed = new URL(detectedBackendOrigin);
	const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
	const wsScheme = scheme === 'https' ? 'wss' : 'ws';
	const publicPort = parsed.port || (scheme === 'https' ? '443' : '80');
	const appBase = detectedFrontendOrigin ?? detectedBackendOrigin;

	setDefaultEnv('FLUXER_BASE_DOMAIN', parsed.hostname);
	setDefaultEnv('FLUXER_PUBLIC_SCHEME', scheme);
	setDefaultEnv('FLUXER_PUBLIC_PORT', publicPort);
	setDefaultEnv('FLUXER_PUBLIC_ORIGIN', detectedBackendOrigin);
	setDefaultEnv('FLUXER_API_ENDPOINT', `${detectedBackendOrigin}/api`);
	setDefaultEnv('FLUXER_API_CLIENT_ENDPOINT', `${detectedBackendOrigin}/api`);
	setDefaultEnv('FLUXER_GATEWAY_ENDPOINT', `${wsScheme}://${parsed.host}/gateway`);
	setDefaultEnv('FLUXER_MEDIA_ENDPOINT', `${detectedBackendOrigin}/media`);
	setDefaultEnv('FLUXER_MEDIA_PROXY_PUBLIC_ENDPOINT', `${detectedBackendOrigin}/media`);
	setDefaultEnv('FLUXER_MEDIA_PROXY_UPLOAD_RELAY_ENDPOINT', `${detectedBackendOrigin}/upload-relay`);
	setDefaultEnv('FLUXER_APP_ENDPOINT', appBase);
	setDefaultEnv('FLUXER_STATIC_CDN_ENDPOINT', appBase);
	setDefaultEnv('FLUXER_ADMIN_ENDPOINT', `${appBase}/admin`);
	setDefaultEnv('FLUXER_MARKETING_ENDPOINT', appBase);
	setDefaultEnv('FLUXER_INVITE_ENDPOINT', appBase);
	setDefaultEnv('FLUXER_GIFT_ENDPOINT', appBase);
	setDefaultEnv(
		'FLUXER_PASSKEY_ADDITIONAL_ALLOWED_ORIGINS',
		detectedFrontendOrigin ? `${detectedFrontendOrigin},${detectedBackendOrigin}` : detectedBackendOrigin,
	);
} else {
	setDefaultEnv('FLUXER_BASE_DOMAIN', 'localhost');
	setDefaultEnv('FLUXER_PUBLIC_SCHEME', 'http');
	setDefaultEnv('FLUXER_PUBLIC_PORT', '3000');
	setDefaultEnv('FLUXER_MEDIA_ENDPOINT', 'http://localhost:3000/media');
	setDefaultEnv('FLUXER_MEDIA_PROXY_PUBLIC_ENDPOINT', 'http://localhost:3000/media');
	setDefaultEnv('FLUXER_MEDIA_PROXY_UPLOAD_RELAY_ENDPOINT', 'http://localhost:3000/upload-relay');
	setDefaultEnv('FLUXER_PASSKEY_ADDITIONAL_ALLOWED_ORIGINS', 'http://localhost:3000');
}

setDefaultEnv('FLUXER_APP_PRODUCT_NAME', 'SYNC');
setDefaultEnv('FLUXER_TRUST_CLIENT_IP_HEADER', 'true');
setDefaultEnv('FLUXER_CLIENT_IP_HEADER_NAME', 'x-forwarded-for');
setDefaultEnv('FLUXER_CASSANDRA_HOSTS', '127.0.0.1');
setDefaultEnv('FLUXER_CASSANDRA_PORT', '9042');
setDefaultEnv('FLUXER_CASSANDRA_KEYSPACE', 'fluxer_dev');
setDefaultEnv('FLUXER_CASSANDRA_LOCAL_DC', 'datacenter1');
setDefaultEnv('FLUXER_CASSANDRA_USERNAME', 'cassandra');
setDefaultEnv('FLUXER_CASSANDRA_PASSWORD', 'cassandra');
setDefaultEnv('FLUXER_KV_URL', 'redis://127.0.0.1:6379/0');
setDefaultEnv('FLUXER_NATS_URL', 'nats://127.0.0.1:4222');
setDefaultEnv('FLUXER_NATS_CORE_URL', 'nats://127.0.0.1:4222');
setDefaultEnv('FLUXER_NATS_JETSTREAM_URL', 'nats://127.0.0.1:4222');
setDefaultEnv('FLUXER_INTERNAL_MEDIA_PROXY_ENDPOINT', `http://127.0.0.1:${detectedPort}/media`);
setDefaultEnv('FLUXER_S3_ENDPOINT', 'http://127.0.0.1:3900');
setDefaultEnv('FLUXER_S3_REGION', 'local');
setDefaultEnv('FLUXER_S3_ACCESS_KEY_ID', 'test');
setDefaultEnv('FLUXER_S3_SECRET_ACCESS_KEY', 'test');
setDefaultEnv('FLUXER_API_PRESIGNED_ATTACHMENT_UPLOADS_ENABLED', 'false');
setDefaultEnv('FLUXER_MEDIA_PROXY_SECRET_KEY', 'test-media-secret-32-chars-long!');
setDefaultEnv('FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64', 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=');
setDefaultEnv('FLUXER_MEDIA_PROXY_ATTACHMENT_URL_SECRETS_BASE64', 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=');
setDefaultEnv('FLUXER_ADMIN_SECRET_KEY_BASE', 'sync-dev-admin-secret-32-chars-!');
setDefaultEnv('FLUXER_ADMIN_OAUTH_CLIENT_SECRET', 'sync-dev-admin-oauth-secret-key!');
setDefaultEnv('FLUXER_GATEWAY_RPC_AUTH_TOKEN', 'test-gateway-rpc-token');
setDefaultEnv('FLUXER_SUDO_MODE_SECRET', 'test-sudo-mode-secret-32-chars!!');
setDefaultEnv('FLUXER_CONNECTION_INITIATION_SECRET', 'test-connection-initiation-sec!!');
setDefaultEnv('FLUXER_VAPID_PUBLIC_KEY', 'BB76bTFIuoqmxJtTfZX0yGTn1f_qu9H03B_nkj8OyExJFkN7Y-HBZZzShnHZoEhXKc5ZRy3jFu7OkBbnaQG-4aw');
setDefaultEnv('FLUXER_VAPID_PRIVATE_KEY', 'Xgi-3P8J-I3Q6U1HlCcXMuc_tKLGAM9nIfznX3Hz68o');
setDefaultEnv('FLUXER_VAPID_EMAIL', 'admin@sync.internal');
setDefaultEnv('FLUXER_PASSKEY_RP_NAME', 'SYNC');
setDefaultEnv('FLUXER_PASSKEY_RP_ID', detectedBackendOrigin ? new URL(detectedBackendOrigin).hostname : 'localhost');
setDefaultEnv('FLUXER_EMAIL_ENABLED', 'false');
setDefaultEnv('FLUXER_LIVEKIT_ENABLED', 'false');
setDefaultEnv('FLUXER_STRIPE_ENABLED', 'false');
setDefaultEnv('FLUXER_SEARCH_ENGINE', 'elasticsearch');
setDefaultEnv('FLUXER_SEARCH_URL', 'http://127.0.0.1:9200');
setDefaultEnv('FLUXER_SEARCH_API_KEY', 'test');
setDefaultEnv('FLUXER_KLIPY_API_KEY', 'WxTzDYYifUKkt4NmxzKicPV8lApQRgHC6lysQ5aVALpUmiWS0oK0gPCRJ59XMXVw');
setDefaultEnv('FLUXER_DISCOVERY_ENABLED', 'true');
setDefaultEnv('FLUXER_RELAX_REGISTRATION_RATE_LIMITS', 'true');
setDefaultEnv('FLUXER_DISABLE_RATE_LIMITS', 'true');
setDefaultEnv('FLUXER_TEST_MODE_ENABLED', 'true');
