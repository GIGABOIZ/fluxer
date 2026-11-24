// SPDX-License-Identifier: AGPL-3.0-or-later

export const IS_DEV = Boolean(import.meta.env?.DEV);
export const MODE = import.meta.env?.MODE ?? 'development';
