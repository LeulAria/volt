/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Volt's device studio bundle: photoreal 3D device frames for the browser's responsive design
 * mode. Built by build/volt/deviceStudio (npm run build) into the workbench's vendor folder.
 */
import "./models/families.ts";

export { createDeviceStudio, DeviceStudio } from "./studio.ts";
export type { DeviceStudioHost, DeviceStudioState, ShowOptions, StudioArea, StudioView } from "./studio.ts";
export type { Snapshot } from "./screen.ts";
