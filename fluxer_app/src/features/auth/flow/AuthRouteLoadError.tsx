// SPDX-License-Identifier: AGPL-3.0-or-later

import {getActiveInstanceProductName} from '@app/features/app/state/ActiveInstanceProductName';
import styles from '@app/features/auth/flow/AuthPageStyles.module.css';
import type {LoadableErrorProps} from '@app/features/platform/components/loadable/LoadableComponent';
import {Button} from '@app/features/ui/button/Button';
import {ph} from '@lingui/core/macro';
import {Trans} from '@lingui/react/macro';
import type React from 'react';

export function AuthRouteLoadError({error, retry}: LoadableErrorProps): React.JSX.Element {
	console.error('[AuthRouteLoadError] Route failed to load:', error);

	let errorMessage = 'An error occurred while loading this page.';
	if (error instanceof Error) {
		errorMessage = `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
	} else if (typeof error === 'string') {
		errorMessage = error;
	} else if (error) {
		try {
			errorMessage = JSON.stringify(error, Object.getOwnPropertyNames(error as object), 2);
		} catch {
			errorMessage = String(error);
		}
	} else {
		errorMessage = 'Error object is undefined or null';
	}

	return (
		<div className={styles.errorContainer} data-flx="auth.flow.auth-route-load-error.container">
			<div className={styles.errorTitle} data-flx="auth.flow.auth-route-load-error.title">
				<Trans>Could not load this page</Trans>
			</div>
			<div className={styles.errorText} data-flx="auth.flow.auth-route-load-error.text">
				<Trans>
					Try again, or refresh {ph({productName: getActiveInstanceProductName()})} if the problem continues.
				</Trans>
			</div>
			<pre
				style={{
					color: '#ff6b6b',
					backgroundColor: 'rgba(255, 0, 0, 0.1)',
					padding: '8px 12px',
					borderRadius: '6px',
					fontSize: '0.75rem',
					marginTop: '0.75rem',
					marginBottom: '0.75rem',
					wordBreak: 'break-all',
					whiteSpace: 'pre-wrap',
					textAlign: 'left',
					maxHeight: '180px',
					overflowY: 'auto',
				}}
			>
				{errorMessage}
			</pre>
			<div className={styles.disabledActions} data-flx="auth.flow.auth-route-load-error.actions">
				<Button onClick={retry} fitContainer data-flx="auth.flow.auth-route-load-error.retry">
					<Trans>Try again</Trans>
				</Button>
			</div>
		</div>
	);
}
