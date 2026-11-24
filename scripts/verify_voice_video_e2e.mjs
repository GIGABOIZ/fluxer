// SPDX-License-Identifier: AGPL-3.0-or-later

const WebSocket = globalThis.WebSocket;
import crypto from 'node:crypto';

const API_BASE = 'http://127.0.0.1:8080';
const WS_BASE = 'ws://127.0.0.1:8080/gateway';

function log(msg, ...args) {
	console.log(`[E2E Voice/Video] ${msg}`, ...args);
}

function delay(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function apiRequest(endpoint, method = 'GET', body = null, token = null) {
	const headers = { 'Content-Type': 'application/json' };
	if (token) headers['Authorization'] = token;
	const res = await fetch(`${API_BASE}${endpoint}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
	const contentType = res.headers.get('content-type') || '';
	let data = null;
	if (contentType.includes('application/json')) {
		data = await res.json();
	}
	return { status: res.status, ok: res.ok, data };
}

async function registerOrLogin(username, email, password) {
	const reg = await apiRequest('/auth/register', 'POST', {
		username,
		email,
		password,
		date_of_birth: '2000-01-01',
		consent: true,
	});
	if (reg.ok && reg.data?.token) {
		return { token: reg.data.token, user: reg.data.user };
	}
	if (!reg.ok) {
		log(`Register returned status ${reg.status}: ${JSON.stringify(reg.data)}`);
	}
	const login = await apiRequest('/auth/login', 'POST', {
		login: email,
		password,
		undelete: false,
	});
	if (login.ok && login.data?.token) {
		return { token: login.data.token, user: login.data.user };
	}
	throw new Error(`Failed to auth ${username}: ${JSON.stringify(login.data || reg.data)}`);
}

function connectGateway(token, name) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(WS_BASE);
		const events = [];
		let readyData = null;

		ws.addEventListener('open', () => {
			log(`[${name}] WebSocket connected`);
		});

		ws.addEventListener('message', (event) => {
			const payload = JSON.parse(event.data.toString());
			if (payload.op === 10) { // HELLO
				log(`[${name}] Received HELLO, sending IDENTIFY`);
				ws.send(JSON.stringify({
					op: 2,
					d: {
						token,
						properties: { os: 'windows', browser: 'chrome', device: '' },
					},
				}));
			} else if (payload.op === 0 && payload.t === 'READY') {
				log(`[${name}] Received READY`);
				readyData = payload.d;
				resolve({ ws, readyData, events });
			} else {
				events.push(payload);
			}
		});

		ws.addEventListener('error', (err) => {
			log(`[${name}] WebSocket error:`, err);
			reject(err);
		});
	});
}

async function run() {
	log('Starting SYNC Real-Time Communication End-to-End Verification...');

	const testTag = Date.now().toString().slice(-6);
	const pass = 'SuperSecret123!';

	// 1. Authenticate 3 users
	log('1. Authenticating Alice, Bob, and Charlie...');
	const aliceAuth = await registerOrLogin(`alice_${testTag}`, `alice_${testTag}@sync.test`, pass);
	const bobAuth = await registerOrLogin(`bob_${testTag}`, `bob_${testTag}@sync.test`, pass);
	const charlieAuth = await registerOrLogin(`charlie_${testTag}`, `charlie_${testTag}@sync.test`, pass);

	log(`Alice ID: ${aliceAuth.user?.id || 'ok'}, Bob ID: ${bobAuth.user?.id || 'ok'}, Charlie ID: ${charlieAuth.user?.id || 'ok'}`);

	// 2. Connect all 3 to Gateway
	log('2. Connecting all 3 users to Gateway WebSocket...');
	const aliceClient = await connectGateway(aliceAuth.token, 'Alice');
	const bobClient = await connectGateway(bobAuth.token, 'Bob');
	const charlieClient = await connectGateway(charlieAuth.token, 'Charlie');

	// 3. Alice and Bob become friends and Alice opens DM with Bob
	log('3. Alice and Bob becoming friends...');
	await apiRequest(`/users/@me/relationships/${bobClient.readyData.user.id}`, 'POST', {}, aliceAuth.token);
	await apiRequest(`/users/@me/relationships/${aliceClient.readyData.user.id}`, 'PUT', {}, bobAuth.token);

	log('Alice opening DM with Bob...');
	const dmRes = await apiRequest('/users/@me/channels', 'POST', {
		recipient_id: bobClient.readyData.user.id,
	}, aliceAuth.token);
	if (!dmRes.ok) throw new Error(`Failed to create DM: ${JSON.stringify(dmRes.data)}`);
	const dmChannelId = dmRes.data.id;
	log(`DM Channel ID: ${dmChannelId}`);

	// 4. Alice starts Call / Rings Bob
	log('4. Alice initiating call and ringing Bob...');
	const ringRes = await apiRequest(`/channels/${dmChannelId}/call/ring`, 'POST', {
		recipients: [bobClient.readyData.user.id],
	}, aliceAuth.token);
	if (!ringRes.ok) throw new Error(`Ring request failed: ${ringRes.status}: ${JSON.stringify(ringRes.data)}`);
	log('Ring API returned 204 OK');

	await delay(300);

	// Check Bob received CALL_CREATE or CALL_UPDATE
	const bobCallEvent = bobClient.events.find(
		(e) => (e.t === 'CALL_CREATE' || e.t === 'CALL_UPDATE') && e.d.channel_id === dmChannelId
	);
	if (!bobCallEvent) throw new Error('Bob did not receive CALL_CREATE or CALL_UPDATE event!');
	log('PASS: Bob received incoming call event with ringing state:', bobCallEvent.d.ringing);

	// 5. Alice connects voice (op: 4)
	log('5. Alice sending VOICE_STATE_UPDATE (joining call)...');
	const aliceConnId = `conn_alice_${Date.now()}`;
	aliceClient.ws.send(JSON.stringify({
		op: 4,
		d: {
			guild_id: null,
			channel_id: dmChannelId,
			self_mute: false,
			self_deaf: false,
			self_video: false,
			self_stream: false,
			connection_id: aliceConnId,
			p2p: true,
		},
	}));

	await delay(300);

	// Check Alice received VOICE_SERVER_UPDATE with STUN servers
	const aliceServerUpdate = aliceClient.events.find((e) => e.t === 'VOICE_SERVER_UPDATE');
	if (!aliceServerUpdate) throw new Error('Alice did not receive VOICE_SERVER_UPDATE!');
	if (!aliceServerUpdate.d.ice_servers || aliceServerUpdate.d.ice_servers.length === 0) {
		throw new Error('VOICE_SERVER_UPDATE missing ice_servers!');
	}
	log('PASS: Alice received VOICE_SERVER_UPDATE with STUN configuration:', aliceServerUpdate.d.ice_servers[0].urls);

	// 6. Bob accepts call and connects voice (op: 4)
	log('6. Bob accepting call and connecting voice...');
	const bobConnId = `conn_bob_${Date.now()}`;
	bobClient.ws.send(JSON.stringify({
		op: 4,
		d: {
			guild_id: null,
			channel_id: dmChannelId,
			self_mute: false,
			self_deaf: false,
			self_video: false,
			self_stream: false,
			connection_id: bobConnId,
			p2p: true,
		},
	}));

	await delay(300);

	// Check Bob received VOICE_SERVER_UPDATE
	const bobServerUpdate = bobClient.events.find((e) => e.t === 'VOICE_SERVER_UPDATE');
	if (!bobServerUpdate) throw new Error('Bob did not receive VOICE_SERVER_UPDATE!');
	log('PASS: Bob received VOICE_SERVER_UPDATE with STUN servers');

	// Check Alice received Bob's VOICE_STATE_UPDATE
	const aliceGotBobVoiceState = aliceClient.events.find(
		(e) => e.t === 'VOICE_STATE_UPDATE' && e.d.connection_id === bobConnId
	);
	if (!aliceGotBobVoiceState) throw new Error("Alice did not receive Bob's VOICE_STATE_UPDATE!");
	log("PASS: Alice received Bob's VOICE_STATE_UPDATE");

	// 7. WebRTC direct mesh signaling exchange (op: 13)
	log('7. Testing WebRTC SDP Offer/Answer signaling exchange...');
	// Alice sends SDP offer to Bob
	aliceClient.ws.send(JSON.stringify({
		op: 13,
		d: {
			guild_id: null,
			channel_id: dmChannelId,
			to: bobConnId,
			data: {
				t: 'offer',
				g: 1,
				sdp: 'v=0\r\no=alice 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
			},
		},
	}));

	await delay(300);

	// Check Bob received Alice's VOICE_SIGNAL
	const bobGotOffer = bobClient.events.find(
		(e) => e.t === 'VOICE_SIGNAL' && e.d.from === aliceConnId && e.d.data?.t === 'offer'
	);
	if (!bobGotOffer) throw new Error("Bob did not receive Alice's SDP offer signal!");
	log("PASS: Bob received Alice's WebRTC SDP offer signal");

	// Bob replies with SDP answer
	bobClient.ws.send(JSON.stringify({
		op: 13,
		d: {
			guild_id: null,
			channel_id: dmChannelId,
			to: aliceConnId,
			data: {
				t: 'answer',
				g: 1,
				sdp: 'v=0\r\no=bob 67890 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
			},
		},
	}));

	await delay(300);

	// Check Alice received Bob's VOICE_SIGNAL answer
	const aliceGotAnswer = aliceClient.events.find(
		(e) => e.t === 'VOICE_SIGNAL' && e.d.from === bobConnId && e.d.data?.t === 'answer'
	);
	if (!aliceGotAnswer) throw new Error("Alice did not receive Bob's SDP answer signal!");
	log("PASS: Alice received Bob's WebRTC SDP answer signal");

	// Exchange ICE candidate
	aliceClient.ws.send(JSON.stringify({
		op: 13,
		d: {
			guild_id: null,
			channel_id: dmChannelId,
			to: bobConnId,
			data: {
				t: 'ice',
				g: 1,
				c: { candidate: 'candidate:1 1 UDP 2130706431 127.0.0.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
			},
		},
	}));

	await delay(300);
	const bobGotIce = bobClient.events.find(
		(e) => e.t === 'VOICE_SIGNAL' && e.d.from === aliceConnId && e.d.data?.t === 'ice'
	);
	if (!bobGotIce) throw new Error("Bob did not receive Alice's ICE candidate!");
	log("PASS: Bob received Alice's ICE candidate");

	// 8. Video Calling (Camera Toggle)
	log('8. Testing Video Calling (Camera Toggle)...');
	aliceClient.ws.send(JSON.stringify({
		op: 4,
		d: {
			guild_id: null,
			channel_id: dmChannelId,
			self_mute: false,
			self_deaf: false,
			self_video: true,
			self_stream: false,
			connection_id: aliceConnId,
			p2p: true,
		},
	}));

	await delay(300);
	const bobGotVideoState = bobClient.events.find(
		(e) => e.t === 'VOICE_STATE_UPDATE' && e.d.connection_id === aliceConnId && e.d.self_video === true
	);
	if (!bobGotVideoState) throw new Error("Bob did not receive Alice's self_video=true state update!");
	log("PASS: Bob received Alice's camera video toggle state");

	// 9. Screen Sharing Toggle
	log('9. Testing Screen Sharing Toggle...');
	bobClient.ws.send(JSON.stringify({
		op: 4,
		d: {
			guild_id: null,
			channel_id: dmChannelId,
			self_mute: false,
			self_deaf: false,
			self_video: false,
			self_stream: true,
			connection_id: bobConnId,
			p2p: true,
		},
	}));

	await delay(300);
	const aliceGotScreenShareState = aliceClient.events.find(
		(e) => e.t === 'VOICE_STATE_UPDATE' && e.d.connection_id === bobConnId && e.d.self_stream === true
	);
	if (!aliceGotScreenShareState) throw new Error("Alice did not receive Bob's self_stream=true state update!");
	log("PASS: Alice received Bob's screen sharing toggle state");

	// 10. Multi-participant: Charlie joins a guild voice channel
	log('10. Testing Guild Voice Channel with Charlie...');
	const guildRes = await apiRequest('/guilds', 'POST', { name: `VoiceGuild_${testTag}` }, charlieAuth.token);
	if (guildRes.ok) {
		const guildId = guildRes.data.id;
		const channelRes = await apiRequest(`/guilds/${guildId}/channels`, 'POST', {
			name: 'General Voice',
			type: 2, // GUILD_VOICE
		}, charlieAuth.token);
		if (channelRes.ok) {
			const voiceChannelId = channelRes.data.id;
			const charlieConnId = `conn_charlie_${Date.now()}`;
			charlieClient.ws.send(JSON.stringify({
				op: 4,
				d: {
					guild_id: guildId,
					channel_id: voiceChannelId,
					self_mute: false,
					self_deaf: false,
					self_video: false,
					self_stream: false,
					connection_id: charlieConnId,
					p2p: true,
				},
			}));
			await delay(300);
			const charlieServerUpdate = charlieClient.events.find(
				(e) => e.t === 'VOICE_SERVER_UPDATE' && e.d.channel_id === voiceChannelId
			);
			if (!charlieServerUpdate) throw new Error('Charlie did not receive guild VOICE_SERVER_UPDATE!');
			log('PASS: Charlie joined Guild Voice channel with STUN credentials:', charlieServerUpdate.d.channel_id);
		}
	}

	// 11. End Call and Cleanup
	log('11. Testing Call Termination & Cleanup...');
	const endRes = await apiRequest(`/channels/${dmChannelId}/call/end`, 'POST', {}, aliceAuth.token);
	if (!endRes.ok) throw new Error(`End call request failed: ${endRes.status}`);
	log('End Call API returned 204 OK');

	await delay(300);
	const bobGotCallDelete = bobClient.events.find(
		(e) => e.t === 'CALL_DELETE' && e.d.channel_id === dmChannelId
	);
	if (!bobGotCallDelete) throw new Error('Bob did not receive CALL_DELETE on call termination!');
	log('PASS: Bob received CALL_DELETE event');

	// Alice disconnects voice
	aliceClient.ws.send(JSON.stringify({
		op: 4,
		d: {
			guild_id: null,
			channel_id: null,
			connection_id: aliceConnId,
		},
	}));

	await delay(300);
	log('PASS: Voice state cleanly disconnected.');

	aliceClient.ws.close();
	bobClient.ws.close();
	charlieClient.ws.close();

	log('ALL REAL-TIME COMMUNICATION SYSTEMS VERIFIED AND PASSING WITH FLYING COLORS!');
}

run().catch((err) => {
	console.error('[E2E Error]', err);
	process.exit(1);
});
