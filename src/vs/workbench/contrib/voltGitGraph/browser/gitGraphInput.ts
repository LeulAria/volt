/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { GIT_GRAPH_INPUT_TYPE_ID } from '../common/voltGitGraph.js';

/** The Git Graph tab's input and its serializer, registered by the module (`voltGitGraph.module.ts`). */

export const GIT_GRAPH_EDITOR_ID = 'workbench.editor.voltGitGraph';

export interface IGitGraphRequest {
	/** A search to run, in the history provider's query syntax (`author:`, `path:`, `lines:`…). */
	readonly query?: string;
	/** A commit to scroll to and select. */
	readonly reveal?: string;
}

export class GitGraphEditorInput extends EditorInput {

	static readonly TypeID = GIT_GRAPH_INPUT_TYPE_ID;
	static readonly EditorID = GIT_GRAPH_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltGitGraph, path: '/graph' });

	/** The repository's root (fsPath); the active repository when unset. */
	repositoryRoot: string | undefined;
	private pending: IGitGraphRequest | undefined;

	private readonly _onDidRequest = this._register(new Emitter<void>());
	readonly onDidRequest = this._onDidRequest.event;

	override get typeId(): string { return GitGraphEditorInput.TypeID; }
	override get editorId(): string | undefined { return GitGraphEditorInput.EditorID; }

	override getName(): string {
		return localize('voltGitGraph.tab', "Git Graph");
	}

	override getTitle(): string {
		return this.repositoryRoot
			? localize('voltGitGraph.tabTitle', "Git Graph · {0}", basename(URI.file(this.repositoryRoot)))
			: this.getName();
	}

	override getIcon(): ThemeIcon {
		return Codicon.sourceControl;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof GitGraphEditorInput;
	}

	/** Asks the open pane (or the next one) to search or reveal. */
	request(request: IGitGraphRequest | undefined): void {
		this.pending = request;
		this._onDidRequest.fire();
	}

	takeRequest(): IGitGraphRequest | undefined {
		const request = this.pending;
		this.pending = undefined;
		return request;
	}
}

export class GitGraphEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(input: EditorInput): string {
		return input instanceof GitGraphEditorInput && input.repositoryRoot ? JSON.stringify({ root: input.repositoryRoot }) : '';
	}
	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput {
		const input = instantiationService.createInstance(GitGraphEditorInput);
		try {
			const value = raw ? JSON.parse(raw) as { root?: unknown } : {};
			if (typeof value.root === 'string') {
				input.repositoryRoot = value.root;
			}
		} catch {
			// The active repository.
		}
		return input;
	}
}
