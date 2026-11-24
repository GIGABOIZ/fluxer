// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import GuildMembers from '@app/features/member/state/GuildMembers';
import RollingTypingStore from '@app/features/typing/rolling/RollingTypingStore';
import Users from '@app/features/user/state/Users';
import type {GuildMemberData} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';
import type {User} from '@fluxer/schema/src/domains/user/UserResponseSchemas';

interface TypingStartPayload {
	channel_id: string;
	user_id: string;
	timestamp: number;
	guild_id?: string;
	member?: GuildMemberData;
	user?: User;
}

export function handleTypingStart(data: TypingStartPayload, _context: GatewayHandlerContext): void {
	if (data.user) {
		Users.handleUserUpdate(data.user);
	}
	if (data.guild_id && data.member) {
		if (data.member.user) {
			Users.handleUserUpdate(data.member.user as User);
		}
		GuildMembers.hydrateIfMissing(data.guild_id, data.member);
	}
	RollingTypingStore.start(data.channel_id, data.user_id, 'gateway');
}
