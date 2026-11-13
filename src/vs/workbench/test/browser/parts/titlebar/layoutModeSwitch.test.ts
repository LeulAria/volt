/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { openAgentSidebar } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';

suite('openAgentSidebar', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function run(focus?: boolean): Promise<{ location: ViewContainerLocation | undefined; focus: boolean | undefined }[]> {
		const opened: { location: ViewContainerLocation | undefined; focus: boolean | undefined }[] = [];
		const layout = {
			mainContainer: document.createElement('div'),
			isAuxiliaryBarMaximized: () => false,
			isVisible: () => true,
			getSize: () => ({ width: 400, height: 800 }),
			setSize: () => { },
			setPartHidden: () => { },
		} as unknown as IWorkbenchLayoutService;
		const panes = {
			openPaneComposite: async (_id: string | undefined, location: ViewContainerLocation, focusIt?: boolean) => {
				opened.push({ location, focus: focusIt });
				return undefined;
			},
		} as unknown as IPaneCompositePartService;
		const config = {} as IConfigurationService;
		return (focus === undefined ? openAgentSidebar(config, layout, panes) : openAgentSidebar(config, layout, panes, focus)).then(() => opened);
	}

	test('a user opening the list moves the keyboard into it', async () => {
		assert.deepStrictEqual(await run(), [{ location: ViewContainerLocation.AuxiliaryBar, focus: true }]);
	});

	test('the window opening shows the list without taking focus from the composer', async () => {
		assert.deepStrictEqual(await run(false), [{ location: ViewContainerLocation.AuxiliaryBar, focus: false }]);
	});
});
