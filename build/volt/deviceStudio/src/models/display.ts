/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Displays on a stand (Nest Hub): the screen panel and its speaker base or foot.
 */
import { registerBuilder } from "./index.ts";
import { buildSlab } from "./slab.ts";
import type { ModelBuilder } from "./types.ts";

// Placeholder until this family has its own model: a rigid body with the main display.
export const buildDisplay: ModelBuilder = (model, kit) => buildSlab(model, kit);

registerBuilder("display", buildDisplay);
