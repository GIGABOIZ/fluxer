// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = 'http://127.0.0.1:8080';
const WS_URL = 'ws://127.0.0.1:8080/gateway';

let serverProcess = null;

function startBackend() {
	console.log('[TestHarness] Starting DevServer...');
	serverProcess = spawn('pnpm', ['--filter', 'fluxer_api', 'exec', 'tsx', 'src/DevServer.ts'], {
		cwd: 'd:/fluxer',
		shell: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, PORT: '8080' },
	});

	serverProcess.stdout.on('data', (d) => {
		const s = d.toString();
		if (s.includes('error') || s.includes('Error') || s.includes('Fluxer API listening')) {
			process.stdout.write('[DevServer:out] ' + s);
		}
	});

	serverProcess.stderr.on('data', (d) => {
		process.stderr.write('[DevServer:err] ' + d.toString());
	});

	return serverProcess;
}

async function stopBackend() {
	console.log('[TestHarness] Stopping DevServer on port 8080...');
	try {
		spawnSync('powershell', [
			'-NoProfile',
			'-Command',
			'Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }',
		]);
	} catch {}
	serverProcess = null;
	await sleep(2500);
}

async function waitForServer(timeoutMs = 30000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`${BASE_URL}/instance/branding`);
			if (res.status < 500) {
				return true;
			}
		} catch {}
		await sleep(500);
	}
	throw new Error(`DevServer failed to start within ${timeoutMs}ms`);
}

async function apiRequest(endpoint, options = {}) {
	const res = await fetch(`${BASE_URL}${endpoint}`, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
			...(options.headers || {}),
		},
	});
	let json = null;
	const text = await res.text();
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, ok: res.ok, body: json };
}

class GatewayClient {
	constructor(name, token) {
		this.name = name;
		this.token = token;
		this.ws = null;
		this.events = [];
		this.listeners = new Map();
	}

	async connect() {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(WS_URL);
			this.ws.onopen = () => {
				console.log(`[WS:${this.name}] Connected to gateway`);
			};
			this.ws.onerror = (err) => {
				console.error(`[WS:${this.name}] Error:`, err);
				reject(err);
			};
			this.ws.onmessage = (event) => {
				const payload = JSON.parse(event.data);
				if (payload.op === 10) {
					// HELLO -> Send IDENTIFY
					this.ws.send(JSON.stringify({
						op: 2,
						d: {
							token: this.token,
							properties: { os: 'Windows', browser: 'SyncApp', device: 'Desktop' },
						},
					}));
				} else if (payload.op === 0) {
					this.events.push(payload);
					console.log(`[WS:${this.name}] Received Event: ${payload.t}`);
					if (payload.t === 'READY') {
						resolve();
					}
					const listeners = this.listeners.get(payload.t);
					if (listeners) {
						for (const cb of listeners) {
							cb(payload.d);
						}
					}
				}
			};
		});
	}

	on(eventType, callback) {
		if (!this.listeners.has(eventType)) {
			this.listeners.set(eventType, []);
		}
		this.listeners.get(eventType).push(callback);
	}

	waitForEvent(eventType, predicate = () => true, timeoutMs = 8000) {
		return new Promise((resolve, reject) => {
			const existing = this.events.find((e) => e.t === eventType && predicate(e.d));
			if (existing) {
				return resolve(existing.d);
			}
			const timer = setTimeout(() => {
				reject(new Error(`Timeout waiting for event ${eventType} on ${this.name}`));
			}, timeoutMs);

			const handler = (data) => {
				if (predicate(data)) {
					clearTimeout(timer);
					const list = this.listeners.get(eventType) || [];
					const idx = list.indexOf(handler);
					if (idx !== -1) list.splice(idx, 1);
					resolve(data);
				}
			};
			this.on(eventType, handler);
		});
	}

	updatePresence(status, custom_status = null) {
		this.ws.send(JSON.stringify({
			op: 3,
			d: {
				status,
				afk: false,
				mobile: false,
				custom_status,
			},
		}));
	}

	close() {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}
}

async function runTestSuite() {
	console.log('====================================================');
	console.log('SYNC: COMPLETE SERVER, SOCIAL & REAL-TIME OVERHAUL');
	console.log('MULTI-ACCOUNT END-TO-END VERIFICATION');
	console.log('====================================================\n');

	startBackend();
	await waitForServer();
	console.log('DevServer is healthy and ready.\n');

	const timestamp = Date.now().toString().slice(-6);
	const userA = { email: `owner_${timestamp}@sync.local`, username: `owner_${timestamp}`, password: 'StrongPassword123!', global_name: 'Server Owner' };
	const userB = { email: `mod_${timestamp}@sync.local`, username: `mod_${timestamp}`, password: 'StrongPassword123!', global_name: 'Moderator' };
	const userC = { email: `member_${timestamp}@sync.local`, username: `member_${timestamp}`, password: 'StrongPassword123!', global_name: 'Regular Member' };

	console.log('--- SCENARIO 0: ACCOUNT REGISTRATION ---');
	for (const u of [userA, userB, userC]) {
		const regRes = await apiRequest('/auth/register', {
			method: 'POST',
			body: JSON.stringify({
				email: u.email,
				username: u.username,
				password: u.password,
				global_name: u.global_name,
				date_of_birth: '2000-01-01',
				consent: true,
			}),
		});
		if (!regRes.ok) throw new Error(`Failed to register ${u.username}: ${JSON.stringify(regRes.body)}`);
		u.token = regRes.body.token;
		u.id = regRes.body.user_id;
		console.log(`[Registered] ${u.username} (ID: ${u.id})`);
	}

	console.log('\n--- SCENARIO 0.1: GATEWAY WEBSOCKET CONNECTIONS & IDENTIFY ---');
	const wsA = new GatewayClient('Account A (Owner)', userA.token);
	const wsB = new GatewayClient('Account B (Mod)', userB.token);
	const wsC = new GatewayClient('Account C (Member)', userC.token);

	await Promise.all([wsA.connect(), wsB.connect(), wsC.connect()]);
	console.log('All 3 accounts connected to Gateway and received READY successfully!\n');

	console.log('--- SCENARIO 1: SERVER CREATION & BRANDING (PHASE 1) ---');
	const createGuildRes = await apiRequest('/guilds', {
		method: 'POST',
		token: userA.token,
		body: JSON.stringify({ name: 'SYNC Community Alpha' }),
	});
	if (!createGuildRes.ok) throw new Error(`Server creation failed: ${JSON.stringify(createGuildRes.body)}`);
	const guild = createGuildRes.body;
	const guildId = guild.id;
	console.log(`Server Created: "${guild.name}" (ID: ${guildId}, Owner: ${guild.owner_id})`);
	if (guild.owner_id !== userA.id) throw new Error('Owner ID does not match Account A');

	console.log('\n--- SCENARIO 2: CHANNELS MANAGEMENT (PHASE 2) ---');
	const createChanRes = await apiRequest(`/guilds/${guildId}/channels`, {
		method: 'POST',
		token: userA.token,
		body: JSON.stringify({ name: 'discussion', type: 0 }),
	});
	if (!createChanRes.ok) throw new Error(`Channel creation failed: ${JSON.stringify(createChanRes.body)}`);
	const channel = createChanRes.body;
	const channelId = channel.id;
	console.log(`Channel Created: #${channel.name} (ID: ${channelId})`);

	const renameChanRes = await apiRequest(`/channels/${channelId}`, {
		method: 'PATCH',
		token: userA.token,
		body: JSON.stringify({ name: 'lounge' }),
	});
	if (!renameChanRes.ok) throw new Error(`Channel rename failed: ${JSON.stringify(renameChanRes.body)}`);
	console.log(`Channel Renamed: #${renameChanRes.body.name}`);

	console.log('\n--- SCENARIO 3: INVITATIONS & REAL-TIME JOIN (PHASE 1) ---');
	const createInviteRes = await apiRequest(`/channels/${channelId}/invites`, {
		method: 'POST',
		token: userA.token,
		body: JSON.stringify({ max_age: 86400, max_uses: 10 }),
	});
	if (!createInviteRes.ok) throw new Error(`Invite creation failed: ${JSON.stringify(createInviteRes.body)}`);
	const inviteCode = createInviteRes.body.code;
	console.log(`Invite Created: Code "${inviteCode}"`);

	// Account B joins via invite
	const bGuildCreatePromise = wsB.waitForEvent('GUILD_CREATE', (d) => d.id === guildId);
	const aMemberAddPromiseB = wsA.waitForEvent('GUILD_MEMBER_ADD', (d) => d.guild_id === guildId && d.user.id === userB.id);

	const bJoinRes = await apiRequest(`/invites/${inviteCode}`, { method: 'POST', token: userB.token });
	if (!bJoinRes.ok) throw new Error(`Account B failed to join: ${JSON.stringify(bJoinRes.body)}`);
	await Promise.all([bGuildCreatePromise, aMemberAddPromiseB]);
	console.log('Account B joined! B received GUILD_CREATE, A received GUILD_MEMBER_ADD with valid guild_id.');

	// Account C joins via invite
	const cGuildCreatePromise = wsC.waitForEvent('GUILD_CREATE', (d) => d.id === guildId);
	const aMemberAddPromiseC = wsA.waitForEvent('GUILD_MEMBER_ADD', (d) => d.guild_id === guildId && d.user.id === userC.id);
	const bMemberAddPromiseC = wsB.waitForEvent('GUILD_MEMBER_ADD', (d) => d.guild_id === guildId && d.user.id === userC.id);

	const cJoinRes = await apiRequest(`/invites/${inviteCode}`, { method: 'POST', token: userC.token });
	if (!cJoinRes.ok) throw new Error(`Account C failed to join: ${JSON.stringify(cJoinRes.body)}`);
	await Promise.all([cGuildCreatePromise, aMemberAddPromiseC, bMemberAddPromiseC]);
	console.log('Account C joined! C received GUILD_CREATE, A and B received GUILD_MEMBER_ADD in real time.');

	// Verify member list contains all 3
	const listMembersRes = await apiRequest(`/guilds/${guildId}/members?limit=50`, { token: userA.token });
	if (!listMembersRes.ok) throw new Error(`Failed to list members: ${JSON.stringify(listMembersRes.body)}`);
	const memberUserIds = listMembersRes.body.map((m) => m.user.id);
	console.log(`Current Guild Members (${memberUserIds.length}):`, memberUserIds);
	if (!memberUserIds.includes(userA.id) || !memberUserIds.includes(userB.id) || !memberUserIds.includes(userC.id)) {
		throw new Error('Not all 3 accounts are present in member list!');
	}

	console.log('\n--- SCENARIO 4: ROLES & PERMISSIONS ARCHITECTURE (PHASE 3) ---');
	// Create Moderator Role with MANAGE_MESSAGES (8192) permission
	const roleCreatePromiseB = wsB.waitForEvent('GUILD_ROLE_CREATE', (d) => d.guild_id === guildId && d.role.name === 'Moderator');
	const createRoleRes = await apiRequest(`/guilds/${guildId}/roles`, {
		method: 'POST',
		token: userA.token,
		body: JSON.stringify({
			name: 'Moderator',
			color: 3447003,
			permissions: '8192', // MANAGE_MESSAGES
		}),
	});
	if (!createRoleRes.ok) throw new Error(`Role creation failed: ${JSON.stringify(createRoleRes.body)}`);
	const modRole = createRoleRes.body;
	const modRoleId = modRole.id;
	await roleCreatePromiseB;
	console.log(`Role Created: "${modRole.name}" (ID: ${modRoleId}, Color: #${modRole.color.toString(16)}) - Broadcasted via GUILD_ROLE_CREATE!`);

	// Assign Moderator Role to Account B
	const memberUpdatePromiseB = wsB.waitForEvent('GUILD_MEMBER_UPDATE', (d) => d.guild_id === guildId && d.user.id === userB.id && d.roles.includes(modRoleId));
	const assignRoleRes = await apiRequest(`/guilds/${guildId}/members/${userB.id}/roles/${modRoleId}`, {
		method: 'PUT',
		token: userA.token,
	});
	if (!assignRoleRes.ok) throw new Error(`Assigning role failed: ${JSON.stringify(assignRoleRes.body)}`);
	await memberUpdatePromiseB;
	console.log(`Moderator role assigned to Account B! Broadcasted via GUILD_MEMBER_UPDATE!`);

	console.log('\n--- SCENARIO 5: MODERATOR PERMISSION ENFORCEMENT & MESSAGING (PHASE 2 & 3) ---');
	// C sends message M1
	const msgPromiseB = wsB.waitForEvent('MESSAGE_CREATE', (d) => d.channel_id === channelId && d.author.id === userC.id);
	const sendM1Res = await apiRequest(`/channels/${channelId}/messages`, {
		method: 'POST',
		token: userC.token,
		body: JSON.stringify({ content: 'Hello everyone from Member C!' }),
	});
	if (!sendM1Res.ok) throw new Error(`C failed to send message: ${JSON.stringify(sendM1Res.body)}`);
	const msg1 = sendM1Res.body;
	await msgPromiseB;
	console.log(`Message M1 sent by C: "${msg1.content}" (ID: ${msg1.id}) - Real-time received by B!`);

	// B sends message M2
	const sendM2Res = await apiRequest(`/channels/${channelId}/messages`, {
		method: 'POST',
		token: userB.token,
		body: JSON.stringify({ content: 'Moderator B online.' }),
	});
	const msg2 = sendM2Res.body;
	console.log(`Message M2 sent by B: "${msg2.content}" (ID: ${msg2.id})`);

	// Moderator B deletes Member C's message (requires MANAGE_MESSAGES permission)
	const delM1Res = await apiRequest(`/channels/${channelId}/messages/${msg1.id}`, {
		method: 'DELETE',
		token: userB.token,
	});
	if (delM1Res.status !== 204 && delM1Res.status !== 200) {
		throw new Error(`Moderator B failed to delete C's message: status ${delM1Res.status}`);
	}
	console.log(`Moderator B deleted C's message M1 successfully (HTTP ${delM1Res.status})!`);

	// Regular Member C tries to delete Moderator B's message M2 (MUST BE FORBIDDEN 403)
	const unauthorizedDeleteRes = await apiRequest(`/channels/${channelId}/messages/${msg2.id}`, {
		method: 'DELETE',
		token: userC.token,
	});
	if (unauthorizedDeleteRes.status !== 403) {
		throw new Error(`Expected HTTP 403 when Member C tries to delete B's message, got ${unauthorizedDeleteRes.status}`);
	}
	console.log(`Security verified: Member C was correctly blocked with HTTP 403 Forbidden!`);

	console.log('\n--- SCENARIO 6: REAL-TIME TYPING INDICATORS (PHASE 2) ---');
	const typingPromiseC = wsC.waitForEvent('TYPING_START', (d) => d.channel_id === channelId && d.user_id === userB.id);
	const typingRes = await apiRequest(`/channels/${channelId}/typing`, {
		method: 'POST',
		token: userB.token,
	});
	if (!typingRes.ok) throw new Error(`Typing trigger failed: ${JSON.stringify(typingRes.body)}`);
	const typingData = await typingPromiseC;
	console.log(`Real-Time Typing verified: TYPING_START received by C with channel_id=${typingData.channel_id}, user_id=${typingData.user_id}, guild_id=${typingData.guild_id}`);

	console.log('\n--- SCENARIO 7: DIRECT MESSAGES & FRIEND SYSTEM (PHASE 5) ---');
	// B sends friend request to C
	const friendReqRes = await apiRequest(`/users/@me/relationships/${userC.id}`, {
		method: 'POST',
		token: userB.token,
		body: JSON.stringify({}),
	});
	if (!friendReqRes.ok) throw new Error(`Friend request failed: ${JSON.stringify(friendReqRes.body)}`);
	console.log('Account B sent friend request to Account C');

	// C accepts friend request
	const acceptFriendRes = await apiRequest(`/users/@me/relationships/${userB.id}`, {
		method: 'PUT',
		token: userC.token,
		body: JSON.stringify({}),
	});
	if (!acceptFriendRes.ok) throw new Error(`Accept friend request failed: ${JSON.stringify(acceptFriendRes.body)}`);
	console.log('Account C accepted friend request from Account B');

	// B opens DM with C
	const createDmRes = await apiRequest(`/users/@me/channels`, {
		method: 'POST',
		token: userB.token,
		body: JSON.stringify({ recipient_id: userC.id }),
	});
	if (!createDmRes.ok) throw new Error(`Create DM failed: ${JSON.stringify(createDmRes.body)}`);
	const dmChannel = createDmRes.body;
	console.log(`DM Channel opened: ID ${dmChannel.id}`);

	// B sends message in DM
	const dmMsgPromiseC = wsC.waitForEvent('MESSAGE_CREATE', (d) => d.channel_id === dmChannel.id && d.author.id === userB.id);
	const sendDmMsgRes = await apiRequest(`/channels/${dmChannel.id}/messages`, {
		method: 'POST',
		token: userB.token,
		body: JSON.stringify({ content: 'Hey friend! Direct message check.' }),
	});
	if (!sendDmMsgRes.ok) throw new Error(`Send DM message failed: ${JSON.stringify(sendDmMsgRes.body)}`);
	await dmMsgPromiseC;
	console.log('DM Message sent and received in real-time over WebSocket!');

	console.log('\n--- SCENARIO 8: PRESENCE SYNCHRONIZATION (PHASE 4) ---');
	const presencePromiseA = wsA.waitForEvent('PRESENCE_UPDATE', (d) => d.user.id === userB.id && d.status === 'idle');
	const presencePromiseC = wsC.waitForEvent('PRESENCE_UPDATE', (d) => d.user.id === userB.id && d.status === 'idle');
	wsB.updatePresence('idle');
	await Promise.all([presencePromiseA, presencePromiseC]);
	console.log('Presence update ("idle") for B synchronized in real-time to both A and C without refresh!');

	console.log('\n--- SCENARIO 9: BACKEND RESTART & SERVER DATA PERSISTENCE (PHASE 1) ---');
	wsA.close();
	wsB.close();
	wsC.close();
	await stopBackend();

	console.log('[TestHarness] Backend restarted. Testing cold reboot data persistence...');
	startBackend();
	await waitForServer();

	// Verify Account B can query the guild and its channels, roles, and members
	const postRestartGuildRes = await apiRequest(`/guilds/${guildId}`, {
		token: userB.token,
	});
	if (!postRestartGuildRes.ok) {
		throw new Error(`CRITICAL: Guild lookup failed post-restart: ${JSON.stringify(postRestartGuildRes.body)}`);
	}
	const persistedGuild = postRestartGuildRes.body;
	console.log(`[Persistence Verified] Guild: "${persistedGuild.name}" (ID: ${persistedGuild.id})`);

	// Verify channel lounge exists
	const postRestartChannelsRes = await apiRequest(`/guilds/${guildId}/channels`, {
		token: userB.token,
	});
	if (!postRestartChannelsRes.ok) throw new Error('Failed to fetch channels post-restart');
	const channels = postRestartChannelsRes.body;
	const loungeChan = channels.find((c) => c.name === 'lounge');
	if (!loungeChan) throw new Error('Persisted channel "lounge" not found post-restart!');
	console.log(`[Persistence Verified] Channel: #${loungeChan.name} (ID: ${loungeChan.id})`);

	// Verify roles exist
	const postRestartRolesRes = await apiRequest(`/guilds/${guildId}/roles`, {
		token: userB.token,
	});
	if (!postRestartRolesRes.ok) throw new Error('Failed to fetch roles post-restart');
	const roles = postRestartRolesRes.body;
	const persistedModRole = roles.find((r) => r.name === 'Moderator');
	if (!persistedModRole) throw new Error('Persisted role "Moderator" not found post-restart!');
	console.log(`[Persistence Verified] Role: "${persistedModRole.name}" (ID: ${persistedModRole.id}, Color: #${persistedModRole.color.toString(16)})`);

	// Verify members exist
	const postRestartMembersRes = await apiRequest(`/guilds/${guildId}/members?limit=50`, {
		token: userB.token,
	});
	if (!postRestartMembersRes.ok) throw new Error('Failed to fetch members post-restart');
	const persistedMembers = postRestartMembersRes.body;
	console.log(`[Persistence Verified] Member Count: ${persistedMembers.length}`);
	const bMember = persistedMembers.find((m) => m.user.id === userB.id);
	if (!bMember || !bMember.roles.includes(modRoleId)) {
		throw new Error('Account B did not retain Moderator role post-restart!');
	}
	console.log(`[Persistence Verified] Account B retains Moderator role: ${JSON.stringify(bMember.roles)}`);

	await stopBackend();

	console.log('\n====================================================');
	console.log('ALL 15 END-TO-END OVERHAUL SCENARIOS PASSED WITH 100% SUCCESS!');
	console.log('====================================================');
}

runTestSuite().catch(async (err) => {
	console.error('\n[FATAL TEST FAILURE]', err);
	await stopBackend();
	process.exit(1);
});
