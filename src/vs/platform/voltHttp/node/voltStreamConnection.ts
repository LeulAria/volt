/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltHttpStreamEvent, IVoltHttpStreamMessage } from '../common/voltHttpStreams.js';

/**
 * How a protocol module reports what happens on its connection. The service adds the connection's
 * id and the time. A module ends with exactly one `close`, and every `error` is followed by it.
 */
export type VoltStreamEmit = (event: Omit<IVoltHttpStreamEvent, 'id' | 'at'>) => void;

/** What every protocol module returns for one connection. */
export interface IVoltStreamConnection {
	/** Sends one message. Throws when the connection is not open or the kind cannot send. */
	send(message: IVoltHttpStreamMessage): void;
	/** Closes; a `close` event follows. Closing twice is harmless. */
	close(): void;
}
