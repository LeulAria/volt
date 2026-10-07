/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/voltRecordingBadge.css';
import { $, addDisposableListener, append, disposableWindowInterval, getWindow } from '../../../../../base/browser/dom.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { formatRecordingTime, IVoltRecording, IVoltRecordingStatusService } from './recordingStatus.js';

/**
 * A small "● REC 0:12" pill in a preview's corner while a recording runs. Clicking it stops the
 * recording. It sits over the page, so it has an opaque fill (see volt-transparent-window).
 */
export class RecordingBadge extends Disposable {

	private readonly element: HTMLElement;
	private readonly time: HTMLElement;
	private readonly ticker = this._register(new MutableDisposable());

	constructor(
		container: HTMLElement,
		@IVoltRecordingStatusService private readonly status: IVoltRecordingStatusService,
	) {
		super();
		this.element = append(container, $('button.volt-recording-badge.hidden'));
		(this.element as HTMLButtonElement).type = 'button';
		append(this.element, $('span.volt-recording-dot'));
		append(this.element, $('span.volt-recording-label')).textContent = localize('voltRecording.rec', "REC");
		this.time = append(this.element, $('span.volt-recording-time'));
		this._register(addDisposableListener(this.element, 'pointerdown', e => e.stopPropagation()));
		this._register(addDisposableListener(this.element, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			for (const recording of this.status.recordings) {
				void recording.stop();
			}
		}));
		this._register(this.status.onDidChange(() => this.update()));
		this._register({ dispose: () => this.element.remove() });
		this.update();
	}

	private current(): IVoltRecording | undefined {
		return this.status.recordings.reduce<IVoltRecording | undefined>((oldest, recording) => !oldest || recording.startedAt < oldest.startedAt ? recording : oldest, undefined);
	}

	private update(): void {
		const recording = this.current();
		this.element.classList.toggle('hidden', !recording);
		if (!recording) {
			this.ticker.clear();
			return;
		}
		const count = this.status.recordings.length;
		const who = recording.by === 'agent' ? localize('voltRecording.byAgent', "An agent is recording {0}", recording.label) : localize('voltRecording.byUser', "Recording {0}", recording.label);
		setAgentTooltip(this.element, count > 1
			? localize('voltRecording.many', "{0} recordings running. Click to stop them.", count)
			: localize('voltRecording.tooltip', "{0}. Click to stop.", who));
		this.element.setAttribute('aria-label', who);
		const tick = () => { this.time.textContent = formatRecordingTime(Date.now() - recording.startedAt); };
		tick();
		this.ticker.value = disposableWindowInterval(getWindow(this.element), tick, 1000);
	}
}
