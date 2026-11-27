// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	clearSavedBackendOrigin,
	getBuildConfiguredBackendOrigin,
	getSavedBackendOrigin,
	normalizeBackendOrigin,
	setSavedBackendOrigin,
} from '@app/features/app/config/BackendRuntimeOrigin';
import {getActiveInstanceProductName} from '@app/features/app/state/ActiveInstanceProductName';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import styles from '@app/features/auth/flow/AuthPageStyles.module.css';
import type {LoadableErrorProps} from '@app/features/platform/components/loadable/LoadableComponent';
import {Button} from '@app/features/ui/button/Button';
import {
	InstanceDiscoveryOriginMismatchError,
	InstanceDiscoveryUnreachableError,
	InvalidInstanceDiscoveryDocumentError,
} from '@fluxer/instance_bootstrap/src/Discovery';
import {ph} from '@lingui/core/macro';
import {Trans} from '@lingui/react/macro';
import type React from 'react';
import {type FormEvent, useEffect, useRef, useState} from 'react';

function isInstanceDiscoveryError(error: unknown): boolean {
	return (
		error instanceof InstanceDiscoveryUnreachableError ||
		error instanceof InstanceDiscoveryOriginMismatchError ||
		error instanceof InvalidInstanceDiscoveryDocumentError
	);
}

function formatTechnicalDetails(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
	}
	if (typeof error === 'string') {
		return error;
	}
	if (error) {
		try {
			return JSON.stringify(error, Object.getOwnPropertyNames(error as object), 2);
		} catch {
			return String(error);
		}
	}
	return 'Unknown route load error';
}

export function AuthRouteLoadError({error, retry}: LoadableErrorProps): React.JSX.Element {
	console.error('[AuthRouteLoadError] Route failed to load:', error);

	const savedOrigin = getSavedBackendOrigin();
	const configuredOrigin = getBuildConfiguredBackendOrigin();
	const activeTargetOrigin = savedOrigin ?? configuredOrigin;
	const discoveryError = isInstanceDiscoveryError(error);
	const [serverInput, setServerInput] = useState(activeTargetOrigin ?? '');
	const [connectError, setConnectError] = useState<string | null>(null);
	const [connecting, setConnecting] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => () => abortRef.current?.abort(), []);

	const productName = getActiveInstanceProductName();
	const technicalDetails = formatTechnicalDetails(error);

	const handleConnectSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const normalized = normalizeBackendOrigin(serverInput);
		if (normalized === null) {
			setConnectError('Enter a valid http:// or https:// SYNC backend server URL.');
			return;
		}
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		setConnecting(true);
		setConnectError(null);
		try {
			await RuntimeConfig.resolveEndpoint({input: normalized, signal: controller.signal});
			if (controller.signal.aborted) {
				return;
			}
			setSavedBackendOrigin(normalized);
			retry();
		} catch (connectErr) {
			if (controller.signal.aborted) {
				return;
			}
			const host = (() => {
				try {
					return new URL(normalized).host;
				} catch {
					return normalized;
				}
			})();
			setConnectError(
				connectErr instanceof InstanceDiscoveryOriginMismatchError
					? `${host} declared a mismatched API origin. Verify its public URL matches ${normalized}.`
					: `Could not reach the ${productName} backend at ${host}. Check that the server is running and allows this web origin.`,
			);
		} finally {
			if (!controller.signal.aborted) {
				setConnecting(false);
			}
		}
	};

	const handleResetSavedServer = () => {
		abortRef.current?.abort();
		clearSavedBackendOrigin();
		setServerInput(configuredOrigin ?? '');
		setConnectError(null);
		retry();
	};

	return (
		<div className={styles.errorContainer} data-flx="auth.flow.auth-route-load-error.container">
			<div className={styles.errorTitle} data-flx="auth.flow.auth-route-load-error.title">
				{discoveryError ? (
					<Trans>Connect to {ph({productName})}</Trans>
				) : (
					<Trans>Could not load this page</Trans>
				)}
			</div>
			<div className={styles.errorText} data-flx="auth.flow.auth-route-load-error.text">
				{discoveryError ? (
					activeTargetOrigin ? (
						<Trans>
							Could not reach the {ph({productName})} backend server at {ph({origin: activeTargetOrigin})}.
							Check that the server is online, or enter another backend URL below.
						</Trans>
					) : (
						<Trans>
							This web frontend is not connected to a {ph({productName})} backend server yet. Enter your
							hosted backend URL (Railway, Render, VPS, or local server) below, or configure
							SYNC_BACKEND_URL in Vercel.
						</Trans>
					)
				) : (
					<Trans>
						Try again, or refresh {ph({productName})} if the problem continues.
					</Trans>
				)}
			</div>
			{discoveryError && (
				<form
					onSubmit={handleConnectSubmit}
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: '0.625rem',
						width: '100%',
						marginTop: '0.25rem',
					}}
				>
					<input
						type="url"
						inputMode="url"
						value={serverInput}
						onChange={(e) => {
							setServerInput(e.target.value);
							if (connectError) setConnectError(null);
						}}
						placeholder="https://your-sync-backend.up.railway.app"
						disabled={connecting}
						aria-label="SYNC backend server URL"
						style={{
							width: '100%',
							boxSizing: 'border-box',
							padding: '0.625rem 0.75rem',
							borderRadius: 'var(--radius-md, 8px)',
							border: '1px solid var(--background-modifier-accent, rgba(255, 255, 255, 0.16))',
							backgroundColor: 'var(--input-background, rgba(0, 0, 0, 0.25))',
							color: 'var(--text-primary, #ffffff)',
							fontSize: '0.875rem',
							outline: 'none',
						}}
					/>
					{connectError && (
						<div
							style={{
								color: 'var(--text-danger, #ff6b6b)',
								fontSize: '0.75rem',
								textAlign: 'left',
							}}
						>
							{connectError}
						</div>
					)}
					<Button type="submit" submitting={connecting} fitContainer data-flx="auth.flow.auth-route-load-error.connect">
						<Trans>Connect server</Trans>
					</Button>
				</form>
			)}
			<details style={{width: '100%', textAlign: 'left'}}>
				<summary
					style={{
						cursor: 'pointer',
						fontSize: '0.75rem',
						color: 'var(--text-tertiary)',
						userSelect: 'none',
					}}
				>
					Technical details
				</summary>
				<pre
					style={{
						color: '#ff6b6b',
						backgroundColor: 'rgba(255, 0, 0, 0.08)',
						padding: '8px 12px',
						borderRadius: '6px',
						fontSize: '0.72rem',
						marginTop: '0.5rem',
						wordBreak: 'break-all',
						whiteSpace: 'pre-wrap',
						textAlign: 'left',
						maxHeight: '160px',
						overflowY: 'auto',
					}}
				>
					{technicalDetails}
				</pre>
			</details>
			<div className={styles.disabledActions} data-flx="auth.flow.auth-route-load-error.actions">
				<Button
					variant={discoveryError ? 'secondary' : 'primary'}
					onClick={retry}
					disabled={connecting}
					fitContainer
					data-flx="auth.flow.auth-route-load-error.retry"
				>
					<Trans>Try again</Trans>
				</Button>
				{discoveryError && savedOrigin !== null && (
					<Button
						variant="secondary"
						onClick={handleResetSavedServer}
						disabled={connecting}
						fitContainer
					>
						<Trans>Reset saved server</Trans>
					</Button>
				)}
			</div>
		</div>
	);
}
