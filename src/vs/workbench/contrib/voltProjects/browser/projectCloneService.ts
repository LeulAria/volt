/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IVoltFsBrowseService } from '../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { IVoltGitService } from '../../../../platform/voltGit/common/voltGit.js';
import { resolveCloneDestination, sameRemote } from '../common/cloneUrl.js';
import { IVoltProject, IVoltProjectsService } from '../common/projects.js';
import { IGitHubReposService } from './githubRepos.js';

export interface ICloneProjectRequest {
	readonly url: string;
	/** The folder the user picked; the repo lands in `parent/name`. */
	readonly parent: string;
	readonly name: string;
	readonly ref?: string;
	readonly recursive?: boolean;
	readonly source: 'git' | 'github';
}

export const IProjectCloneService = createDecorator<IProjectCloneService>('voltProjectCloneService');

/**
 * Clones in the background. The project is registered before git starts, so it shows up and
 * can be opened at once; prompts sent meanwhile wait for {@link IVoltProjectsService.whenReady}.
 */
export interface IProjectCloneService {
	readonly _serviceBrand: undefined;
	/** Registers the project and starts cloning. Resolves once the project exists, not when the clone ends. */
	clone(request: ICloneProjectRequest): Promise<IVoltProject>;
	cancel(projectId: string): Promise<void>;
	retry(projectId: string): Promise<void>;
}

interface IJob {
	readonly jobId: string;
	readonly projectId: string;
	readonly request: ICloneProjectRequest;
	readonly dest: string;
	/** Only a folder Volt created is deleted on cancel. */
	readonly createdFolder: boolean;
	cancelled: boolean;
}

export class ProjectCloneService extends Disposable implements IProjectCloneService {

	declare readonly _serviceBrand: undefined;

	private readonly jobs = new Map<string, IJob>();
	private readonly byJobId = new Map<string, IJob>();
	private readonly failed = new Map<string, IJob>();

	constructor(
		@IVoltGitService private readonly gitService: IVoltGitService,
		@IVoltFsBrowseService private readonly fsBrowse: IVoltFsBrowseService,
		@IVoltProjectsService private readonly projects: IVoltProjectsService,
		@IGitHubReposService private readonly github: IGitHubReposService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.gitService.onDidCloneProgress(progress => {
			const job = this.byJobId.get(progress.jobId);
			if (job && !job.cancelled && progress.phase !== 'done') {
				this.projects.setState(job.projectId, { kind: 'cloning', jobId: job.jobId, percent: progress.percent, message: progress.message });
			}
		}));
	}

	async clone(request: ICloneProjectRequest): Promise<IVoltProject> {
		const dest = resolveCloneDestination(request.parent, request.name);
		const target = await this.fsBrowse.inspect(dest);
		if (target.exists) {
			if (target.directory && sameRemote(target.gitRemote, request.url)) {
				// Already cloned here: add it rather than failing.
				return this.projects.add(URI.file(dest), { name: request.name, source: request.source, remoteUrl: request.url });
			}
			if (!target.directory || !target.empty) {
				throw new Error(localize('voltProjects.destinationTaken', "{0} already exists and is not empty.", dest));
			}
		}
		const project = this.projects.add(URI.file(dest), { name: request.name, source: request.source, remoteUrl: request.url });
		this.start({ jobId: generateUuid(), projectId: project.id, request, dest, createdFolder: !target.exists, cancelled: false });
		return this.projects.get(project.id) ?? project;
	}

	async cancel(projectId: string): Promise<void> {
		const job = this.jobs.get(projectId);
		if (!job) {
			return;
		}
		job.cancelled = true;
		await this.gitService.cancelClone(job.jobId);
	}

	async retry(projectId: string): Promise<void> {
		const job = this.failed.get(projectId);
		if (!job || this.jobs.has(projectId)) {
			return;
		}
		this.failed.delete(projectId);
		const target = await this.fsBrowse.inspect(job.dest);
		if (target.exists && !target.empty) {
			// A failed clone can leave files behind; start clean only when Volt made the folder.
			if (!job.createdFolder) {
				throw new Error(localize('voltProjects.destinationTaken', "{0} already exists and is not empty.", job.dest));
			}
			await this.fileService.del(URI.file(job.dest), { recursive: true, useTrash: false });
		}
		this.start({ ...job, jobId: generateUuid(), cancelled: false });
	}

	private start(job: IJob): void {
		this.jobs.set(job.projectId, job);
		this.byJobId.set(job.jobId, job);
		this.projects.setState(job.projectId, { kind: 'cloning', jobId: job.jobId, percent: 0 });
		void this.run(job);
	}

	private async run(job: IJob): Promise<void> {
		try {
			const authHeader = job.request.source === 'github' || /^https:\/\/github\.com\//i.test(job.request.url) ? await this.github.authHeader() : undefined;
			await this.gitService.clone({
				jobId: job.jobId,
				url: job.request.url,
				dest: job.dest,
				ref: job.request.ref,
				recursive: job.request.recursive,
				authHeader,
				authHost: authHeader ? 'https://github.com/' : undefined,
			});
			this.projects.setState(job.projectId, { kind: 'ready' });
		} catch (err) {
			if (job.cancelled) {
				await this.cleanUp(job);
				this.projects.remove(job.projectId);
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			this.logService.warn('[volt-projects] clone failed', message);
			this.failed.set(job.projectId, job);
			this.projects.setState(job.projectId, { kind: 'error', message, jobId: job.jobId });
			this.notificationService.prompt(Severity.Error, localize('voltProjects.cloneFailed', "Could not clone {0}: {1}", job.request.name, message), [
				{ label: localize('voltProjects.retry', "Retry"), run: () => void this.retry(job.projectId).catch((e: Error) => this.notificationService.error(e)) },
				{ label: localize('voltProjects.remove', "Remove"), run: () => void this.cleanUp(job).then(() => this.projects.remove(job.projectId)) },
			]);
		} finally {
			this.jobs.delete(job.projectId);
			this.byJobId.delete(job.jobId);
		}
	}

	private async cleanUp(job: IJob): Promise<void> {
		if (!job.createdFolder) {
			return;
		}
		try {
			await this.fileService.del(URI.file(job.dest), { recursive: true, useTrash: false });
		} catch {
			// git removes its own half-made folder when it is stopped.
		}
	}
}
