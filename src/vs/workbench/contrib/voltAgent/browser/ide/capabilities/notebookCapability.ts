/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { DisposableStore, IReference } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ITextModelService } from '../../../../../../editor/common/services/resolverService.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { stripAnsi } from '../../../../../services/voltRuntime/common/ide/testReports.js';
import { NotebookCellTextModel } from '../../../../notebook/common/model/notebookCellTextModel.js';
import { CellEditType, CellKind, IResolvedNotebookEditorModel } from '../../../../notebook/common/notebookCommon.js';
import { INotebookEditorModelResolverService } from '../../../../notebook/common/notebookEditorModelResolverService.js';
import { INotebookExecutionService } from '../../../../notebook/common/notebookExecutionService.js';
import { INotebookExecutionStateService } from '../../../../notebook/common/notebookExecutionStateService.js';
import { INotebookKernelService } from '../../../../notebook/common/notebookKernelService.js';
import { display, fail, IIdeCapability, IIdeCapabilityContext, IIdeCapabilityResult, list, num, ok, resolvePath, str } from './capability.js';

const RUN_WAIT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 4_000;

/**
 * Jupyter notebooks through the notebook services the editor uses: the agent reads and edits the
 * same NotebookTextModel the user's tab shows and runs cells in the notebook's kernel, so its
 * variables live on between calls and the user sees every output appear.
 */
export class NotebookCapability implements IIdeCapability {

	readonly id = 'notebook';

	constructor(
		private readonly resolver: INotebookEditorModelResolverService,
		private readonly kernels: INotebookKernelService,
		private readonly execution: INotebookExecutionService,
		private readonly executionState: INotebookExecutionStateService,
		private readonly textModels: ITextModelService,
		private readonly fileService: IFileService,
		private readonly editorService: IEditorService,
		private readonly contextKeyService: IContextKeyService,
	) { }

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const uri = resolvePath(ctx.root, str(args, 'path'));
		if (!uri || !uri.path.endsWith('.ipynb')) {
			return fail('Pass path to a .ipynb notebook.');
		}
		if (op === 'create') {
			if (await this.fileService.exists(uri)) {
				return fail(`${display(ctx.root, uri)} already exists.`);
			}
			const language = str(args, 'language') ?? 'python';
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(emptyNotebook(language), null, 1)));
			await this.editorService.openEditor({ resource: uri, options: { pinned: true, preserveFocus: true } });
			return ok(`Created ${display(ctx.root, uri)} and opened it. Add cells with op insert.`);
		}
		let ref: IReference<IResolvedNotebookEditorModel>;
		try {
			ref = await this.resolver.resolve(uri);
		} catch (err) {
			return fail(`Could not open the notebook: ${err instanceof Error ? err.message : String(err)}`);
		}
		try {
			const notebook = ref.object.notebook;
			const cells = notebook.cells;
			const cellAt = (index: number | undefined) => index !== undefined && index >= 0 && index < cells.length ? cells[index] : undefined;
			switch (op) {
				case 'cells':
					return ok(cells.length ? cells.map((cell, index) => `[${index}] ${cell.cellKind === CellKind.Code ? cell.language : 'markdown'}${cell.outputs.length ? ` (${cell.outputs.length} output${cell.outputs.length === 1 ? '' : 's'})` : ''}${cell.internalMetadata.lastRunSuccess === false ? ' FAILED' : ''}\n${indent(clip(cell.getValue(), 600))}`).join('\n') : 'The notebook is empty.');
				case 'outputs': {
					const cell = cellAt(num(args, 'cell'));
					return cell ? ok(outputsText(cell) || 'No outputs.') : fail(`No cell ${args.cell}; the notebook has ${cells.length}.`);
				}
				case 'kernel': {
					const match = this.kernels.getMatchingKernel(notebook);
					return ok(match.selected ? `Kernel: ${match.selected.label}${match.selected.description ? ` (${match.selected.description})` : ''}.` : match.all.length ? `No kernel selected; ${match.all.length} available (${match.all.slice(0, 5).map(kernel => kernel.label).join(', ')}). op run picks the suggested one.` : 'No kernel is available. Install the Jupyter extension (or a kernel provider) to run cells; reading and editing work without one.');
				}
				case 'edit': {
					const cell = cellAt(num(args, 'cell'));
					const source = typeof args.source === 'string' ? args.source : undefined;
					if (!cell || source === undefined) {
						return fail('edit needs cell (index) and source.');
					}
					const text = await this.textModels.createModelReference(cell.uri);
					try {
						text.object.textEditorModel.setValue(source);
					} finally {
						text.dispose();
					}
					await ref.object.save();
					return ok(`Updated cell [${num(args, 'cell')}].`);
				}
				case 'insert': {
					const source = typeof args.source === 'string' ? args.source : '';
					const markdown = str(args, 'kind') === 'markdown';
					const at = Math.min(Math.max(num(args, 'at') ?? cells.length, 0), cells.length);
					const language = markdown ? 'markdown' : cells.find(cell => cell.cellKind === CellKind.Code)?.language ?? 'python';
					notebook.applyEdits([{ editType: CellEditType.Replace, index: at, count: 0, cells: [{ source, language, mime: undefined, cellKind: markdown ? CellKind.Markup : CellKind.Code, outputs: [], metadata: {} }] }], true, undefined, () => undefined, undefined, true);
					await ref.object.save();
					return ok(`Inserted a ${markdown ? 'markdown' : 'code'} cell at [${at}].`);
				}
				case 'run': {
					const wanted = list(args, 'cells').map(Number).filter(Number.isInteger);
					const indexes = wanted.length ? wanted : cells.map((_, index) => index);
					const targets = indexes.map(index => cellAt(index)).filter((cell): cell is NotebookCellTextModel => !!cell && cell.cellKind === CellKind.Code);
					if (!targets.length) {
						return fail('No code cells to run.');
					}
					const match = this.kernels.getMatchingKernel(notebook);
					const kernel = match.selected ?? match.suggestions[0] ?? (match.all.length === 1 ? match.all[0] : undefined);
					if (!kernel) {
						return fail(match.all.length ? `Several kernels fit (${match.all.slice(0, 5).map(item => item.label).join(', ')}); ask the user to pick one in the notebook toolbar.` : 'No kernel can run this notebook. Install the Jupyter extension (or open it once so a kernel is chosen).');
					}
					if (!match.selected) {
						this.kernels.selectKernelForNotebook(kernel, notebook);
					}
					await this.editorService.openEditor({ resource: uri, options: { pinned: true, preserveFocus: true } });
					await this.execution.executeNotebookCells(notebook, targets, this.contextKeyService);
					await this.waitForCells(notebook.uri, targets, ctx);
					const report = targets.map(cell => {
						const index = cells.indexOf(cell);
						const status = cell.internalMetadata.lastRunSuccess === false ? 'FAILED' : 'ok';
						const time = cell.internalMetadata.runStartTime && cell.internalMetadata.runEndTime ? ` ${((cell.internalMetadata.runEndTime - cell.internalMetadata.runStartTime) / 1000).toFixed(1)}s` : '';
						return `[${index}] ${status}${time}${cell.outputs.length ? `\n${indent(outputsText(cell))}` : ''}`;
					});
					return ok(`Ran ${targets.length} cell${targets.length === 1 ? '' : 's'} on ${kernel.label}:\n${report.join('\n')}`);
				}
			}
			return fail(`notebook has no op ${op}.`);
		} finally {
			ref.dispose();
		}
	}

	/** Until none of the cells is queued or running (or the wait or the call ends). */
	private waitForCells(notebook: URI, cells: readonly NotebookCellTextModel[], ctx: IIdeCapabilityContext): Promise<void> {
		const busy = () => cells.some(cell => !!this.executionState.getCellExecution(cell.uri));
		if (!busy()) {
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			const store = new DisposableStore();
			const done = () => {
				store.dispose();
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(done, RUN_WAIT_MS);
			store.add(this.executionState.onDidChangeExecution(event => {
				if (event.notebook.toString() === notebook.toString() && !busy()) {
					done();
				}
			}));
			store.add(ctx.token.onCancellationRequested(done));
		});
	}
}

function outputsText(cell: NotebookCellTextModel): string {
	const parts: string[] = [];
	for (const output of cell.outputs) {
		for (const item of output.outputs) {
			if (item.mime === 'application/vnd.code.notebook.error') {
				try {
					const error = JSON.parse(item.data.toString()) as { name?: string; message?: string; stack?: string };
					parts.push(`${error.name ?? 'Error'}: ${error.message ?? ''}${error.stack ? `\n${stripAnsi(error.stack).split('\n').slice(-12).join('\n')}` : ''}`);
				} catch {
					parts.push(item.data.toString());
				}
			} else if (item.mime.startsWith('image/')) {
				parts.push(`(${item.mime} image, ${Math.round(item.data.byteLength / 1024)} KB)`);
			} else if (item.mime === 'text/html' && output.outputs.some(other => other.mime === 'text/plain')) {
				continue;
			} else if (item.mime.startsWith('text/') || item.mime.includes('stdout') || item.mime.includes('stderr') || item.mime.endsWith('json')) {
				parts.push(stripAnsi(item.data.toString()));
			}
		}
	}
	return clip(parts.join('\n').trim(), MAX_OUTPUT_CHARS);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n\u2026 (${text.length - max} more characters)` : text;
}

function indent(text: string): string {
	return text.split('\n').map(line => `    ${line}`).join('\n');
}

function emptyNotebook(language: string): object {
	const python = language === 'python';
	return {
		cells: [],
		metadata: {
			...(python ? { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } } : {}),
			language_info: { name: language },
		},
		nbformat: 4,
		nbformat_minor: 5,
	};
}
