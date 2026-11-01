/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

export const AGENT_PULL_REQUESTS_PAGE_EDITOR_ID = 'workbench.editor.voltPullRequestsPage';
const AGENT_PULL_REQUESTS_PAGE_INPUT_ID = 'workbench.input.voltPullRequestsPage';

/**
 * The Pull Requests dashboard: a page of the agent window, like Usage and Automations. Kept apart
 * from the page itself so layout code can recognise it without importing the page.
 */
export class AgentPullRequestsPageInput extends EditorInput {

	static readonly TypeID = AGENT_PULL_REQUESTS_PAGE_INPUT_ID;
	static readonly EditorID = AGENT_PULL_REQUESTS_PAGE_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltPullRequests, path: 'pull-requests' });

	/** The chat it was opened from: its folder is the repository shown first. */
	sessionId: string | undefined;
	/** The repository folder picked on the page, kept across reloads. */
	folder: string | undefined;

	override get typeId(): string {
		return AgentPullRequestsPageInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentPullRequestsPageInput.EditorID;
	}

	override getName(): string {
		return localize('voltPrPage.tab', "Pull Requests");
	}

	override getIcon(): ThemeIcon {
		return Codicon.gitPullRequest;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof AgentPullRequestsPageInput;
	}
}

export class AgentPullRequestsPageInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(input: EditorInput): string {
		const folder = input instanceof AgentPullRequestsPageInput ? input.folder : undefined;
		return folder ? JSON.stringify({ folder }) : '';
	}
	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput {
		const input = instantiationService.createInstance(AgentPullRequestsPageInput);
		try {
			const value = raw ? JSON.parse(raw) as { folder?: unknown } : {};
			if (typeof value.folder === 'string') {
				input.folder = value.folder;
			}
		} catch {
			// The chat's repository.
		}
		return input;
	}
}
