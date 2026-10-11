/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Clamshell foldables (Galaxy Z Flip): two halves on a horizontal hinge, a tall inner display, the cover display and cameras on the top half's outer face.
 */
import { registerBuilder } from "./index.ts";
import { buildSlab } from "./slab.ts";
import type { ModelBuilder } from "./types.ts";

// Placeholder until this family has its own model: a rigid body with the main display.
export const buildFlip: ModelBuilder = (model, kit) => buildSlab(model, kit);

registerBuilder("flip", buildFlip);
