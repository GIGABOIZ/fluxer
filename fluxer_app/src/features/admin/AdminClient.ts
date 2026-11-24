// SPDX-License-Identifier: AGPL-3.0-or-later

export interface AdminUser {
	id: string;
	username: string;
	discriminator: number | string;
	global_name: string | null;
	email: string | null;
	email_verified: boolean;
	bot: boolean;
	system: boolean;
	flags: string;
	premium_flags: number;
	acls: Array<string>;
	account_tier: string;
	temp_banned_until: string | null;
	last_active_at: string | null;
	last_active_ip: string | null;
	date_of_birth: string | null;
	locale: string | null;
	has_password: boolean;
	has_totp: boolean;
	claimed: boolean;
}

export interface AdminReport {
	id: string;
	reporter_id: string;
	reported_user_id: string;
	reason: string;
	created_at: string;
	status: 'open' | 'resolved' | 'dismissed';
	notes?: string;
}

export interface AdminAuditEntry {
	id: string;
	timestamp: string;
	actor_id: string;
	actor_username: string;
	action: string;
	target_id?: string;
	reason?: string;
}

export interface AdminMeResponse {
	user: AdminUser;
	pending_registration_count: number | null;
}

export class AdminClient {
	private static getAuthToken(): string | null {
		// First check sessionStorage for direct admin login token
		const adminToken = sessionStorage.getItem('sync_admin_token');
		if (adminToken) return adminToken;

		// Fallback to active app session token
		try {
			const appToken = localStorage.getItem('fluxer:auth:token');
			if (appToken) return appToken;
		} catch {
			// ignore
		}
		return null;
	}

	public static setAdminToken(token: string | null): void {
		if (token) {
			sessionStorage.setItem('sync_admin_token', token);
		} else {
			sessionStorage.removeItem('sync_admin_token');
		}
	}

	private static async request<T>(path: string, options: RequestInit = {}): Promise<T> {
		const token = AdminClient.getAuthToken();
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			...(options.headers as Record<string, string> || {}),
		};

		if (token) {
			headers['Authorization'] = `Bearer ${token}`;
		}

		// Ensure requests go through the API proxy on /api
		const url = path.startsWith('/api') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`;

		const response = await fetch(url, {
			...options,
			headers,
		});

		if (!response.ok) {
			let errorMessage = `HTTP ${response.status} ${response.statusText}`;
			try {
				const errBody = await response.json();
				if (errBody.message) errorMessage = errBody.message;
				else if (errBody.code) errorMessage = errBody.code;
			} catch {
				// ignore
			}
			throw new Error(errorMessage);
		}

		return (await response.json()) as T;
	}

	public static async getMe(): Promise<AdminMeResponse> {
		return AdminClient.request<AdminMeResponse>('/admin/users/@me');
	}

	public static async listUsers(query = '', offset = 0, limit = 50): Promise<{users: Array<AdminUser>; total: number}> {
		const params = new URLSearchParams();
		if (query) params.set('query', query);
		params.set('offset', String(offset));
		params.set('limit', String(limit));
		return AdminClient.request<{users: Array<AdminUser>; total: number}>(`/admin/users?${params.toString()}`);
	}

	public static async lookupUser(userId: string): Promise<{user: AdminUser}> {
		return AdminClient.request<{user: AdminUser}>(`/admin/users/${userId}`);
	}

	public static async setUserAcls(userId: string, acls: Array<string>): Promise<{acls: Array<string>}> {
		return AdminClient.request<{acls: Array<string>}>(`/admin/users/${userId}/acls`, {
			method: 'PUT',
			body: JSON.stringify({acls}),
		});
	}

	public static async createPasswordResetLink(userId: string): Promise<{url: string; expires_at: string}> {
		return AdminClient.request<{url: string; expires_at: string}>(`/admin/users/${userId}/password-reset-link`, {
			method: 'POST',
		});
	}

	public static async terminateUserSessions(userId: string): Promise<{revoked: number}> {
		return AdminClient.request<{revoked: number}>(`/admin/users/${userId}/sessions`, {
			method: 'DELETE',
		});
	}

	public static async tempBanUser(
		userId: string,
		durationHours: number,
		publicReason: string,
		auditLogReason: string,
	): Promise<void> {
		await AdminClient.request(`/admin/users/${userId}/ban`, {
			method: 'POST',
			headers: {
				'X-Audit-Log-Reason': auditLogReason,
			},
			body: JSON.stringify({
				duration_hours: durationHours,
				decision: {
					kind: 'suspension',
					reason: publicReason,
				},
			}),
		});
	}

	public static async unbanUser(userId: string): Promise<void> {
		await AdminClient.request(`/admin/users/${userId}/ban`, {
			method: 'DELETE',
		});
	}

	public static async adminLogin(login: string, password: string): Promise<string> {
		const res = await fetch('/api/v1/auth/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({login, password}),
		});

		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			throw new Error(err.message || 'Invalid administrator credentials');
		}

		const data = await res.json();
		if (!data.token) {
			throw new Error('No authentication token returned');
		}

		AdminClient.setAdminToken(data.token);
		return data.token;
	}

	public static logout(): void {
		AdminClient.setAdminToken(null);
	}
}

