/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Picks the builder for a device's family. Families without their own builder yet fall back to a
 * rigid body, so every device still draws.
 */
import type { IDeviceModel } from "../../../../../src/vs/workbench/contrib/voltAgent/browser/preview/deviceStudio/deviceModel.ts";
import type { MaterialKit } from "../materials.ts";
import { buildSlab } from "./slab.ts";
import type { BuiltModel, ModelBuilder } from "./types.ts";

const builders: Partial<Record<IDeviceModel["family"], ModelBuilder>> = {
	slab: buildSlab,
};

/** Registers a family's builder (each family module calls this). */
export function registerBuilder(family: IDeviceModel["family"], builder: ModelBuilder): void {
	builders[family] = builder;
}

export function buildModel(model: IDeviceModel, kit: MaterialKit): BuiltModel {
	return (builders[model.family] ?? buildSlab)(model, kit);
}
