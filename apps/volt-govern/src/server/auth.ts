/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { betterAuth } from 'better-auth';
import { authOptions } from './authOptions.js';

export { VOLT_DESKTOP_CLIENT_ID } from './authOptions.js';

/**
 * The Better Auth instance. Created only after migrations ran (main.ts imports the app lazily):
 * Better Auth validates the schema once at creation and fails sign-ins if that check failed.
 */
export const auth = betterAuth(authOptions);

export type Session = typeof auth.$Infer.Session;
