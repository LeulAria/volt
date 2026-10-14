/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { migrateAll } from './migrate.js';

// Schema first, then the app (and with it the Better Auth instance, which validates the schema).
await migrateAll();
await import('./app.js');
