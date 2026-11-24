// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import type {RelationshipWire} from '@app/features/relationship/models/Relationship';
import Relationships from '@app/features/relationship/state/Relationships';
import Users from '@app/features/user/state/Users';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';

const logger = new Logger('RelationshipCommands');

export interface SendFriendRequestOptions {
	staffForceAccept?: boolean;
}

type RelationshipCommand =
	| {kind: 'send'; userId: string; options: SendFriendRequestOptions}
	| {kind: 'send-by-tag'; username: string; discriminator: string}
	| {kind: 'accept'; userId: string}
	| {kind: 'remove'; userId: string}
	| {kind: 'block'; userId: string}
	| {kind: 'nickname'; userId: string; nickname: string | null};

function friendRequestBody(options: SendFriendRequestOptions): Record<string, boolean> {
	return options.staffForceAccept ? {staff_force_accept: true} : {};
}

async function dispatchRelationshipCommand(command: RelationshipCommand): Promise<void> {
	switch (command.kind) {
		case 'send': {
			const res = await http.post<RelationshipWire>(Endpoints.USER_RELATIONSHIP(command.userId), {body: friendRequestBody(command.options)});
			if (res) {
				Relationships.updateRelationship(res);
				if (res.user) {
					Users.cacheUsers([res.user]);
				}
			}
			return;
		}
		case 'send-by-tag': {
			const res = await http.post<RelationshipWire>(Endpoints.USER_RELATIONSHIPS, {
				body: {username: command.username, discriminator: command.discriminator},
			});
			if (res) {
				Relationships.updateRelationship(res);
				if (res.user) {
					Users.cacheUsers([res.user]);
				}
			}
			return;
		}
		case 'accept': {
			const res = await http.put<RelationshipWire>(Endpoints.USER_RELATIONSHIP(command.userId));
			if (res) {
				Relationships.updateRelationship(res);
				if (res.user) {
					Users.cacheUsers([res.user]);
				}
			}
			return;
		}
		case 'remove': {
			await http.delete(Endpoints.USER_RELATIONSHIP(command.userId));
			Relationships.removeRelationship(command.userId);
			return;
		}
		case 'block': {
			const res = await http.put<RelationshipWire>(Endpoints.USER_RELATIONSHIP(command.userId), {body: {type: RelationshipTypes.BLOCKED}});
			if (res) {
				Relationships.updateRelationship(res);
				if (res.user) {
					Users.cacheUsers([res.user]);
				}
			}
			return;
		}
		case 'nickname': {
			const res = await http.patch<RelationshipWire>(Endpoints.USER_RELATIONSHIP(command.userId), {body: {nickname: command.nickname}});
			if (res) {
				Relationships.updateRelationship(res);
			}
			return;
		}
	}
}

function rethrowRelationshipFailure(message: string, error: unknown): never {
	logger.error(message, error);
	throw error;
}

export async function sendFriendRequest(userId: string, options: SendFriendRequestOptions = {}) {
	try {
		await dispatchRelationshipCommand({kind: 'send', userId, options});
	} catch (error) {
		rethrowRelationshipFailure('Failed to send friend request:', error);
	}
}

export async function sendFriendRequestByTag(username: string, discriminator: string) {
	try {
		await dispatchRelationshipCommand({kind: 'send-by-tag', username, discriminator});
	} catch (error) {
		rethrowRelationshipFailure('Failed to send friend request by tag:', error);
	}
}

export async function acceptFriendRequest(userId: string) {
	try {
		await dispatchRelationshipCommand({kind: 'accept', userId});
	} catch (error) {
		rethrowRelationshipFailure('Failed to accept friend request:', error);
	}
}

export async function removeRelationship(userId: string) {
	try {
		await dispatchRelationshipCommand({kind: 'remove', userId});
	} catch (error) {
		rethrowRelationshipFailure('Failed to remove relationship:', error);
	}
}

export async function blockUser(userId: string) {
	try {
		await dispatchRelationshipCommand({kind: 'block', userId});
	} catch (error) {
		rethrowRelationshipFailure('Failed to block user:', error);
	}
}

export async function updateFriendNickname(userId: string, nickname: string | null) {
	try {
		await dispatchRelationshipCommand({kind: 'nickname', userId, nickname});
	} catch (error) {
		rethrowRelationshipFailure('Failed to update friend nickname:', error);
	}
}

export async function fetchRelationships(): Promise<void> {
	try {
		const list = await http.get<Array<RelationshipWire>>(Endpoints.USER_RELATIONSHIPS);
		if (Array.isArray(list)) {
			Relationships.loadRelationships(list);
			const usersToCache = list.map((r) => r.user).filter((u): u is NonNullable<typeof u> => Boolean(u));
			if (usersToCache.length > 0) {
				Users.cacheUsers(usersToCache);
			}
		}
	} catch (error) {
		logger.warn('Failed to fetch relationships:', error);
	}
}
