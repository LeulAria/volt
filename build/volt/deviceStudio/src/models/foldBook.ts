/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Book-style foldables (Galaxy Z Fold, Pixel Pro Fold, iPhone Duo, Surface Duo): two halves on a vertical hinge, the inner display across both, the cover display on the right half's outer face.
 */
import { registerBuilder } from "./index.ts";
import { buildSlab } from "./slab.ts";
import type { ModelBuilder } from "./types.ts";

// Placeholder until this family has its own model: a rigid body with the main display.
export const buildFoldBook: ModelBuilder = (model, kit) => buildSlab(model, kit);

registerBuilder("foldBook", buildFoldBook);
