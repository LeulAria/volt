/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/voltButton.css';
import { Button, IButtonOptions, IButtonStyles } from '../../../../../base/browser/ui/button/button.js';

/**
 * Volt's one button: Settings, Projects, setup and the dialogs all use it, so every action reads
 * alike. `primary` is the one thing a surface wants you to do (a near-white fill in dark themes),
 * `secondary` everything else, `ghost` quiet actions beside others, `danger` removes something.
 */
export type VoltButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger';

/** No inline colours: voltButton.css paints every state from the theme's foreground. */
const VOLT_BUTTON_STYLES: IButtonStyles = {
	buttonBackground: undefined,
	buttonHoverBackground: undefined,
	buttonForeground: undefined,
	buttonSeparator: undefined,
	buttonSecondaryBackground: undefined,
	buttonSecondaryHoverBackground: undefined,
	buttonSecondaryForeground: undefined,
	buttonBorder: undefined,
};

/** Classes for a plain `<button>` drawn as a Volt button. */
export function voltButtonClasses(kind: VoltButtonKind = 'secondary'): string[] {
	return ['volt-button', `volt-button-${kind}`];
}

/** A {@link Button} drawn as a Volt button. */
export function createVoltButton(parent: HTMLElement, kind: VoltButtonKind = 'secondary', options?: Omit<IButtonOptions, keyof IButtonStyles>): Button {
	const button = new Button(parent, { ...options, ...VOLT_BUTTON_STYLES, secondary: kind !== 'primary' });
	button.element.classList.add(...voltButtonClasses(kind));
	return button;
}
