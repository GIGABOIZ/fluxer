// SPDX-License-Identifier: AGPL-3.0-or-later

// MUST BE FIRST: Load environment variables before any Config module is evaluated
import './EnvSetup';

import { createServer } from '@fluxer/hono/src/Server';
import { createAPIApp } from './api/App';
import { initializeConfig } from './api/Config';
import { Config } from './Config';
import { initializeLogger } from './api/Logger';
import { Logger } from './Logger';
import { setCassandraQueryExecutorForTesting } from './api/database/CassandraQueryExecution';
import { PersistentDevQueryExecutor } from './api/database/PersistentDevQueryExecutor';
import { MockKVProvider } from '../pkgs/kv_client/src/testing/MockKVProvider';
import {
	setInjectedBlueskyOAuthService,
	setInjectedGatewayService,
	setInjectedKVProvider,
	setInjectedMediaService,
	setInjectedWorkerService,
} from './api/middleware/ServiceRegistry';
import {
	getGuildRepository,
	getInstanceConfigRepository,
	getUserRepository,
	setInjectedGifService,
	setInjectedStorageService,
	setInjectedUnfurlerService,
} from './api/middleware/ServiceSingletons';
import {
	mapGuildToGuildResponse,
	mapGuildRoleToResponse,
	mapGuildEmojiToResponse,
	mapGuildStickerToResponse,
} from './api/guild/GuildModel';
import { DevUnfurlerService } from './api/infrastructure/DevUnfurlerService';
import { DirectKlipyGifProvider } from './api/gif/DirectKlipyGifProvider';
import { CatboxStorageService } from './api/infrastructure/CatboxStorageService';
import { LocalStorageService } from './api/infrastructure/LocalStorageService';
import { MockStorageService } from './api/test/mocks/MockStorageService';
import { TestMediaService } from './api/test/TestMediaService';
import { NoopGatewayService } from './api/test/NoopGatewayService';
import { NoopWorkerService } from './api/test/NoopWorkerService';
import type { IWorkerService } from '@pkgs/worker/src/contracts/IWorkerService';
import fs from 'node:fs';
import https from 'node:https';
import { NoopUnfurlerService } from './api/test/mocks/NoopUnfurlerService';
import { MockBlueskyOAuthService } from './api/test/mocks/MockBlueskyOAuthService';
import { NoopOperatorPassWallPublisher } from './api/test/NoopOperatorPassWallPublisher';
import { InMemorySearchProvider } from './api/test/search/InMemorySearchProvider';
import { LimitConfigService } from './api/limits/LimitConfigService';
import { setInjectedSearchProvider } from './api/SearchFactory';
import { resetApiServicesForTesting } from './api/CreateApiContext';
import { AdminACLs } from '@fluxer/constants/src/AdminACLs';
import { AUTOMATIC_VOICE_REGION_ID } from '@fluxer/constants/src/ChannelConstants';
import { createUserID, createChannelID, createGuildID } from './api/BrandedTypes';
import type { CallData, CallCaller } from './api/infrastructure/IGatewayService';
import { hashPassword } from './api/utils/PasswordUtils';
import { EMPTY_USER_ROW, type UserRow } from './api/database/types/UserTypes';
import { setInjectedSnowflakeService } from './api/middleware/ServiceRegistry';
import { MockSnowflakeService } from './api/test/mocks/MockSnowflakeService';
import {
	type IUsersServiceClient,
	type AppAttestChallengeIssued,
	type AppAttestOutcome,
	type AppAttestAgeAccepted,
	setInjectedUsersServiceClient,
} from './api/infrastructure/UsersServiceClient';
import { setInjectedMessageResponseDataService } from './api/channel/services/message/MessageResponseDataService';
import { RepositoryBackedMessageResponseDataService } from './api/test/mocks/RepositoryBackedMessageResponseDataService';
import { ProfileFieldPrivacyFlags, UserFlags } from '@fluxer/constants/src/UserConstants';
import { mapUserToPartialResponse, mapUserToPrivateResponse, mapUserSettingsToResponse } from './api/user/UserMappers';
import { UserSettings as UserSettingsModel } from './api/models/UserSettings';
import type { UserPartialResponse } from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import type { GuildID, UserID } from './api/BrandedTypes';
import { mapChannelToResponse } from './api/channel/ChannelMappers';
import { getUserCacheService } from './api/middleware/ServiceSingletons';
import { createRequestCache } from './api/middleware/RequestCacheMiddleware';

class RepositoryBackedUsersServiceClient implements IUsersServiceClient {
	async getUserPartialResponses(userIds: Array<UserID>): Promise<Map<UserID, UserPartialResponse>> {
		const userRepository = getUserRepository();
		const result = new Map<UserID, UserPartialResponse>();
		for (const userId of userIds) {
			const user = await userRepository.findUnique(userId);
			if (user) {
				result.set(userId, mapUserToPartialResponse(user));
			}
		}
		return result;
	}

	async invalidateUserCache(_userId: UserID): Promise<void> {}

	async appAttestCreateChallenge(): Promise<AppAttestOutcome<AppAttestChallengeIssued>> {
		return {ok: false, code: 'not_configured'};
	}

	async appAttestRegisterKey(): Promise<AppAttestOutcome<true>> {
		return {ok: false, code: 'not_configured'};
	}

	async appAttestSubmitAge(): Promise<AppAttestOutcome<AppAttestAgeAccepted>> {
		return {ok: false, code: 'not_configured'};
	}
}

let searchProviderInstance: InMemorySearchProvider | null = null;

async function bootstrapDefaultAdmin() {
	try {
		const users = getUserRepository();
		const instanceConfig = getInstanceConfigRepository();
		
		const webAppBase = (process.env.SYNC_FRONTEND_URL || Config.endpoints.webApp || 'http://localhost:3000').replace(
			/\/+$/,
			'',
		);

		// Configure app branding to SYNC
		await instanceConfig.setAppPublicConfig({
			branding: {
				product_name: 'SYNC',
				premium_product_name: 'SYNC Pro',
				icon_url: `${webAppBase}/web/android-chrome-512x512.png`,
				symbol_url: `${webAppBase}/web/android-chrome-192x192.png`,
				logo_url: `${webAppBase}/web/android-chrome-512x512.png`,
				wordmark_url: null,
				favicon_url: `${webAppBase}/web/favicon-32x32.png`,
				favicon_dark_url: null,
				status_page_url: null,
				status_page_incident_history_url: null,
				premium_info_url: null,
				sign_in_backdrop_url: null,
				premium_showcase_expressions_url: null,
				premium_showcase_profile_url: null,
				premium_showcase_stream_url: null,
				premium_showcase_upload_url: null,
				theme_color: '#000000',
			},
			setup: {
				configured: true,
				admin_url: `${webAppBase}/admin`,
			},
			legal: {
				terms_url: `${webAppBase}/terms`,
				privacy_url: `${webAppBase}/privacy`,
			},
			registration: {
				collect_date_of_birth: false,
			},
		});

		// Check if administrative owner has already been bootstrapped
		const isAdminBootstrapped = await instanceConfig.isAdminBootstrapped();
		if (!isAdminBootstrapped) {
			Logger.info('[SYNC Backend] No administrative owner registered yet.');
			Logger.info(
				'[SYNC Backend] Secure First-Owner Setup: The first user to register on SYNC will automatically become the Instance Owner (WILDCARD Administrator).',
			);
		} else {
			Logger.info('[SYNC Backend] Instance is initialized with an existing administrative owner.');
		}
	} catch (err) {
		Logger.warn({ error: err }, '[SYNC Backend] Error during instance initialization check');
	}
}

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url || 'd:/fluxer/fluxer_api/package.json');
let WebSocketServer: any;
try {
	WebSocketServer = req('d:/fluxer/node_modules/.pnpm/ws@8.21.3/node_modules/ws').WebSocketServer;
} catch {
	try {
		WebSocketServer = req('ws').WebSocketServer;
	} catch {
		const wsPath = req.resolve('ws', { paths: ['d:/fluxer', 'd:/fluxer/node_modules/.pnpm/node_modules', 'd:/fluxer/fluxer_api'] });
		WebSocketServer = req(wsPath).WebSocketServer;
	}
}

interface StoredPresence {
	status: string;
	custom_status: any;
	afk: boolean;
	mobile: boolean;
}

const userSockets = new Map<string, Set<any>>();
const userPresences = new Map<string, StoredPresence>();

// Real-time Voice, Mesh WebRTC, and DM Calling State
const activeVoiceStates = new Map<string, Map<string, any>>(); // channelId -> Map<connectionId, VoiceState>
const connectionToChannel = new Map<string, { channelId: string; guildId: string | null; userId: string }>();
const userVoiceConnections = new Map<string, string>(); // userId -> connectionId
const activeCalls = new Map<string, CallData>(); // channelId -> CallData

function broadcastCallEvent(recipients: string[], event: string, data: any) {
	const payload = JSON.stringify({
		op: 0,
		s: 1,
		t: event,
		d: data,
	});
	for (const recipientId of recipients) {
		const sockets = userSockets.get(recipientId);
		if (sockets) {
			for (const sock of sockets) {
				try {
					if (sock.readyState === 1) {
						sock.send(payload);
						Logger.info({ recipientId, event }, '[Gateway] Dispatched call event to client');
					}
				} catch (e) {
					Logger.warn({ error: e }, '[Gateway] Failed to dispatch call event');
				}
			}
		}
	}
}

async function broadcastVoiceState(voiceState: any, guildId: string | null, channelId: string) {
	const payload = JSON.stringify({
		op: 0,
		s: 1,
		t: 'VOICE_STATE_UPDATE',
		d: voiceState,
	});

	if (guildId) {
		try {
			const guildRepo = getGuildRepository();
			const members = await guildRepo.listMembers(createGuildID(BigInt(guildId)));
			for (const m of members) {
				const mUserId = m.userId.toString();
				const sockets = userSockets.get(mUserId);
				if (sockets) {
					for (const sock of sockets) {
						if (sock.readyState === 1) sock.send(payload);
					}
				}
			}
		} catch (e) {
			Logger.warn({ error: e, guildId }, '[Gateway] Failed to broadcast voice state to guild');
		}
	} else {
		try {
			const { ChannelDataRepository } = await import('./api/channel/repositories/ChannelDataRepository');
			const channelRepo = new ChannelDataRepository();
			const ch = await channelRepo.findUnique(createChannelID(BigInt(channelId)));
			const recipientSet = new Set<string>();
			if (ch && ch.recipientIds) {
				for (const r of ch.recipientIds) recipientSet.add(r.toString());
			}
			const call = activeCalls.get(channelId);
			if (call && call.recipients) {
				for (const r of call.recipients) recipientSet.add(r);
			}
			for (const recipientId of recipientSet) {
				const sockets = userSockets.get(recipientId);
				if (sockets) {
					for (const sock of sockets) {
						if (sock.readyState === 1) sock.send(payload);
					}
				}
			}
		} catch (e) {
			Logger.warn({ error: e, channelId }, '[Gateway] Failed to broadcast voice state to DM');
		}
	}
}

function broadcastToAll(event: string, data: any) {
	const payload = JSON.stringify({
		op: 0,
		s: 1,
		t: event,
		d: data,
	});
	for (const [, sockets] of userSockets.entries()) {
		for (const sock of sockets) {
			try {
				if (sock.readyState === 1) { // OPEN
					sock.send(payload);
				}
			} catch {}
		}
	}
}

function broadcastPresence(
	userIdStr: string,
	status: string,
	customStatus: any = null,
	afk: boolean = false,
	mobile: boolean = false,
	partialUser?: any,
) {
	const payload = JSON.stringify({
		op: 0,
		s: 1,
		t: 'PRESENCE_UPDATE',
		d: {
			user: partialUser || { id: userIdStr },
			status,
			afk,
			mobile,
			custom_status: customStatus,
		},
	});
	for (const [targetUid, sockets] of userSockets.entries()) {
		if (targetUid === userIdStr) continue;
		for (const sock of sockets) {
			try {
				if (sock.readyState === 1) { // OPEN
					sock.send(payload);
				}
			} catch (e) {
				Logger.warn({ error: e }, '[Gateway] Failed to broadcast presence');
			}
		}
	}
}

function extractUrlsFromText(text: string): string[] {
	const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/gu;
	const matches = text.match(urlRegex);
	return matches ? [...new Set(matches)] : [];
}

class DevWorkerService implements IWorkerService {
	constructor(
		private readonly unfurler: DevUnfurlerService,
		private readonly persistentExecutor: PersistentDevQueryExecutor,
	) {}

	async addJob(taskName: string, payload: any): Promise<bigint> {
		if (taskName === 'extractEmbeds' && payload) {
			setImmediate(() => {
				void this.handleExtractEmbeds(payload);
			});
		}
		return 1n;
	}

	async cancelJob(_jobId: bigint): Promise<boolean> {
		return false;
	}

	private async handleExtractEmbeds(payload: { channelId: string; messageId: string }) {
		try {
			const state = this.persistentExecutor.exportState();
			const messagesTable = state.get('messages');
			if (!messagesTable) return;

			for (const [key, row] of messagesTable.entries()) {
				const rowMsgId = row.message_id?.value || row.message_id?.toString();
				if (rowMsgId === payload.messageId && typeof row.content === 'string') {
					const urls = extractUrlsFromText(row.content);
					if (urls.length === 0) return;
					const embeds: any[] = [];
					for (const url of urls) {
						const unfurlResult = await this.unfurler.unfurlWithCachePolicy(url);
						if (unfurlResult.embeds && unfurlResult.embeds.length > 0) {
							embeds.push(...unfurlResult.embeds);
						}
					}
					if (embeds.length > 0) {
						row.embeds = embeds;
						messagesTable.set(key, row);
						this.persistentExecutor.saveToDisk();
						Logger.info({ messageId: payload.messageId, count: embeds.length }, '[DevWorkerService] Unfurled and attached embeds');

						broadcastToAll('MESSAGE_UPDATE', {
							id: rowMsgId,
							channel_id: payload.channelId,
							embeds,
						});
					}
					break;
				}
			}
		} catch (err) {
			Logger.warn({ err }, '[DevWorkerService] Error handling extractEmbeds');
		}
	}
}

async function buildGuildReadyData(guildId: GuildID, userId: UserID): Promise<any> {
	const guildRepo = getGuildRepository();
	const guild = await guildRepo.findUnique(guildId);
	if (!guild) return null;

	const { ChannelDataRepository } = await import('./api/channel/repositories/ChannelDataRepository');
	const channelRepo = new ChannelDataRepository();
	const channels = await channelRepo.listGuildChannels(guildId, 'enrolled');

	const roles = await guildRepo.listRoles(guildId);
	const emojis = await guildRepo.listEmojis(guildId);
	const stickers = await guildRepo.listStickers(guildId);
	const members = await guildRepo.listMembers(guildId);
	const users = getUserRepository();

	const mappedChannels = channels.map((ch) => ({
		id: ch.id.toString(),
		guild_id: guildId.toString(),
		name: ch.name ?? 'general',
		type: ch.type,
		position: ch.position,
		parent_id: ch.parentId ? ch.parentId.toString() : null,
		topic: ch.topic ?? null,
		nsfw: ch.isNsfw ?? false,
		rate_limit_per_user: ch.rateLimitPerUser ?? 0,
		bitrate: ch.bitrate ?? 64000,
		user_limit: ch.userLimit ?? 0,
		permission_overwrites: [],
		flags: ch.flags ?? 0,
	}));

	const mappedRoles = roles.map(mapGuildRoleToResponse);
	const mappedEmojis = emojis.map(mapGuildEmojiToResponse);
	const mappedStickers = stickers.map(mapGuildStickerToResponse);

	const mappedMembers = await Promise.all(
		members.map(async (m) => {
			const u = await users.findUnique(m.userId);
			return {
				user: u ? mapUserToPartialResponse(u) : {
					id: m.userId.toString(),
					username: 'User',
					discriminator: '0000',
					global_name: null,
					avatar: null,
					avatar_color: null,
					bot: false,
					flags: 0,
				},
				nick: m.nick ?? null,
				avatar: m.avatarHash ?? null,
				roles: m.roleIds ? Array.from(m.roleIds).map((r) => r.toString()) : [],
				joined_at: m.joinedAt ? m.joinedAt.toISOString() : new Date().toISOString(),
				deaf: m.deaf ?? false,
				mute: m.mute ?? false,
				flags: m.profileFlags ?? 0,
				pending: false,
			};
		}),
	);

	const userMember = members.find((m) => m.userId.toString() === userId.toString());
	const joinedAt = userMember?.joinedAt ? userMember.joinedAt.toISOString() : new Date().toISOString();
	const guildProps = mapGuildToGuildResponse(guild);

	const guildMemberUserIds = new Set(members.map((m) => m.userId.toString()));
	const guildPresences: any[] = [];
	for (const [activeUid, sockets] of userSockets.entries()) {
		if (sockets.size > 0 && guildMemberUserIds.has(activeUid)) {
			const u = await users.findUnique(createUserID(BigInt(activeUid)));
			const pres = userPresences.get(activeUid) || {
				status: 'online',
				afk: false,
				mobile: false,
				custom_status: null,
			};
			guildPresences.push({
				user: u ? mapUserToPartialResponse(u) : { id: activeUid },
				status: pres.status,
				afk: pres.afk,
				mobile: pres.mobile,
				custom_status: pres.custom_status,
				guild_id: guildId.toString(),
			});
		}
	}

	return {
		id: guildId.toString(),
		properties: {
			...guildProps,
			id: guildId.toString(),
			name: guild.name,
			icon: guildProps.icon ?? null,
			roles: mappedRoles,
		},
		...guildProps,
		channels: mappedChannels,
		roles: mappedRoles,
		emojis: mappedEmojis,
		stickers: mappedStickers,
		members: mappedMembers,
		member_count: mappedMembers.length,
		joined_at: joinedAt,
		unavailable: false,
		threads: [],
		presences: guildPresences,
		voice_states: Array.from(activeVoiceStates.entries()).flatMap(([chId, channelStates]) => {
			const guildChannelIds = new Set(channels.map((ch) => ch.id.toString()));
			if (guildChannelIds.has(chId)) {
				return Array.from(channelStates.values());
			}
			return [];
		}),
	};
}

class DevGatewayService extends NoopGatewayService {
	override async getCall(channelId: ChannelID): Promise<CallData | null> {
		return activeCalls.get(channelId.toString()) ?? null;
	}

	override async createCall(
		channelId: ChannelID,
		messageId: string,
		region: string,
		ringing: Array<string>,
		recipients: Array<string>,
		caller?: CallCaller,
	): Promise<CallData> {
		const channelIdStr = channelId.toString();
		const call: CallData = {
			channel_id: channelIdStr,
			message_id: messageId,
			region: region || AUTOMATIC_VOICE_REGION_ID,
			ringing,
			recipients,
			voice_states: [],
		};
		activeCalls.set(channelIdStr, call);
		broadcastCallEvent(recipients, 'CALL_CREATE', {
			channel_id: channelIdStr,
			message_id: messageId,
			region: call.region,
			ringing,
			voice_states: [],
		});
		return call;
	}

	override async updateCallRegion(channelId: ChannelID, region: string | null): Promise<boolean> {
		const channelIdStr = channelId.toString();
		const call = activeCalls.get(channelIdStr);
		if (!call) return false;
		call.region = region ?? AUTOMATIC_VOICE_REGION_ID;
		broadcastCallEvent(call.recipients, 'CALL_UPDATE', {
			channel_id: call.channel_id,
			message_id: call.message_id,
			region: call.region,
			ringing: call.ringing,
			voice_states: call.voice_states,
		});
		return true;
	}

	override async ringCallRecipients(
		channelId: ChannelID,
		recipients: Array<string>,
		caller?: CallCaller,
	): Promise<boolean> {
		const channelIdStr = channelId.toString();
		const call = activeCalls.get(channelIdStr);
		if (!call) return false;
		const ringingSet = new Set(call.ringing);
		for (const r of recipients) ringingSet.add(r);
		call.ringing = Array.from(ringingSet);
		broadcastCallEvent(call.recipients, 'CALL_UPDATE', {
			channel_id: call.channel_id,
			message_id: call.message_id,
			region: call.region,
			ringing: call.ringing,
			voice_states: call.voice_states,
		});
		return true;
	}

	override async stopRingingCallRecipients(
		channelId: ChannelID,
		recipients: Array<string>,
	): Promise<boolean> {
		const channelIdStr = channelId.toString();
		const call = activeCalls.get(channelIdStr);
		if (!call) return false;
		if (!recipients || recipients.length === 0) {
			call.ringing = [];
		} else {
			const removeSet = new Set(recipients);
			call.ringing = call.ringing.filter((r) => !removeSet.has(r));
		}
		broadcastCallEvent(call.recipients, 'CALL_UPDATE', {
			channel_id: call.channel_id,
			message_id: call.message_id,
			region: call.region,
			ringing: call.ringing,
			voice_states: call.voice_states,
		});
		return true;
	}

	async endCall(channelId: ChannelID): Promise<void> {
		const channelIdStr = channelId.toString();
		const call = activeCalls.get(channelIdStr);
		if (call) {
			activeCalls.delete(channelIdStr);
			broadcastCallEvent(call.recipients, 'CALL_DELETE', { channel_id: channelIdStr });
		}
	}
	override async joinGuild(params: { userId: UserID; guildId: GuildID }): Promise<void> {
		await super.joinGuild(params);
		try {
			const guildReadyData = await buildGuildReadyData(params.guildId, params.userId);
			if (guildReadyData) {
				const userIdStr = params.userId.toString();
				const sockets = userSockets.get(userIdStr);
				if (sockets && sockets.size > 0) {
					const payload = JSON.stringify({
						op: 0,
						s: 1,
						t: 'GUILD_CREATE',
						d: guildReadyData,
					});
					for (const sock of sockets) {
						if (sock.readyState === 1) {
							sock.send(payload);
							Logger.info({ userId: userIdStr, guildId: params.guildId.toString() }, '[Gateway] Dispatched GUILD_CREATE to client');
						}
					}
				}
			}
		} catch (err) {
			Logger.warn({ error: err }, '[Gateway] Failed to dispatch GUILD_CREATE upon joinGuild');
		}
	}

	override async leaveGuild(params: { userId: UserID; guildId: GuildID }): Promise<void> {
		await super.leaveGuild(params);
		try {
			const userIdStr = params.userId.toString();
			const sockets = userSockets.get(userIdStr);
			if (sockets && sockets.size > 0) {
				const payload = JSON.stringify({
					op: 0,
					s: 1,
					t: 'GUILD_DELETE',
					d: { id: params.guildId.toString() },
				});
				for (const sock of sockets) {
					if (sock.readyState === 1) {
						sock.send(payload);
						Logger.info({ userId: userIdStr, guildId: params.guildId.toString() }, '[Gateway] Dispatched GUILD_DELETE to client');
					}
				}
			}
		} catch (err) {
			Logger.warn({ error: err }, '[Gateway] Failed to dispatch GUILD_DELETE upon leaveGuild');
		}
	}

	override async dispatchPresence(params: { userId: UserID; event: any; data: unknown }): Promise<void> {
		const userIdStr = params.userId.toString();
		const sockets = userSockets.get(userIdStr);
		if (sockets && sockets.size > 0) {
			const payload = JSON.stringify({
				op: 0,
				s: 1,
				t: params.event,
				d: params.data,
			});
			for (const sock of sockets) {
				try {
					if (sock.readyState === 1) { // OPEN
						sock.send(payload);
						Logger.info({ userId: userIdStr, event: params.event }, '[Gateway] Dispatched real-time event to client');
					}
				} catch (e) {
					Logger.warn({ error: e }, '[Gateway] Failed to dispatch event to socket');
				}
			}
		}
	}

	override async dispatchGuild(params: { guildId: GuildID; event: any; data: unknown }): Promise<void> {
		const payload = JSON.stringify({
			op: 0,
			s: 1,
			t: params.event,
			d: params.data,
		});
		for (const [userId, sockets] of userSockets.entries()) {
			for (const sock of sockets) {
				try {
					if (sock.readyState === 1) { // OPEN
						sock.send(payload);
						Logger.info({ userId, event: params.event }, '[Gateway] Dispatched guild event to client');
					}
				} catch (e) {
					Logger.warn({ error: e }, '[Gateway] Failed to dispatch guild event to socket');
				}
			}
		}
	}
}

function setupGatewayWebSocket(httpServer: any) {
	const wss = new WebSocketServer({ server: httpServer, path: '/gateway' });
	wss.on('connection', (ws: any) => {
		Logger.info('[Gateway] Client connected to WebSocket');
		let currentIdentifiedUserId: string | null = null;

		// 1. Send HELLO
		ws.send(JSON.stringify({
			op: 10,
			d: {
				heartbeat_interval: 41250,
			},
		}));

		ws.on('message', async (raw: any) => {
			try {
				const payload = JSON.parse(raw.toString());
				if (payload.op === 1) { // HEARTBEAT
					ws.send(JSON.stringify({ op: 11 }));
				} else if (payload.op === 2) { // IDENTIFY
					const token = payload.d?.token;
					if (!token) {
						ws.close(4004, 'Authentication failed');
						return;
					}
					const tokenHash = Buffer.from(crypto.createHash('sha256').update(token).digest());
					const users = getUserRepository();
					const session = await users.getAuthSessionByToken(tokenHash);
					let user = session ? await users.findUnique(session.userId) : null;
					if (!user) {
						Logger.warn('[Gateway] Invalid token during IDENTIFY');
						ws.close(4004, 'Authentication failed');
						return;
					}

					// Ensure HAS_SESSION_STARTED flag is set
					if (!(user.flags & UserFlags.HAS_SESSION_STARTED)) {
						try {
							const updated = await users.updateFlags(user.id, (flags) => flags | UserFlags.HAS_SESSION_STARTED);
							if (updated) user = updated;
						} catch (e) {
							Logger.warn({ error: e }, '[Gateway] Failed to update HAS_SESSION_STARTED flag');
						}
					}

					currentIdentifiedUserId = user.id.toString();
					let socketSet = userSockets.get(currentIdentifiedUserId);
					if (!socketSet) {
						socketSet = new Set();
						userSockets.set(currentIdentifiedUserId, socketSet);
					}
					socketSet.add(ws);

					userPresences.set(currentIdentifiedUserId, {
						status: 'online',
						custom_status: null,
						afk: false,
						mobile: false,
					});

					Logger.info({ username: user.username, userId: user.id.toString() }, '[Gateway] User IDENTIFIED, dispatching READY');
					let settings = await users.findSettings(user.id);
					if (!settings) {
						const defaultRow = UserSettingsModel.getDefaultUserSettings({
							userId: user.id,
							locale: (user.locale as any) ?? 'en-US',
							isAdult: true,
							theme: 'dark' as any,
						});
						try {
							settings = await users.upsertSettings(defaultRow);
						} catch {
							settings = new UserSettingsModel(defaultRow);
						}
					}
					const userSettingsResponse = mapUserSettingsToResponse({ settings });
					const userPrivate = mapUserToPrivateResponse(user);

					// Load actual relationships for user
					const userRelationships = await users.listRelationships(user.id);
					const additionalUsers: any[] = [];
					const mappedRelationships = await Promise.all(
						userRelationships.map(async (rel) => {
							const targetUser = await users.findUnique(rel.targetUserId);
							const userPartial = targetUser
								? mapUserToPartialResponse(targetUser)
								: {
										id: rel.targetUserId.toString(),
										username: 'User',
										discriminator: '0000',
										global_name: null,
										avatar: null,
										avatar_color: null,
										bot: false,
										flags: 0,
									};
							if (userPartial) {
								additionalUsers.push(userPartial);
							}
							return {
								id: rel.targetUserId.toString(),
								type: rel.type,
								user: userPartial,
								since: rel.since ? rel.since.toISOString() : new Date().toISOString(),
								nickname: rel.nickname,
								share_voice_activity: rel.shareVoiceActivity ?? true,
								friend_shares_voice_activity: true,
							};
						}),
					);

					// Load and map private channels (DMs)
					const userPrivateChannels = await users.listPrivateChannels(user.id);
					const userCacheService = getUserCacheService();
					const requestCache = createRequestCache();
					const mappedPrivateChannels = (
						await Promise.all(
							userPrivateChannels.map(async (channel) => {
								try {
									const mapped = await mapChannelToResponse({
										channel,
										currentUserId: user.id,
										userCacheService,
										requestCache,
									});
									if (mapped.recipients) {
										for (const r of mapped.recipients) {
											if (!additionalUsers.some((u) => u.id === r.id)) {
												additionalUsers.push(r);
											}
										}
									}
									return mapped;
								} catch (e) {
									Logger.warn({ error: e, channelId: channel.id.toString() }, '[Gateway] Error mapping private channel');
									return null;
								}
							}),
						)
					).filter(Boolean);

					// Build active presences of currently connected users
					const activePresences: any[] = [];
					for (const [activeUid, sockets] of userSockets.entries()) {
						if (sockets.size > 0) {
							const u = await users.findUnique(createUserID(BigInt(activeUid)));
							const pres = userPresences.get(activeUid) || {
								status: 'online',
								afk: false,
								mobile: false,
								custom_status: null,
							};
							const partial = u ? mapUserToPartialResponse(u) : { id: activeUid };
							activePresences.push({
								user: partial,
								status: pres.status,
								afk: pres.afk,
								mobile: pres.mobile,
								custom_status: pres.custom_status,
							});
						}
					}

					const guildRepo = getGuildRepository();
					const userGuildList = await guildRepo.listUserGuilds(user.id);
					const mappedGuilds = (
						await Promise.all(
							userGuildList.map(async (g) => {
								try {
									return await buildGuildReadyData(g.id, user.id);
								} catch (e) {
									Logger.warn({ error: e, guildId: g.id.toString() }, '[Gateway] Error mapping guild for READY');
									return null;
								}
							}),
						)
					).filter(Boolean);

					const mappedGuildSettings = userGuildList.map((g) => ({
						guild_id: g.id.toString(),
						suppress_everyone: false,
						suppress_roles: false,
						muted: false,
						mute_config: null,
						message_notifications: 0,
						mobile_push: true,
						flags: 0,
						channel_overrides: [],
					}));

					const readyPayload = {
						op: 0,
						s: 1,
						t: 'READY',
						d: {
							v: 1,
							session_id: 'sync_sess_' + user.id.toString(),
							guilds: mappedGuilds,
							user: userPrivate,
							private_channels: mappedPrivateChannels,
							relationships: mappedRelationships,
							users: additionalUsers,
							read_states: [],
							user_settings: userSettingsResponse,
							user_guild_settings: mappedGuildSettings,
							notes: {},
							presences: activePresences,
							country_code: 'US',
							pinned_dms: [],
							favorite_memes: [],
							rtc_regions: [],
							auth_session_id_hash: tokenHash.toString('hex'),
						},
					};
					ws.send(JSON.stringify(readyPayload));

					// Broadcast user's online presence to all other connected clients
					broadcastPresence(
						currentIdentifiedUserId,
						'online',
						null,
						false,
						false,
						mapUserToPartialResponse(user),
					);
					// Sync any active calls where this user is a participant or ringing recipient
					for (const call of activeCalls.values()) {
						if (call.recipients.includes(user.id.toString())) {
							ws.send(JSON.stringify({
								op: 0,
								s: 1,
								t: 'CALL_CREATE',
								d: {
									channel_id: call.channel_id,
									message_id: call.message_id,
									region: call.region,
									ringing: call.ringing,
									voice_states: call.voice_states,
								},
							}));
						}
					}
				} else if (payload.op === 3) { // PRESENCE_UPDATE from client
					if (currentIdentifiedUserId) {
						const d = payload.d || {};
						const status = d.status || 'online';
						const afk = !!d.afk;
						const mobile = !!d.mobile;
						const customStatus = d.custom_status ?? null;
						userPresences.set(currentIdentifiedUserId, {
							status,
							custom_status: customStatus,
							afk,
							mobile,
						});
						const users = getUserRepository();
						const u = await users.findUnique(createUserID(BigInt(currentIdentifiedUserId)));
						broadcastPresence(
							currentIdentifiedUserId,
							status,
							customStatus,
							afk,
							mobile,
							u ? mapUserToPartialResponse(u) : { id: currentIdentifiedUserId },
						);
					}
				} else if (payload.op === 4) { // VOICE_STATE_UPDATE
					if (!currentIdentifiedUserId) return;
					const d = payload.d || {};
					const guildId = d.guild_id ? d.guild_id.toString() : null;
					const channelId = d.channel_id ? d.channel_id.toString() : null;

					let connectionId = d.connection_id || userVoiceConnections.get(currentIdentifiedUserId);
					if (!connectionId) {
						connectionId = `conn_${currentIdentifiedUserId}_${Date.now()}`;
					}
					userVoiceConnections.set(currentIdentifiedUserId, connectionId);

					const prevChannel = connectionToChannel.get(connectionId);

					// Disconnect from previous channel if moving or disconnecting
					if (prevChannel && prevChannel.channelId !== channelId) {
						const prevStates = activeVoiceStates.get(prevChannel.channelId);
						if (prevStates) {
							prevStates.delete(connectionId);
							if (prevStates.size === 0) {
								activeVoiceStates.delete(prevChannel.channelId);
							}
						}
						connectionToChannel.delete(connectionId);

						const leaveVoiceState = {
							guild_id: prevChannel.guildId,
							channel_id: null,
							user_id: currentIdentifiedUserId,
							connection_id: connectionId,
							session_id: 'sync_sess_' + currentIdentifiedUserId,
							deaf: true,
							mute: true,
							self_deaf: true,
							self_mute: true,
							self_video: false,
							self_stream: false,
							suppress: false,
						};

						await broadcastVoiceState(leaveVoiceState, prevChannel.guildId, prevChannel.channelId);

						const prevCall = activeCalls.get(prevChannel.channelId);
						if (prevCall) {
							prevCall.voice_states = prevCall.voice_states.filter(
								(vs: any) => vs.user_id !== currentIdentifiedUserId,
							);
							if (prevCall.voice_states.length === 0 && prevCall.ringing.length === 0) {
								activeCalls.delete(prevChannel.channelId);
								broadcastCallEvent(prevCall.recipients, 'CALL_DELETE', { channel_id: prevChannel.channelId });
							} else {
								broadcastCallEvent(prevCall.recipients, 'CALL_UPDATE', {
									channel_id: prevCall.channel_id,
									message_id: prevCall.message_id,
									region: prevCall.region,
									ringing: prevCall.ringing,
									voice_states: prevCall.voice_states,
								});
							}
						}
					}

					if (channelId) {
						connectionToChannel.set(connectionId, {
							channelId,
							guildId,
							userId: currentIdentifiedUserId,
						});

						const users = getUserRepository();
						const userObj = await users.findUnique(createUserID(BigInt(currentIdentifiedUserId)));

						let guildMember: any = undefined;
						if (guildId) {
							try {
								const guildRepo = getGuildRepository();
								const member = await guildRepo.getMember(
									createGuildID(BigInt(guildId)),
									createUserID(BigInt(currentIdentifiedUserId)),
								);
								if (member && userObj) {
									guildMember = {
										user: mapUserToPartialResponse(userObj),
										nick: member.nick ?? null,
										avatar: member.avatarHash ?? null,
										roles: member.roleIds ? Array.from(member.roleIds).map((r) => r.toString()) : [],
										joined_at: member.joinedAt ? member.joinedAt.toISOString() : new Date().toISOString(),
										deaf: member.deaf ?? false,
										mute: member.mute ?? false,
										flags: member.profileFlags ?? 0,
										pending: false,
									};
								}
							} catch {}
						}

						const voiceState = {
							guild_id: guildId,
							channel_id: channelId,
							user_id: currentIdentifiedUserId,
							connection_id: connectionId,
							session_id: 'sync_sess_' + currentIdentifiedUserId,
							deaf: !!d.self_deaf,
							mute: !!d.self_mute,
							self_deaf: !!d.self_deaf,
							self_mute: !!d.self_mute,
							self_video: !!d.self_video,
							self_stream: !!d.self_stream,
							suppress: false,
							request_to_speak_timestamp: null,
							p2p: true,
							member: guildMember,
						};

						let channelStates = activeVoiceStates.get(channelId);
						if (!channelStates) {
							channelStates = new Map();
							activeVoiceStates.set(channelId, channelStates);
						}
						channelStates.set(connectionId, voiceState);

						// 1. Send VOICE_SERVER_UPDATE to client
						ws.send(JSON.stringify({
							op: 0,
							s: 1,
							t: 'VOICE_SERVER_UPDATE',
							d: {
								p2p: true,
								connection_id: connectionId,
								guild_id: guildId || undefined,
								channel_id: channelId,
								ice_servers: [
									{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
								],
							},
						}));

						// 2. Send all existing participants' voice states to this connecting client
						for (const [otherConnId, otherState] of channelStates.entries()) {
							if (otherConnId !== connectionId) {
								ws.send(JSON.stringify({
									op: 0,
									s: 1,
									t: 'VOICE_STATE_UPDATE',
									d: otherState,
								}));
							}
						}

						// 3. Broadcast this user's voice state to all other participants
						await broadcastVoiceState(voiceState, guildId, channelId);

						// 4. Update DM call if channel has an active call
						const activeCall = activeCalls.get(channelId);
						if (activeCall) {
							activeCall.ringing = activeCall.ringing.filter((r) => r !== currentIdentifiedUserId);
							const existingVsIndex = activeCall.voice_states.findIndex(
								(vs: any) => vs.user_id === currentIdentifiedUserId,
							);
							const callVs = {
								user_id: currentIdentifiedUserId,
								session_id: 'sync_sess_' + currentIdentifiedUserId,
								mute: !!d.self_mute,
								deaf: !!d.self_deaf,
								self_mute: !!d.self_mute,
								self_deaf: !!d.self_deaf,
								self_video: !!d.self_video,
								self_stream: !!d.self_stream,
								suppress: false,
							};
							if (existingVsIndex >= 0) {
								activeCall.voice_states[existingVsIndex] = callVs;
							} else {
								activeCall.voice_states.push(callVs);
							}
							broadcastCallEvent(activeCall.recipients, 'CALL_UPDATE', {
								channel_id: activeCall.channel_id,
								message_id: activeCall.message_id,
								region: activeCall.region,
								ringing: activeCall.ringing,
								voice_states: activeCall.voice_states,
							});
						}
					}
				} else if (payload.op === 13) { // VOICE_SIGNAL
					if (!currentIdentifiedUserId) return;
					const d = payload.d || {};
					const target = d.to;
					if (!target) return;

					const senderConnectionId = userVoiceConnections.get(currentIdentifiedUserId) || `conn_${currentIdentifiedUserId}`;

					let targetUserId: string | null = null;
					const targetConnMeta = connectionToChannel.get(target);
					if (targetConnMeta) {
						targetUserId = targetConnMeta.userId;
					} else if (userSockets.has(target)) {
						targetUserId = target;
					}

					if (targetUserId) {
						const sockets = userSockets.get(targetUserId);
						if (sockets) {
							const signalPayload = JSON.stringify({
								op: 0,
								s: 1,
								t: 'VOICE_SIGNAL',
								d: {
									guild_id: d.guild_id || undefined,
									channel_id: d.channel_id,
									from: senderConnectionId,
									user_id: currentIdentifiedUserId,
									data: d.data,
								},
							});
							for (const sock of sockets) {
								if (sock.readyState === 1) {
									sock.send(signalPayload);
								}
							}
						}
					}
				}
			} catch (err) {
				Logger.warn({ error: err }, '[Gateway] Error processing gateway message');
			}
		});

		ws.on('close', async (code: number, reason: any) => {
			if (currentIdentifiedUserId) {
				const currentSet = userSockets.get(currentIdentifiedUserId);
				if (currentSet) {
					currentSet.delete(ws);
					if (currentSet.size === 0) {
						userSockets.delete(currentIdentifiedUserId);
						userPresences.delete(currentIdentifiedUserId);
						broadcastPresence(currentIdentifiedUserId, 'offline');
						Logger.info({ userId: currentIdentifiedUserId }, '[Gateway] User went offline');
					}
				}

				// Clean up any voice connection for this socket if no other socket is open for this user
				const remainingSockets = userSockets.get(currentIdentifiedUserId);
				if (!remainingSockets || remainingSockets.size === 0) {
					const connId = userVoiceConnections.get(currentIdentifiedUserId);
					if (connId) {
						const connMeta = connectionToChannel.get(connId);
						if (connMeta) {
							const prevStates = activeVoiceStates.get(connMeta.channelId);
							if (prevStates) {
								prevStates.delete(connId);
								if (prevStates.size === 0) activeVoiceStates.delete(connMeta.channelId);
							}
							connectionToChannel.delete(connId);

							const leaveVoiceState = {
								guild_id: connMeta.guildId,
								channel_id: null,
								user_id: currentIdentifiedUserId,
								connection_id: connId,
								session_id: 'sync_sess_' + currentIdentifiedUserId,
								deaf: true,
								mute: true,
								self_deaf: true,
								self_mute: true,
								self_video: false,
								self_stream: false,
								suppress: false,
							};
							await broadcastVoiceState(leaveVoiceState, connMeta.guildId, connMeta.channelId);

							const activeCall = activeCalls.get(connMeta.channelId);
							if (activeCall) {
								activeCall.voice_states = activeCall.voice_states.filter(
									(vs: any) => vs.user_id !== currentIdentifiedUserId,
								);
								if (activeCall.voice_states.length === 0 && activeCall.ringing.length === 0) {
									activeCalls.delete(connMeta.channelId);
									broadcastCallEvent(activeCall.recipients, 'CALL_DELETE', { channel_id: connMeta.channelId });
								} else {
									broadcastCallEvent(activeCall.recipients, 'CALL_UPDATE', {
										channel_id: activeCall.channel_id,
										message_id: activeCall.message_id,
										region: activeCall.region,
										ringing: activeCall.ringing,
										voice_states: activeCall.voice_states,
									});
								}
							}
						}
						userVoiceConnections.delete(currentIdentifiedUserId);
					}
				}
			}
			Logger.info({ code, reason: reason?.toString() }, '[Gateway] Client disconnected');
		});
	});
	Logger.info('[Gateway] WebSocket server attached to /gateway');
}

async function start() {
	Config.dev.testModeEnabled = true;
	initializeConfig(Config);
	initializeLogger(Logger);

	resetApiServicesForTesting();
	const persistentExecutor = new PersistentDevQueryExecutor();
	setCassandraQueryExecutorForTesting(persistentExecutor);

	const kvProvider = new MockKVProvider();
	setInjectedKVProvider(kvProvider);

	const limitConfigService = new LimitConfigService(null as any, null as any, null);
	limitConfigService.setAsGlobalInstance();

	setInjectedGatewayService(new DevGatewayService());

	const devUnfurler = new DevUnfurlerService();
	setInjectedUnfurlerService(devUnfurler);

	const devWorkerService = new DevWorkerService(devUnfurler, persistentExecutor);
	setInjectedWorkerService(devWorkerService);

	setInjectedSnowflakeService(new MockSnowflakeService());
	setInjectedUsersServiceClient(new RepositoryBackedUsersServiceClient());
	setInjectedMessageResponseDataService(new RepositoryBackedMessageResponseDataService());

	const storageService = new CatboxStorageService();
	setInjectedStorageService(storageService);

	const mediaService = new TestMediaService(storageService);
	setInjectedMediaService(mediaService);

function decodeExternalMediaProxyPath(rawPath: string): string | null {
	const withoutPrefix = rawPath.replace(/^external\//, '');
	const slashIndex = withoutPrefix.indexOf('/');
	if (slashIndex === -1) return null;
	const proxyPath = withoutPrefix.slice(slashIndex + 1);
	if (proxyPath.startsWith('v2/')) {
		const b64 = proxyPath.slice(3);
		return Buffer.from(b64, 'base64url').toString('utf8');
	}
	const parts = proxyPath.split('/');
	let protocolIndex = -1;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === 'http' || part === 'https') {
			protocolIndex = i;
			break;
		}
	}
	if (protocolIndex === -1 || protocolIndex + 1 >= parts.length) return null;
	const protocol = parts[protocolIndex];
	const host = decodeURIComponent(parts[protocolIndex + 1]);
	const queryRaw = parts.slice(0, protocolIndex).join('/');
	const pathRaw = parts.slice(protocolIndex + 2).map((s) => decodeURIComponent(s)).join('/');
	let query = queryRaw ? decodeURIComponent(queryRaw) : '';
	if (query && !query.startsWith('?')) query = '?' + query;
	return `${protocol}://${host}${pathRaw ? '/' + pathRaw : ''}${query}`;
}

async function backfillKlipyEmbeds(
	persistentExecutor: PersistentDevQueryExecutor,
	unfurler: DevUnfurlerService,
) {
	try {
		const state = persistentExecutor.exportState();
		const messagesTable = state.get('messages');
		if (!messagesTable) return;
		let updatedCount = 0;
		for (const [key, row] of messagesTable.entries()) {
			if (
				typeof row.content === 'string' &&
				row.content.includes('klipy.com') &&
				(!row.embeds || row.embeds.length === 0)
			) {
				const urls = [row.content.trim()];
				const unfurlResult = await unfurler.unfurlWithCachePolicy(urls[0]);
				if (unfurlResult.embeds && unfurlResult.embeds.length > 0) {
					row.embeds = unfurlResult.embeds.map((e) => ({
						type: e.type ?? null,
						title: e.title ?? null,
						description: e.description ?? null,
						url: e.url ?? null,
						timestamp: null,
						color: null,
						author: null,
						provider: e.provider ? { name: e.provider.name, url: e.provider.url } : null,
						thumbnail: e.thumbnail
							? {
									url: e.thumbnail.url,
									proxy_url: e.thumbnail.proxy_url,
									width: e.thumbnail.width,
									height: e.thumbnail.height,
									description: null,
									content_type: e.thumbnail.content_type || 'image/gif',
									content_hash: null,
									placeholder: null,
									flags: 0,
									duration: null,
								}
							: null,
						image: null,
						video: e.video
							? {
									url: e.video.url,
									proxy_url: e.video.proxy_url,
									width: e.video.width,
									height: e.video.height,
									description: null,
									content_type: e.video.content_type || 'video/mp4',
									content_hash: null,
									placeholder: null,
									flags: 0,
									duration: null,
								}
							: null,
						footer: null,
						fields: null,
						nsfw: false,
					}));
					messagesTable.set(key, row);
					updatedCount++;
					Logger.info({ messageId: row.message_id?.toString() }, '[Backfill] Backfilled Klipy embed for message');
				}
			}
		}
		if (updatedCount > 0) {
			persistentExecutor.saveToDisk();
		}
	} catch (err) {
		Logger.warn({ error: err }, '[Backfill] Failed to backfill Klipy embeds');
	}
}

	searchProviderInstance = new InMemorySearchProvider();
	setInjectedSearchProvider(searchProviderInstance);

	setInjectedBlueskyOAuthService(new MockBlueskyOAuthService());
	setInjectedGifService(
		new DirectKlipyGifProvider(async () => {
			const instanceConfig = getInstanceConfigRepository();
			const configKey = (await instanceConfig.getEffectiveGifConfig()).klipy_api_key;
			return (
				configKey ||
				process.env.FLUXER_KLIPY_API_KEY ||
				'WxTzDYYifUKkt4NmxzKicPV8lApQRgHC6lysQ5aVALpUmiWS0oK0gPCRJ59XMXVw'
			);
		}),
	);

	const configuredCorsOrigins = new Set<string>([
		...Config.endpoints.webAppOrigins,
		Config.endpoints.marketing,
		...(process.env.SYNC_FRONTEND_URL ? [process.env.SYNC_FRONTEND_URL.replace(/\/+$/, '')] : []),
		...(process.env.SYNC_CORS_ORIGINS ?? '')
			.split(',')
			.map((origin) => origin.trim().replace(/\/+$/, ''))
			.filter(Boolean),
	]);
	const allowAllCors = process.env.SYNC_CORS_ALLOW_ALL === 'true';
	const corsOriginMatcher = allowAllCors
		? ('*' as const)
		: (origin: string) =>
				configuredCorsOrigins.has(origin) ||
				/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin) ||
				/^https:\/\/sync-app(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(origin);

	const { app, initialize } = await createAPIApp({
		config: Config,
		logger: Logger,
		corsOrigins: corsOriginMatcher,
		mountApiPrefix: true,
		operatorPassWallPublisher: new NoopOperatorPassWallPublisher(),
	});

	// Upload relay routes for instant local uploads
	app.options('/upload-relay/*', (c) => {
		c.header('Access-Control-Allow-Origin', '*');
		c.header('Access-Control-Allow-Methods', 'PUT, POST, GET, OPTIONS');
		c.header('Access-Control-Allow-Headers', '*');
		return c.text('', 204 as any);
	});

	app.on(['PUT', 'POST'], '/upload-relay/*', async (c) => {
		c.header('Access-Control-Allow-Origin', '*');
		c.header('Access-Control-Allow-Methods', 'PUT, POST, GET, OPTIONS');
		c.header('Access-Control-Allow-Headers', '*');
		const rawPath = c.req.path.replace(/^\/upload-relay\//, '');
		const slashIndex = rawPath.indexOf('/');
		if (slashIndex === -1) return c.text('Invalid path', 400);
		const bucket = rawPath.slice(0, slashIndex);
		const key = rawPath.slice(slashIndex + 1);
		const bodyBuf = Buffer.from(await c.req.arrayBuffer());
		const contentType = c.req.header('content-type') || 'application/octet-stream';

		const uploadId = c.req.query('uploadId');
		const partNumberStr = c.req.query('partNumber');
		if (uploadId && partNumberStr) {
			const partNumber = parseInt(partNumberStr, 10);
			if (typeof (storageService as any).uploadPart === 'function') {
				const etag = await (storageService as any).uploadPart({ bucket, key, uploadId, partNumber, body: bodyBuf });
				c.header('ETag', etag);
				return c.text('OK', 200);
			}
		}

		await storageService.uploadObject({ bucket, key, body: bodyBuf, contentType });
		Logger.info({ bucket, key, size: bodyBuf.length }, '[Catbox Cloud Storage] Uploaded to cloud (0 bytes on PC)');
		return c.text('OK', 200);
	});

	// External Media Proxy & Storage Streaming routes
	app.options('/media/*', (c) => {
		c.header('Access-Control-Allow-Origin', '*');
		c.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
		c.header('Access-Control-Allow-Headers', '*');
		return c.text('', 204 as any);
	});

	app.on(['GET', 'HEAD'], '/media/*', async (c) => {
		const rawPath = c.req.path.replace(/^\/media\//, '');

		// Handle external signed media (e.g. Klipy GIFs, unfurled previews)
		if (rawPath.startsWith('external/')) {
			const originalUrl = decodeExternalMediaProxyPath(rawPath);
			if (!originalUrl) {
				return c.text('Invalid external media proxy path', 400);
			}

			if (c.req.query('redirect') === 'true') {
				return c.redirect(originalUrl, 302);
			}

			try {
				const range = c.req.header('range');
				const headers: Record<string, string> = {
					'User-Agent': 'curl/8.4.0',
					'Accept': '*/*',
				};
				if (range) headers['Range'] = range;

				const upstream = await fetch(originalUrl, { headers });
				c.header('Access-Control-Allow-Origin', '*');
				c.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
				c.header('Cache-Control', 'public, max-age=86400, immutable');
				c.header('X-Direct-Url', originalUrl);

				const ct = upstream.headers.get('content-type');
				if (ct) c.header('Content-Type', ct);
				const cl = upstream.headers.get('content-length');
				if (cl) c.header('Content-Length', cl);
				const cr = upstream.headers.get('content-range');
				if (cr) c.header('Content-Range', cr);
				const ar = upstream.headers.get('accept-ranges');
				if (ar) c.header('Accept-Ranges', ar);

				c.status(upstream.status as any);
				return c.body(upstream.body as any);
			} catch (err) {
				Logger.warn({ err, originalUrl }, '[Dev External Media Proxy] Upstream fetch failed, redirecting');
				return c.redirect(originalUrl, 302);
			}
		}

		// 1. Check in-memory RAM cache first (instant 0ms delivery without touching disk)
		if (typeof (storageService as any).getInMemoryBuffer === 'function') {
			const ramItem = (storageService as any).getInMemoryBuffer(rawPath);
			if (ramItem) {
				const totalSize = ramItem.buffer.length;
				c.header('Access-Control-Allow-Origin', '*');
				c.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
				c.header('Accept-Ranges', 'bytes');
				c.header('Cache-Control', 'public, max-age=31536000, immutable');
				c.header('X-Storage-Engine', 'Cloud-RAM-Cache');
				const inferredCt = storageService.inferMimeType(rawPath);
				const ct = (inferredCt && inferredCt !== 'application/octet-stream')
					? inferredCt
					: (ramItem.contentType || 'image/jpeg');
				c.header('Content-Type', ct);

				if (c.req.method === 'HEAD') {
					c.header('Content-Length', totalSize.toString());
					return c.text('', 200 as any);
				}

				const rangeHeader = c.req.header('range');
				if (rangeHeader) {
					const parts = rangeHeader.replace(/bytes=/, '').split('-');
					const start = parseInt(parts[0], 10);
					const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
					const chunk = ramItem.buffer.subarray(start, end + 1);

					c.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
					c.header('Content-Length', chunk.length.toString());
					c.status(206 as any);
					return c.body(chunk as any);
				}

				c.header('Content-Length', totalSize.toString());
				c.status(200 as any);
				return c.body(ramItem.buffer as any);
			}
		}

		// 2. Stream directly from Catbox Cloud CDN (0 bytes on local PC)
		const directUrl = storageService.findDirectUrl(rawPath);
		if (!directUrl) {
			return c.text('Media not found on cloud storage', 404);
		}

		if (c.req.query('redirect') === 'true') {
			c.header('Access-Control-Allow-Origin', '*');
			c.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
			c.header('Cache-Control', 'public, max-age=31536000, immutable');
			c.header('X-Storage-Engine', 'Catbox-Cloud');
			c.header('X-Direct-Url', directUrl);
			return c.redirect(directUrl, 302);
		}

		try {
			const range = c.req.header('range');
			const headers: Record<string, string> = {
				'User-Agent': 'curl/8.4.0',
				'Accept': '*/*',
			};
			if (range) headers['Range'] = range;

			const upstream = await fetch(directUrl, { headers });
			const inferredCt = storageService.inferMimeType(rawPath);
			const upstreamCt = upstream.headers.get('content-type');
			const ct = (inferredCt && inferredCt !== 'application/octet-stream')
				? inferredCt
				: (upstreamCt && upstreamCt !== 'application/octet-stream' ? upstreamCt : 'application/octet-stream');

			const arrayBuffer = await upstream.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);

			// Cache into RAM so subsequent loads are 0ms instant without touching disk
			if (typeof (storageService as any).setInMemoryBuffer === 'function') {
				(storageService as any).setInMemoryBuffer(rawPath, buffer, ct);
			}

			c.header('Access-Control-Allow-Origin', '*');
			c.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
			c.header('Cache-Control', 'public, max-age=31536000, immutable');
			c.header('X-Storage-Engine', 'Catbox-Cloud-Stream');
			c.header('X-Direct-Url', directUrl);
			c.header('Content-Type', ct);
			c.header('Accept-Ranges', 'bytes');

			if (range) {
				const totalSize = buffer.length;
				const parts = range.replace(/bytes=/, '').split('-');
				const start = parseInt(parts[0], 10);
				const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
				const chunk = buffer.subarray(start, end + 1);

				c.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
				c.header('Content-Length', chunk.length.toString());
				c.status(206 as any);
				return c.body(chunk as any);
			}

			c.header('Content-Length', buffer.length.toString());
			c.status(upstream.status as any);
			return c.body(buffer as any);
		} catch (err) {
			Logger.warn({ err, directUrl }, '[Catbox Cloud Stream] Upstream stream failed, falling back to redirect');
			return c.redirect(directUrl, 302);
		}
	});

	await initialize();
	await bootstrapDefaultAdmin();
	await backfillKlipyEmbeds(persistentExecutor, devUnfurler);

	const port = Number(process.env.PORT || process.env.FLUXER_PORT || 8080);
	const hostname = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
	const server = createServer(app, { port, hostname });
	setupGatewayWebSocket(server);
	Logger.info(`[SYNC Backend] API listening on http://${hostname}:${port}`);
}

start().catch((err) => {
	console.error('[SYNC Backend] Startup failure:', err);
	process.exit(1);
});
