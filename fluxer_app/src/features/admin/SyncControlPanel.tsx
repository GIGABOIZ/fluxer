// SPDX-License-Identifier: AGPL-3.0-or-later

import React, {useCallback, useEffect, useState} from 'react';
import styles from './SyncControlPanel.module.css';
import {AdminClient, type AdminUser, type AdminReport, type AdminAuditEntry} from './AdminClient';
import {
	ShieldCheckIcon,
	UsersIcon,
	ChartBarIcon,
	GearIcon,
	SignOutIcon,
	MagnifyingGlassIcon,
	ArrowClockwiseIcon,
	CopyIcon,
	ShieldSlashIcon,
} from '@phosphor-icons/react';

const OWNER_ACLS = ['*'];
const ADMIN_ACLS = [
	'user:lookup',
	'user:temp_ban',
	'user:create:password_reset_link',
	'user:list:sessions',
	'user:view:email',
	'report:view',
	'report:resolve',
	'admin:authenticate',
];
const MODERATOR_ACLS = [
	'report:view',
	'report:resolve',
	'admin:authenticate',
];

export function SyncControlPanel(): React.JSX.Element {
	const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'moderation' | 'admins' | 'settings'>('overview');
	const [adminUser, setAdminUser] = useState<AdminUser | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [notification, setNotification] = useState<{message: string; type: 'success' | 'error'} | null>(null);

	// Direct Admin Login Form State
	const [loginUser, setLoginUser] = useState('');
	const [loginPass, setLoginPass] = useState('');
	const [isLoggingIn, setIsLoggingIn] = useState(false);
	const [loginError, setLoginError] = useState<string | null>(null);

	// Data states
	const [users, setUsers] = useState<Array<AdminUser>>([]);
	const [searchQuery, setSearchQuery] = useState('');
	const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended'>('all');

	// Modals
	const [detailUser, setDetailUser] = useState<AdminUser | null>(null);
	const [banUser, setBanUser] = useState<AdminUser | null>(null);
	const [banHours, setBanHours] = useState<number>(24);
	const [banReason, setBanReason] = useState<string>('Violation of SYNC terms and community guidelines');
	const [resetLinkData, setResetLinkData] = useState<{url: string; expiresAt: string; username: string} | null>(null);
	const [roleModalUser, setRoleModalUser] = useState<AdminUser | null>(null);
	const [selectedRole, setSelectedRole] = useState<'OWNER' | 'ADMIN' | 'MODERATOR'>('ADMIN');

	// Reports & Audit
	const [reports, setReports] = useState<Array<AdminReport>>([
		{
			id: 'rep_1001',
			reporter_id: '100000000000000001',
			reported_user_id: '1570391185451646978',
			reason: 'Spamming channel messages in testing guild',
			created_at: new Date(Date.now() - 3600000).toISOString(),
			status: 'open',
		},
	]);
	const [auditLogs, setAuditLogs] = useState<Array<AdminAuditEntry>>([
		{
			id: 'audit_01',
			timestamp: new Date().toISOString(),
			actor_id: '100000000000000001',
			actor_username: 'syncadmin',
			action: 'SYSTEM_BOOTSTRAP',
			reason: 'Initial Owner account provisioned with Wildcard (*)',
		},
	]);

	const showNotification = useCallback((message: string, type: 'success' | 'error' = 'success') => {
		setNotification({message, type});
		setTimeout(() => setNotification(null), 4000);
	}, []);

	const checkAuthAndLoad = useCallback(async () => {
		setIsLoading(true);
		try {
			const meRes = await AdminClient.getMe();
			setAdminUser(meRes.user);

			// Load user directory
			const usersRes = await AdminClient.listUsers(searchQuery);
			setUsers(usersRes.users || []);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn('[SyncControlPanel] Auth check failed:', msg);
			setAdminUser(null);
		} finally {
			setIsLoading(false);
		}
	}, [searchQuery]);

	useEffect(() => {
		void checkAuthAndLoad();
	}, [checkAuthAndLoad]);

	const handleAdminLogin = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoggingIn(true);
		setLoginError(null);
		try {
			await AdminClient.adminLogin(loginUser.trim(), loginPass);
			await checkAuthAndLoad();
		} catch (err) {
			setLoginError(err instanceof Error ? err.message : 'Invalid administrator credentials');
		} finally {
			setIsLoggingIn(false);
		}
	};

	const handleLogout = () => {
		AdminClient.logout();
		setAdminUser(null);
		setUsers([]);
	};

	const handleSearch = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			const res = await AdminClient.listUsers(searchQuery);
			setUsers(res.users || []);
		} catch (err) {
			showNotification(err instanceof Error ? err.message : 'Failed to search users', 'error');
		}
	};

	const handleCreateResetLink = async (user: AdminUser) => {
		try {
			const res = await AdminClient.createPasswordResetLink(user.id);
			setResetLinkData({url: res.url, expiresAt: res.expires_at, username: user.username});
			setAuditLogs((prev) => [
				{
					id: `audit_${Date.now()}`,
					timestamp: new Date().toISOString(),
					actor_id: adminUser?.id || '',
					actor_username: adminUser?.username || 'admin',
					action: 'PASSWORD_RESET_LINK_GENERATE',
					target_id: user.id,
					reason: `Created reset link for ${user.username}`,
				},
				...prev,
			]);
			showNotification(`Password reset link created for ${user.username}`);
		} catch (err) {
			showNotification(err instanceof Error ? err.message : 'Failed to generate reset link', 'error');
		}
	};

	const handleTerminateSessions = async (user: AdminUser) => {
		if (!confirm(`Are you sure you want to terminate all active sessions for ${user.username}?`)) return;
		try {
			await AdminClient.terminateUserSessions(user.id);
			setAuditLogs((prev) => [
				{
					id: `audit_${Date.now()}`,
					timestamp: new Date().toISOString(),
					actor_id: adminUser?.id || '',
					actor_username: adminUser?.username || 'admin',
					action: 'SESSIONS_TERMINATE',
					target_id: user.id,
					reason: `Forced session revocation for ${user.username}`,
				},
				...prev,
			]);
			showNotification(`All active sessions terminated for ${user.username}`);
		} catch (err) {
			showNotification(err instanceof Error ? err.message : 'Failed to terminate sessions', 'error');
		}
	};

	const handleConfirmBan = async () => {
		if (!banUser) return;
		try {
			await AdminClient.tempBanUser(banUser.id, banHours, banReason, `Enforcement action by ${adminUser?.username}`);
			setAuditLogs((prev) => [
				{
					id: `audit_${Date.now()}`,
					timestamp: new Date().toISOString(),
					actor_id: adminUser?.id || '',
					actor_username: adminUser?.username || 'admin',
					action: banHours === 0 ? 'USER_PERM_BAN' : 'USER_TEMP_BAN',
					target_id: banUser.id,
					reason: `${banHours === 0 ? 'Permanent ban' : `${banHours}h suspension`}: ${banReason}`,
				},
				...prev,
			]);
			showNotification(`Successfully suspended ${banUser.username}`);
			setBanUser(null);
			await checkAuthAndLoad();
		} catch (err) {
			showNotification(err instanceof Error ? err.message : 'Failed to suspend user', 'error');
		}
	};

	const handleUnban = async (user: AdminUser) => {
		try {
			await AdminClient.unbanUser(user.id);
			setAuditLogs((prev) => [
				{
					id: `audit_${Date.now()}`,
					timestamp: new Date().toISOString(),
					actor_id: adminUser?.id || '',
					actor_username: adminUser?.username || 'admin',
					action: 'USER_UNBAN',
					target_id: user.id,
					reason: `Suspension lifted for ${user.username}`,
				},
				...prev,
			]);
			showNotification(`Suspension lifted for ${user.username}`);
			await checkAuthAndLoad();
		} catch (err) {
			showNotification(err instanceof Error ? err.message : 'Failed to lift suspension', 'error');
		}
	};

	const handleSaveRole = async () => {
		if (!roleModalUser) return;
		try {
			const targetAcls =
				selectedRole === 'OWNER' ? OWNER_ACLS : selectedRole === 'ADMIN' ? ADMIN_ACLS : MODERATOR_ACLS;
			await AdminClient.setUserAcls(roleModalUser.id, targetAcls);
			setAuditLogs((prev) => [
				{
					id: `audit_${Date.now()}`,
					timestamp: new Date().toISOString(),
					actor_id: adminUser?.id || '',
					actor_username: adminUser?.username || 'admin',
					action: 'ACL_ROLE_UPDATE',
					target_id: roleModalUser.id,
					reason: `Assigned role ${selectedRole} to ${roleModalUser.username}`,
				},
				...prev,
			]);
			showNotification(`Updated role for ${roleModalUser.username} to ${selectedRole}`);
			setRoleModalUser(null);
			await checkAuthAndLoad();
		} catch (err) {
			showNotification(err instanceof Error ? err.message : 'Failed to update roles', 'error');
		}
	};

	// Determine Role label for display
	const getRoleLabel = (user: AdminUser | null | undefined): {name: string; color: string} => {
		if (!user) return {name: 'ADMIN', color: '#3b82f6'};
		if (user.acls?.includes('*')) return {name: 'OWNER', color: '#a855f7'};
		if (user.acls?.includes('user:temp_ban') || user.acls?.includes('user:lookup')) {
			return {name: 'ADMIN', color: '#3b82f6'};
		}
		if (user.acls?.includes('report:view') || user.acls?.includes('report:resolve')) {
			return {name: 'MODERATOR', color: '#10b981'};
		}
		return {name: 'USER', color: '#71717a'};
	};

	const canViewEmail = adminUser?.acls?.includes('*') || adminUser?.acls?.includes('user:view:email');

	// If loading administrative session
	if (isLoading) {
		return (
			<div className={styles.loginGateRoot}>
				<div style={{color: '#a1a1aa', fontSize: '0.95rem', fontWeight: 500}}>
					Verifying administrative session...
				</div>
			</div>
		);
	}

	// If not authenticated as an Admin, render the AMOLED Sign-In Gate
	if (!adminUser) {
		return (
			<div className={styles.loginGateRoot}>
				<div className={styles.loginCard}>
					<div style={{textAlign: 'center'}}>
						<div style={{display: 'inline-flex', padding: '12px', borderRadius: '12px', background: 'rgba(255,255,255,0.04)', marginBottom: '12px'}}>
							<ShieldCheckIcon size={36} color="#ffffff" weight="duotone" />
						</div>
						<div className={styles.loginTitle}>SYNC CONTROL PANEL</div>
						<div className={styles.loginSubtitle}>Authorized Administrator Authentication</div>
					</div>

					{loginError && <div className={styles.loginError}>{loginError}</div>}

					<form onSubmit={handleAdminLogin} style={{display: 'flex', flexDirection: 'column', gap: '16px'}}>
						<div className={styles.formGroup}>
							<label className={styles.formLabel}>Admin Username or Email</label>
							<input
								type="text"
								className={styles.formInput}
								value={loginUser}
								onChange={(e) => setLoginUser(e.target.value)}
								placeholder="admin username"
								required
							/>
						</div>
						<div className={styles.formGroup}>
							<label className={styles.formLabel}>Admin Password</label>
							<input
								type="password"
								className={styles.formInput}
								value={loginPass}
								onChange={(e) => setLoginPass(e.target.value)}
								placeholder="••••••••••••"
								required
							/>
						</div>
						<button type="submit" className={styles.btnPrimary} style={{marginTop: '8px', padding: '12px'}} disabled={isLoggingIn}>
							{isLoggingIn ? 'Verifying Credentials...' : 'Authenticate & Enter'}
						</button>
					</form>
					<div style={{fontSize: '0.75rem', color: '#52525b', textAlign: 'center'}}>
						Protected by Argon2id Cryptographic Signature & Admin ACL Security
					</div>
				</div>
			</div>
		);
	}

	const filteredUsers = users.filter((u) => {
		if (statusFilter === 'active') return !u.temp_banned_until;
		if (statusFilter === 'suspended') return !!u.temp_banned_until;
		return true;
	});

	return (
		<div className={styles.controlPanelRoot}>
			{/* Notification Banner */}
			{notification && (
				<div
					style={{
						position: 'fixed',
						top: '20px',
						right: '24px',
						zIndex: 9999,
						backgroundColor: notification.type === 'error' ? '#ef4444' : '#10b981',
						color: '#ffffff',
						padding: '12px 20px',
						borderRadius: '8px',
						boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
						fontWeight: 600,
						fontSize: '0.85rem',
					}}
				>
					{notification.message}
				</div>
			)}

			{/* Sidebar */}
			<aside className={styles.sidebar}>
				<div>
					<div className={styles.brandHeader}>
						<div className={styles.brandTitle}>
							SYNC <span className={styles.brandBadge}>CORE</span>
						</div>
						<div className={styles.brandSubtitle}>Control Panel & Administration</div>
					</div>

					<nav className={styles.navSection}>
						<button
							type="button"
							className={`${styles.navItem} ${activeTab === 'overview' ? styles.navItemActive : ''}`}
							onClick={() => setActiveTab('overview')}
						>
							<ChartBarIcon size={18} weight={activeTab === 'overview' ? 'fill' : 'regular'} />
							Overview
						</button>
						<button
							type="button"
							className={`${styles.navItem} ${activeTab === 'users' ? styles.navItemActive : ''}`}
							onClick={() => setActiveTab('users')}
						>
							<UsersIcon size={18} weight={activeTab === 'users' ? 'fill' : 'regular'} />
							User Management
						</button>
						<button
							type="button"
							className={`${styles.navItem} ${activeTab === 'moderation' ? styles.navItemActive : ''}`}
							onClick={() => setActiveTab('moderation')}
						>
							<ShieldSlashIcon size={18} weight={activeTab === 'moderation' ? 'fill' : 'regular'} />
							Moderation & Reports
						</button>
						<button
							type="button"
							className={`${styles.navItem} ${activeTab === 'admins' ? styles.navItemActive : ''}`}
							onClick={() => setActiveTab('admins')}
						>
							<ShieldCheckIcon size={18} weight={activeTab === 'admins' ? 'fill' : 'regular'} />
							Administrators
						</button>
						<button
							type="button"
							className={`${styles.navItem} ${activeTab === 'settings' ? styles.navItemActive : ''}`}
							onClick={() => setActiveTab('settings')}
						>
							<GearIcon size={18} weight={activeTab === 'settings' ? 'fill' : 'regular'} />
							System Settings
						</button>
					</nav>
				</div>

				<div className={styles.sidebarFooter}>
					<div className={styles.adminUserCard}>
						<div className={styles.adminUserInfo}>
							<div className={styles.adminUsername}>{adminUser?.username}</div>
							<div className={styles.adminRoleBadge}>{getRoleLabel(adminUser).name}</div>
						</div>
						<button type="button" className={styles.logoutBtn} onClick={handleLogout} title="Sign Out">
							<SignOutIcon size={18} />
						</button>
					</div>
				</div>
			</aside>

			{/* Main Content */}
			<main className={styles.mainContainer}>
				{/* Top Bar */}
				<header className={styles.topBar}>
					<div className={styles.topBarTitle}>
						{activeTab === 'overview' && 'System Overview & Health'}
						{activeTab === 'users' && 'User Directory & Account Management'}
						{activeTab === 'moderation' && 'Moderation Reports & Audit Logs'}
						{activeTab === 'admins' && 'Administrator Authority & ACL Roles'}
						{activeTab === 'settings' && 'Instance Configuration & Security'}
					</div>
					<div className={styles.topBarActions}>
						<div className={styles.systemBadge}>
							<span className={styles.systemDot} />
							<span>SYSTEM OPERATIONAL</span>
						</div>
						<button
							type="button"
							className={styles.btnSecondary}
							onClick={() => checkAuthAndLoad()}
							title="Refresh data"
						>
							<ArrowClockwiseIcon size={15} />
						</button>
					</div>
				</header>

				{/* Scrollable View Content */}
				<div className={styles.contentScrollArea}>
					{/* OVERVIEW TAB */}
					{activeTab === 'overview' && (
						<>
							<div className={styles.statsGrid}>
								<div className={styles.statCard}>
									<div className={styles.statHeader}>Total Users</div>
									<div className={styles.statValue}>{users.length}</div>
									<div className={styles.statFooter}>Accounts stored in database</div>
								</div>
								<div className={styles.statCard}>
									<div className={styles.statHeader}>Communities</div>
									<div className={styles.statValue}>1</div>
									<div className={styles.statFooter}>Default community active</div>
								</div>
								<div className={styles.statCard}>
									<div className={styles.statHeader}>Open Reports</div>
									<div className={styles.statValue}>{reports.filter((r) => r.status === 'open').length}</div>
									<div className={styles.statFooter}>Requiring moderation action</div>
								</div>
								<div className={styles.statCard}>
									<div className={styles.statHeader}>Security Protocol</div>
									<div className={styles.statValue} style={{fontSize: '1.25rem', color: '#10b981'}}>Argon2id</div>
									<div className={styles.statFooter}>Pass hashes never exposed</div>
								</div>
							</div>

							<div className={styles.panelCard}>
								<div className={styles.panelHeader}>
									<div className={styles.panelTitle}>Quick Actions</div>
								</div>
								<div style={{display: 'flex', gap: '12px', flexWrap: 'wrap'}}>
									<button type="button" className={styles.btnPrimary} onClick={() => setActiveTab('users')}>
										Manage User Accounts
									</button>
									<button type="button" className={styles.btnSecondary} onClick={() => setActiveTab('moderation')}>
										Review Reports ({reports.filter((r) => r.status === 'open').length})
									</button>
									<button type="button" className={styles.btnSecondary} onClick={() => setActiveTab('admins')}>
										Configure Admin ACLs
									</button>
								</div>
							</div>

							<div className={styles.panelCard}>
								<div className={styles.panelHeader}>
									<div className={styles.panelTitle}>Recent User Registrations</div>
								</div>
								<div className={styles.tableContainer}>
									<table className={styles.dataTable}>
										<thead>
											<tr>
												<th>User ID</th>
												<th>Username</th>
												<th>Email</th>
												<th>Role</th>
												<th>Status</th>
											</tr>
										</thead>
										<tbody>
											{users.slice(0, 5).map((u) => {
												const role = getRoleLabel(u);
												return (
													<tr key={u.id}>
														<td className={styles.idCell}>{u.id}</td>
														<td><strong>{u.username}</strong></td>
														<td>{canViewEmail ? (u.email || '—') : '•••••••• (Protected)'}</td>
														<td><span style={{color: role.color, fontWeight: 700, fontSize: '0.75rem'}}>{role.name}</span></td>
														<td>
															<span className={`${styles.statusBadge} ${u.temp_banned_until ? styles.statusSuspended : styles.statusActive}`}>
																{u.temp_banned_until ? 'Suspended' : 'Active'}
															</span>
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
							</div>
						</>
					)}

					{/* USERS TAB */}
					{activeTab === 'users' && (
						<div className={styles.panelCard}>
							<div className={styles.panelHeader}>
								<div style={{display: 'flex', gap: '12px', alignItems: 'center'}}>
									<form onSubmit={handleSearch} className={styles.searchBar}>
										<MagnifyingGlassIcon size={16} color="#71717a" />
										<input
											type="text"
											className={styles.searchInput}
											placeholder="Search by username, email, ID..."
											value={searchQuery}
											onChange={(e) => setSearchQuery(e.target.value)}
										/>
									</form>
									<select
										className={styles.formSelect}
										style={{padding: '7px 12px', fontSize: '0.8rem'}}
										value={statusFilter}
										onChange={(e) => setStatusFilter(e.target.value as any)}
									>
										<option value="all">All Statuses</option>
										<option value="active">Active Only</option>
										<option value="suspended">Suspended Only</option>
									</select>
								</div>
								<div style={{fontSize: '0.8rem', color: '#71717a'}}>
									{filteredUsers.length} user{filteredUsers.length === 1 ? '' : 's'} found
								</div>
							</div>

							<div className={styles.tableContainer}>
								<table className={styles.dataTable}>
									<thead>
										<tr>
											<th>User ID</th>
											<th>User</th>
											<th>Display Name</th>
											<th>Email Address</th>
											<th>Role</th>
											<th>Status</th>
											<th>Actions</th>
										</tr>
									</thead>
									<tbody>
										{filteredUsers.map((u) => {
											const role = getRoleLabel(u);
											const isSuspended = !!u.temp_banned_until;
											return (
												<tr key={u.id}>
													<td className={styles.idCell}>{u.id}</td>
													<td>
														<div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
															<div style={{width: '28px', height: '28px', borderRadius: '50%', background: '#27272a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.75rem'}}>
																{u.username.charAt(0).toUpperCase()}
															</div>
															<div>
																<div style={{fontWeight: 600, color: '#ffffff'}}>{u.username}</div>
															</div>
														</div>
													</td>
													<td>{u.global_name || '—'}</td>
													<td>{canViewEmail ? (u.email || '—') : <span style={{color: '#52525b'}}>•••••••• (Permission Required)</span>}</td>
													<td>
														<span style={{color: role.color, fontWeight: 700, fontSize: '0.72rem'}}>
															{role.name}
														</span>
													</td>
													<td>
														<span className={`${styles.statusBadge} ${isSuspended ? styles.statusSuspended : styles.statusActive}`}>
															{isSuspended ? 'Suspended' : 'Active'}
														</span>
													</td>
													<td>
														<div className={styles.actionBtnRow}>
															<button
																type="button"
																className={styles.btnSecondary}
																onClick={() => setDetailUser(u)}
																title="View details"
															>
																Details
															</button>
															<button
																type="button"
																className={styles.btnSecondary}
																onClick={() => handleCreateResetLink(u)}
																title="Generate Reset Link"
															>
																Reset Link
															</button>
															{isSuspended ? (
																<button
																	type="button"
																	className={styles.btnSecondary}
																	style={{borderColor: '#10b981', color: '#10b981'}}
																	onClick={() => handleUnban(u)}
																>
																	Unsuspend
																</button>
															) : (
																<button
																	type="button"
																	className={styles.btnDanger}
																	onClick={() => setBanUser(u)}
																>
																	Suspend
																</button>
															)}
															<button
																type="button"
																className={styles.btnSecondary}
																onClick={() => handleTerminateSessions(u)}
																title="Force Logout"
															>
																Revoke Sessions
															</button>
														</div>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						</div>
					)}

					{/* MODERATION TAB */}
					{activeTab === 'moderation' && (
						<>
							<div className={styles.panelCard}>
								<div className={styles.panelHeader}>
									<div className={styles.panelTitle}>Content & User Reports</div>
								</div>
								<div className={styles.tableContainer}>
									<table className={styles.dataTable}>
										<thead>
											<tr>
												<th>Report ID</th>
												<th>Reported User</th>
												<th>Reason</th>
												<th>Submitted Date</th>
												<th>Status</th>
												<th>Action</th>
											</tr>
										</thead>
										<tbody>
											{reports.map((rep) => (
												<tr key={rep.id}>
													<td className={styles.idCell}>{rep.id}</td>
													<td className={styles.idCell}>{rep.reported_user_id}</td>
													<td>{rep.reason}</td>
													<td>{new Date(rep.created_at).toLocaleString()}</td>
													<td>
														<span className={`${styles.statusBadge} ${rep.status === 'open' ? styles.statusPending : styles.statusActive}`}>
															{rep.status}
														</span>
													</td>
													<td>
														<div className={styles.actionBtnRow}>
															<button
																type="button"
																className={styles.btnPrimary}
																style={{fontSize: '0.75rem', padding: '4px 8px'}}
																onClick={() => {
																	setReports((prev) =>
																		prev.map((r) => (r.id === rep.id ? {...r, status: 'resolved'} : r)),
																	);
																	showNotification(`Report ${rep.id} resolved`);
																}}
															>
																Resolve
															</button>
															<button
																type="button"
																className={styles.btnSecondary}
																style={{fontSize: '0.75rem', padding: '4px 8px'}}
																onClick={() => {
																	setReports((prev) =>
																		prev.map((r) => (r.id === rep.id ? {...r, status: 'dismissed'} : r)),
																	);
																	showNotification(`Report ${rep.id} dismissed`);
																}}
															>
																Dismiss
															</button>
														</div>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</div>

							<div className={styles.panelCard}>
								<div className={styles.panelHeader}>
									<div className={styles.panelTitle}>Administrative Audit Trail</div>
								</div>
								<div className={styles.tableContainer}>
									<table className={styles.dataTable}>
										<thead>
											<tr>
												<th>Timestamp</th>
												<th>Admin Actor</th>
												<th>Action Kind</th>
												<th>Target User</th>
												<th>Reason / Details</th>
											</tr>
										</thead>
										<tbody>
											{auditLogs.map((log) => (
												<tr key={log.id}>
													<td style={{fontSize: '0.78rem', color: '#71717a'}}>{new Date(log.timestamp).toLocaleTimeString()}</td>
													<td><strong>{log.actor_username}</strong></td>
													<td><span className={styles.statusBadge} style={{background: 'rgba(255,255,255,0.06)', color: '#ffffff'}}>{log.action}</span></td>
													<td className={styles.idCell}>{log.target_id || '—'}</td>
													<td>{log.reason || '—'}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</div>
						</>
					)}

					{/* ADMINISTRATORS TAB */}
					{activeTab === 'admins' && (
						<div className={styles.panelCard}>
							<div className={styles.panelHeader}>
								<div className={styles.panelTitle}>Authorized Administrators & Roles</div>
							</div>
							<div className={styles.tableContainer}>
								<table className={styles.dataTable}>
									<thead>
										<tr>
											<th>User ID</th>
											<th>Administrator</th>
											<th>Assigned Role</th>
											<th>Configured ACLs</th>
											<th>Actions</th>
										</tr>
									</thead>
									<tbody>
										{users.map((u) => {
											const role = getRoleLabel(u);
											return (
												<tr key={u.id}>
													<td className={styles.idCell}>{u.id}</td>
													<td><strong>{u.username}</strong></td>
													<td><span style={{color: role.color, fontWeight: 700}}>{role.name}</span></td>
													<td>
														<code style={{fontSize: '0.75rem', color: '#a1a1aa'}}>
															{u.acls?.length ? u.acls.join(', ') : 'standard_user'}
														</code>
													</td>
													<td>
														<button
															type="button"
															className={styles.btnSecondary}
															onClick={() => {
																setRoleModalUser(u);
																setSelectedRole(role.name === 'OWNER' ? 'OWNER' : role.name === 'MODERATOR' ? 'MODERATOR' : 'ADMIN');
															}}
														>
															Modify Authority
														</button>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						</div>
					)}

					{/* SETTINGS TAB */}
					{activeTab === 'settings' && (
						<div className={styles.panelCard}>
							<div className={styles.panelHeader}>
								<div className={styles.panelTitle}>SYNC Instance Configuration & Cryptography</div>
							</div>
							<div style={{display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '640px'}}>
								<div style={{display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '12px'}}>
									<span style={{color: '#71717a'}}>Platform Name:</span>
									<strong style={{color: '#ffffff'}}>SYNC (by GIGABOIZ)</strong>
								</div>
								<div style={{display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '12px'}}>
									<span style={{color: '#71717a'}}>API Version:</span>
									<span style={{fontFamily: 'monospace', color: '#a1a1aa'}}>SYNC API v1 (Code Version 1)</span>
								</div>
								<div style={{display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '12px'}}>
									<span style={{color: '#71717a'}}>Password Security Standard:</span>
									<span style={{color: '#34d399', fontWeight: 600}}>Argon2id Salted Hashing</span>
								</div>
								<div style={{display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '12px'}}>
									<span style={{color: '#71717a'}}>Hash Exposure Policy:</span>
									<span style={{color: '#34d399', fontWeight: 600}}>RESTRICTED (Never exposed to APIs or Admin)</span>
								</div>
								<div style={{display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '12px'}}>
									<span style={{color: '#71717a'}}>Database Backend:</span>
									<span style={{color: '#ffffff'}}>InMemory Cassandra/Postgres Query Executor</span>
								</div>
								<div style={{display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '12px'}}>
									<span style={{color: '#71717a'}}>Search Engine:</span>
									<span style={{color: '#ffffff'}}>InMemory Search Provider (Users, Guilds, Reports)</span>
								</div>
							</div>
						</div>
					)}
				</div>
			</main>

			{/* USER DETAILS MODAL */}
			{detailUser && (
				<div className={styles.modalBackdrop} onClick={() => setDetailUser(null)}>
					<div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
						<div className={styles.modalHeader}>
							<div className={styles.modalTitle}>User Account Profile</div>
							<button type="button" className={styles.modalClose} onClick={() => setDetailUser(null)}>✕</button>
						</div>
						<div style={{display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.85rem'}}>
							<div><span style={{color: '#71717a'}}>User ID:</span> <code style={{color: '#ffffff'}}>{detailUser.id}</code></div>
							<div><span style={{color: '#71717a'}}>Username:</span> <strong>{detailUser.username}</strong></div>
							<div><span style={{color: '#71717a'}}>Global Display Name:</span> {detailUser.global_name || 'None'}</div>
							<div><span style={{color: '#71717a'}}>Email:</span> {canViewEmail ? (detailUser.email || 'None') : '•••••••• (Protected)'}</div>
							<div><span style={{color: '#71717a'}}>Account Tier:</span> <span className={styles.statusBadge} style={{background: 'rgba(255,255,255,0.06)'}}>{detailUser.account_tier}</span></div>
							<div><span style={{color: '#71717a'}}>Last Active IP:</span> <code style={{color: '#a1a1aa'}}>{detailUser.last_active_ip || 'None'}</code></div>
							<div><span style={{color: '#71717a'}}>Has Password Set:</span> {detailUser.has_password ? 'Yes (Argon2id Encrypted)' : 'No'}</div>
							<div><span style={{color: '#71717a'}}>Admin ACLs:</span> {detailUser.acls?.join(', ') || 'None'}</div>
						</div>
						<div style={{display: 'flex', justifyContent: 'flex-end', marginTop: '16px'}}>
							<button type="button" className={styles.btnSecondary} onClick={() => setDetailUser(null)}>
								Close
							</button>
						</div>
					</div>
				</div>
			)}

			{/* SUSPEND / BAN MODAL */}
			{banUser && (
				<div className={styles.modalBackdrop} onClick={() => setBanUser(null)}>
					<div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
						<div className={styles.modalHeader}>
							<div className={styles.modalTitle}>Suspend Account: {banUser.username}</div>
							<button type="button" className={styles.modalClose} onClick={() => setBanUser(null)}>✕</button>
						</div>
						<div className={styles.formGroup}>
							<label className={styles.formLabel}>Suspension Duration</label>
							<select
								className={styles.formSelect}
								value={banHours}
								onChange={(e) => setBanHours(Number(e.target.value))}
							>
								<option value={1}>1 Hour (Temporary)</option>
								<option value={24}>24 Hours (1 Day)</option>
								<option value={168}>7 Days (1 Week)</option>
								<option value={720}>30 Days (1 Month)</option>
								<option value={0}>Permanent Suspension (Closure)</option>
							</select>
						</div>
						<div className={styles.formGroup}>
							<label className={styles.formLabel}>Public Notice / Reason</label>
							<input
								type="text"
								className={styles.formInput}
								value={banReason}
								onChange={(e) => setBanReason(e.target.value)}
							/>
						</div>
						<div style={{display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px'}}>
							<button type="button" className={styles.btnSecondary} onClick={() => setBanUser(null)}>
								Cancel
							</button>
							<button type="button" className={styles.btnDanger} onClick={handleConfirmBan}>
								Confirm Suspension
							</button>
						</div>
					</div>
				</div>
			)}

			{/* PASSWORD RESET LINK MODAL */}
			{resetLinkData && (
				<div className={styles.modalBackdrop} onClick={() => setResetLinkData(null)}>
					<div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
						<div className={styles.modalHeader}>
							<div className={styles.modalTitle}>Password Reset Link</div>
							<button type="button" className={styles.modalClose} onClick={() => setResetLinkData(null)}>✕</button>
						</div>
						<div style={{fontSize: '0.85rem', color: '#a1a1aa'}}>
							A single-use password reset link has been created for <strong>{resetLinkData.username}</strong>:
						</div>
						<div style={{display: 'flex', gap: '8px'}}>
							<input
								type="text"
								readOnly
								className={styles.formInput}
								style={{flex: 1, fontFamily: 'monospace', fontSize: '0.78rem'}}
								value={resetLinkData.url}
							/>
							<button
								type="button"
								className={styles.btnPrimary}
								onClick={() => {
									navigator.clipboard.writeText(resetLinkData.url);
									showNotification('Link copied to clipboard');
								}}
							>
								<CopyIcon size={16} />
							</button>
						</div>
						<div style={{display: 'flex', justifyContent: 'flex-end', marginTop: '12px'}}>
							<button type="button" className={styles.btnSecondary} onClick={() => setResetLinkData(null)}>
								Done
							</button>
						</div>
					</div>
				</div>
			)}

			{/* ROLE MODIFICATION MODAL */}
			{roleModalUser && (
				<div className={styles.modalBackdrop} onClick={() => setRoleModalUser(null)}>
					<div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
						<div className={styles.modalHeader}>
							<div className={styles.modalTitle}>Modify Authority: {roleModalUser.username}</div>
							<button type="button" className={styles.modalClose} onClick={() => setRoleModalUser(null)}>✕</button>
						</div>
						<div className={styles.formGroup}>
							<label className={styles.formLabel}>Select Administrator Tier</label>
							<select
								className={styles.formSelect}
								value={selectedRole}
								onChange={(e) => setSelectedRole(e.target.value as any)}
							>
								<option value="OWNER">OWNER — Full Access (Wildcard *)</option>
								<option value="ADMIN">ADMIN — User Management, Temp Ban, Reset Links, Sessions</option>
								<option value="MODERATOR">MODERATOR — Reports & Resolutions (No Email Access)</option>
							</select>
						</div>
						<div style={{fontSize: '0.78rem', color: '#71717a'}}>
							{selectedRole === 'OWNER' && 'Grants unconditional administrative control over all resources and settings.'}
							{selectedRole === 'ADMIN' && 'Can manage users, revoke sessions, generate reset links, and apply suspensions.'}
							{selectedRole === 'MODERATOR' && 'Restricted to reviewing and resolving moderation reports. Cannot view email addresses.'}
						</div>
						<div style={{display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px'}}>
							<button type="button" className={styles.btnSecondary} onClick={() => setRoleModalUser(null)}>
								Cancel
							</button>
							<button type="button" className={styles.btnPrimary} onClick={handleSaveRole}>
								Save Role
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
export default SyncControlPanel;

