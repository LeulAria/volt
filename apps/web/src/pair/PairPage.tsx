/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorMessage, formatCode, type ISavedEnvironment, normalizeCode } from '@volt/client-core';
import { useEffect, useRef, useState } from 'react';
import { pairWithCode } from '../app/session';
import { Button, Icon } from '../ui/primitives';

/** Signs this browser in with a one-time code from Volt on the computer. */
export function PairPage({ code: initialCode, error: initialError, onPaired }: { readonly code?: string; readonly error?: string; readonly onPaired: (environment: ISavedEnvironment) => void }) {
	const [code, setCode] = useState(initialCode ? formatCode(initialCode) : '');
	const [error, setError] = useState(initialError);
	const [busy, setBusy] = useState(false);
	const tried = useRef(false);

	const submit = async (value = code) => {
		if (normalizeCode(value).length < 8) {
			setError('The code has 8 characters, like ABCD-2345.');
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			const environment = await pairWithCode(value);
			window.history.replaceState(null, '', '/');
			onPaired(environment);
		} catch (err) {
			setError(errorMessage(err));
			setBusy(false);
		}
	};

	useEffect(() => {
		if (initialCode && !tried.current) {
			tried.current = true;
			void submit(initialCode);
		}
		// Only once, for a code that came in the link.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialCode]);

	return (
		<div className="pair-page">
			<div className="pair-card">
				<div className="pair-mark"><Icon name="bolt" size={26} /></div>
				<h1>Connect to Volt</h1>
				<p className="pair-lede">Follow and steer the agents running on your computer. In Volt, open <b>Settings {'›'} Devices</b> or run <b>Volt: Pair a Phone or Browser…</b>, then enter the code it shows.</p>
				<form className="pair-form" onSubmit={e => {
					e.preventDefault();
					void submit();
				}}>
					<input
						className="pair-input"
						value={code}
						autoFocus
						autoComplete="one-time-code"
						autoCapitalize="characters"
						spellCheck={false}
						placeholder="ABCD-2345"
						maxLength={9}
						onChange={e => {
							setError(undefined);
							setCode(formatCode(e.target.value).slice(0, 9));
						}}
					/>
					<Button type="submit" variant="primary" size="lg" busy={busy} disabled={normalizeCode(code).length < 8}>Connect</Button>
				</form>
				{error ? <div className="pair-error"><Icon name="alertCircle" size={14} />{error}</div> : null}
				<div className="pair-steps">
					<div><span>1</span>Volt keeps running on your computer, with or without this page.</div>
					<div><span>2</span>This browser gets its own key; remove it from Devices at any time.</div>
					<div><span>3</span>On your phone, scan the same code with the Volt app.</div>
				</div>
			</div>
		</div>
	);
}
