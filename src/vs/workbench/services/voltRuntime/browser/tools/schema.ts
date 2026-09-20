/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function objectSchema(properties: Record<string, object>, required: string[] = []): object {
	return { type: 'object', properties, required, additionalProperties: false };
}
