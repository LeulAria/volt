/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { prKey } from '../../../../../platform/voltPullRequests/common/voltPullRequestParse.js';
import { IVoltPrRepoRef } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput, Verbosity } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';

export const AGENT_PULL_REQUEST_SCHEME = 'volt-agent-pr';
export const AGENT_PULL_REQUEST_EDITOR_ID = 'workbench.editor.voltAgentPullRequest';

/** An open pull request, or the form for a new one from `folder`. */
export type AgentPullRequestTarget =
	| { readonly kind: 'pr'; readonly repo: IVoltPrRepoRef; readonly number: number }
	| { readonly kind: 'new'; readonly folder: string };

export function pullRequestUri(target: AgentPullRequestTarget): URI {
	return target.kind === 'pr'
		? URI.from({ scheme: AGENT_PULL_REQUEST_SCHEME, path: `/${target.repo.host}/${target.repo.owner}/${target.repo.name}/${target.number}` })
		: URI.from({ scheme: AGENT_PULL_REQUEST_SCHEME, path: '/new', query: `folder=${encodeURIComponent(target.folder)}` });
}

export function parsePullRequestUri(uri: URI): AgentPullRequestTarget | undefined {
	if (uri.scheme !== AGENT_PULL_REQUEST_SCHEME) {
		return undefined;
	}
	if (uri.path === '/new') {
		const folder = new URLSearchParams(uri.query).get('folder');
		return folder ? { kind: 'new', folder } : undefined;
	}
	const match = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(\d+)$/.exec(uri.path);
	if (!match) {
		return undefined;
	}
	const number = Number(match[4]);
	return number > 0 ? { kind: 'pr', repo: { host: match[1], owner: match[2], name: match[3] }, number } : undefined;
}

/**
 * The pull request view as an editor tab, opened in a chat's tools beside the chat (or the main
 * editor in the IDE layout). `sessionId` is the chat it was opened for: "Fix this" writes there.
 */
export class AgentPullRequestEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.input.voltAgentPullRequest';

	readonly resource: URI;

	constructor(
		readonly target: AgentPullRequestTarget,
		public sessionId: string | undefined,
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
	) {
		super();
		this.resource = pullRequestUri(target);
		if (target.kind === 'pr') {
			const key = prKey(target.repo, target.number);
			this._register(this.pullRequests.onDidChangePullRequest(changed => {
				if (changed === key) {
					this._onDidChangeLabel.fire();
				}
			}));
		}
	}

	override get typeId(): string {
		return AgentPullRequestEditorInput.TypeID;
	}

	override get editorId(): string {
		return AGENT_PULL_REQUEST_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		if (this.target.kind === 'new') {
			return localize('voltPr.newTab', "New Pull Request");
		}
		const title = this.pullRequests.snapshot(prKey(this.target.repo, this.target.number))?.title;
		return title ? `#${this.target.number} ${title}` : localize('voltPr.tab', "Pull Request #{0}", this.target.number);
	}

	override getDescription(verbosity?: Verbosity): string | undefined {
		if (this.target.kind === 'new') {
			return undefined;
		}
		return verbosity === Verbosity.LONG ? `${this.target.repo.host}/${this.target.repo.owner}/${this.target.repo.name}` : `${this.target.repo.owner}/${this.target.repo.name}`;
	}

	override getTitle(verbosity?: Verbosity): string {
		const description = this.getDescription(verbosity);
		return description ? `${this.getName()} · ${description}` : this.getName();
	}

	override getIcon(): ThemeIcon {
		return Codicon.gitPullRequest;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof AgentPullRequestEditorInput && other.resource.toString() === this.resource.toString();
	}

	override toUntyped(): IUntypedEditorInput {
		return { resource: this.resource, options: { override: AGENT_PULL_REQUEST_EDITOR_ID } };
	}
}

interface ISerialized {
	readonly uri: string;
	readonly sessionId?: string;
}

export class AgentPullRequestEditorInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(input: AgentPullRequestEditorInput): string {
		return JSON.stringify({ uri: input.resource.toString(), ...(input.sessionId ? { sessionId: input.sessionId } : {}) } satisfies ISerialized);
	}

	deserialize(instantiationService: IInstantiationService, raw: string): AgentPullRequestEditorInput | undefined {
		try {
			const parsed = JSON.parse(raw) as ISerialized;
			const target = parsePullRequestUri(URI.parse(parsed.uri));
			return target ? instantiationService.createInstance(AgentPullRequestEditorInput, target, parsed.sessionId) : undefined;
		} catch {
			return undefined;
		}
	}
}
