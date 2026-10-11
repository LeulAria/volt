/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Laptops (MacBook Pro, MacBook Air): the base with keyboard, trackpad, speakers and ports, and the lid on its hinge with the notched display.
 */
import { registerBuilder } from "./index.ts";
import { buildSlab } from "./slab.ts";
import type { ModelBuilder } from "./types.ts";

// Placeholder until this family has its own model: a rigid body with the main display.
export const buildLaptop: ModelBuilder = (model, kit) => buildSlab(model, kit);

registerBuilder("laptop", buildLaptop);
