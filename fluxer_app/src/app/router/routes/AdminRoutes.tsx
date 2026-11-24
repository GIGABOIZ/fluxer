// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import {rootRoute} from '@app/app/router/routes/RootRoutes';
import {createRoute} from '@app/features/platform/components/router/RouterBuilder';
import {SyncControlPanel} from '@app/features/admin/SyncControlPanel';

export const adminRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: 'admin',
	path: Routes.ADMIN,
	component: () => <SyncControlPanel data-flx="app.router.admin-routes.sync-control-panel" />,
});

