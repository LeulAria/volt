/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Policy layering moved (spec M.3 C2): the composition is the Policy Compiler's (`compile.ts`), the
 * coverage tests are the Policy Authority's (`authority.ts`). This re-export keeps existing
 * callers and tests for one release; new code imports from those modules.
 */

export { allowCovers, entryInside } from './authority.js';
export { composeSandboxPolicy } from './compile.js';
export type { ISandboxComposition, ISandboxCompositionNote, ISandboxCompositionOptions, ISandboxLayer, SandboxLayerSource } from './compile.js';
