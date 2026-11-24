// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/features/platform/utils/AppLogger';
import * as AccessibilityCommands from '@app/features/accessibility/commands/AccessibilityCommands';
import AccountTheme from '@app/features/theme/state/AccountTheme';
import AccountThemeMode from '@app/features/theme/state/AccountThemeMode';
import InstallationTheme from '@app/features/theme/state/InstallationTheme';
import ThemeEditTarget, {type ThemeTarget} from '@app/features/theme/state/ThemeEditTarget';
import ThemeLibrary from '@app/features/theme/state/ThemeLibrary';
import * as UserSettingsCommands from '@app/features/user/commands/UserSettingsCommands';
import type {ThemeType} from '@fluxer/constants/src/UserConstants';
import {runInAction} from 'mobx';

const logger = new Logger('ThemeProfileCommands');

export function setThemePreference(theme: ThemeType, target: ThemeTarget): void {
	if (target === 'desktop') {
		InstallationTheme.setBaseTheme(theme);
		return;
	}
	AccountTheme.setTheme(theme);
	InstallationTheme.setBaseTheme(theme);
	if (AccountTheme.syncAcrossDevices) {
		void UserSettingsCommands.update({theme}).catch((err) => {
			logger.warn('Failed to sync theme preference to server', err);
		});
	}
}

export function setSignedOutThemePreference(theme: ThemeType): void {
	InstallationTheme.setBaseTheme(theme);
	AccountTheme.setTheme(theme);
}

export function setSyncAcrossDevices(sync: boolean): void {
	AccountTheme.setSyncAcrossDevices(sync);
}

export function setCustomThemeCss(css: string | null, target: ThemeTarget): void {
	if (target === 'desktop') {
		InstallationTheme.setCustomThemeCss(css);
		return;
	}
	AccessibilityCommands.update({customThemeCss: css});
}

export async function setThemeEnabled(id: string, enabled: boolean, target: ThemeTarget): Promise<void> {
	await ThemeLibrary.setThemeEnabled(id, enabled, target);
}

export async function moveEnabledTheme(id: string, offset: -1 | 1, target: ThemeTarget): Promise<void> {
	await ThemeLibrary.moveEnabledTheme(id, offset, target);
}

export function setFollowDesktopTheme(value: boolean): void {
	runInAction(() => {
		AccountThemeMode.setFollowDesktopTheme(value);
		ThemeEditTarget.reset();
	});
}

export function pickEditTarget(target: ThemeTarget | null): void {
	ThemeEditTarget.pick(target);
}
