/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installThemeVariables } from './lib/theme';
import './styles/workbench.css';

installThemeVariables();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
