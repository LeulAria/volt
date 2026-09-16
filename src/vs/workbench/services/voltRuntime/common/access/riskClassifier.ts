/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PermissionAction, RiskLevel } from './accessTypes.js';

const RISK_RANK: Record<RiskLevel, number> = {
	safe: 0,
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
};

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
	return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

const SAFE_COMMANDS = /^(ls|pwd|cd|echo|cat|head|tail|less|more|file|which|whoami|date|uname|dirname|basename|wc|sort|uniq|true|false|type|command|sleep|lsof|netstat|ss)\b/;
const SAFE_GIT = /^git\s+(status|diff|log|show|branch|rev-parse|describe|remote|stash\s+list|blame|shortlog)\b/;
const SAFE_SEARCH = /^(grep|rg|find|fd|ag|ack|git\s+grep)\b/;
const LOW_TEST = /^(npm|pnpm|yarn|bun|npx)\s+(test|run\s+test|run\s+lint|run\s+typecheck|run\s+check)\b|^(tsc|eslint|prettier|vitest|jest|mocha|pytest|cargo\s+test|go\s+test|make\s+test)\b/;
const LOW_DEV = /^(npm|pnpm|yarn|bun|npx)\s+(run\s+)?(dev|start|preview|serve)\b|^(npx\s+)?(vite|next(\s+dev)?|nuxt|astro|http-server|serve)\b|^python3?\s+(-m\s+)?http\.server\b|^php\s+-S\b/;
const LOCAL_HOST = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])\b|^(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i;
const LOW_LOCAL_NET = /^(curl|wget|http|open|xdg-open|start)\b/;
const MEDIUM_INSTALL = /^(npm|pnpm|yarn|bun|npx)\s+(i|install|add|remove|uninstall)\b|^(pip|pip3|poetry|uv|cargo|go)\s+(install|add|get)\b/;
const MEDIUM_NET = /^(curl|wget|http|nc|ncat|ssh|scp|rsync|ftp)\b/;
const HIGH_PUSH = /^git\s+push\b/;
const HIGH_DELETE = /^(rm|rmdir|unlink|shred)\b|^git\s+(clean|reset\s+--hard|checkout\s+\.|restore\s+--)\b/;
const HIGH_DB = /^(psql|mysql|mongo|redis-cli|sqlite3)\b/;
const CRITICAL_FORCE = /--force\b|\s-f(\s|$)|git\s+push\s+.*--force|git\s+push\s+-f\b/;
const CRITICAL_DESTROY = /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b|mkfs\b|dd\s+if=|:(){:|:&};:|diskutil\s+erase/;
const CRITICAL_CREDS = /(\.env($|\.)|id_rsa|id_ed25519|\.pem\b|\.p12\b|credentials|\.ssh\/|authorized_keys|known_hosts)/i;
const CRITICAL_DEPLOY = /\b(terraform\s+apply|kubectl\s+delete|helm\s+uninstall|fly\s+deploy|vercel\s+--prod)\b/;
const SUBSTITUTION = /\$\(|`/;

function maskQuoted(command: string): string {
	return command
		.replace(/'[^']*'/g, '\'\'')
		.replace(/"[^"]*"/g, '""')
		.replace(/<<['"]?\w+['"]?[\s\S]*?\n\w+\n/g, '');
}

export function splitShellSegments(command: string): string[] {
	const masked = maskQuoted(command);
	return masked
		.split(/[\n;|&()]+/)
		.map(segment => segment.trim())
		.filter(Boolean);
}

function classifyCommand(command: string): RiskLevel {
	const trimmed = command.trim();
	if (!trimmed) {
		return 'safe';
	}
	if (CRITICAL_DESTROY.test(trimmed) || CRITICAL_FORCE.test(trimmed) || CRITICAL_CREDS.test(trimmed) || CRITICAL_DEPLOY.test(trimmed)) {
		return 'critical';
	}
	if (HIGH_DELETE.test(trimmed) || HIGH_PUSH.test(trimmed) || HIGH_DB.test(trimmed)) {
		return 'high';
	}
	if (MEDIUM_INSTALL.test(trimmed)) {
		return 'medium';
	}
	if (LOW_LOCAL_NET.test(trimmed) && LOCAL_HOST.test(trimmed)) {
		return 'low';
	}
	if (MEDIUM_NET.test(trimmed)) {
		return 'medium';
	}
	if (LOW_DEV.test(trimmed) || LOW_TEST.test(trimmed)) {
		return 'low';
	}
	if (SAFE_GIT.test(trimmed) || SAFE_SEARCH.test(trimmed) || SAFE_COMMANDS.test(trimmed)) {
		return 'safe';
	}
	return 'medium';
}

function classifyPath(path: string): RiskLevel {
	return CRITICAL_CREDS.test(path) ? 'critical' : 'safe';
}

export function classifyRisk(action: PermissionAction, resource: string): RiskLevel {
	if (action === 'question' || action === 'search') {
		return 'safe';
	}
	if (action === 'read') {
		return classifyPath(resource);
	}
	if (action === 'edit') {
		return classifyPath(resource) === 'critical' ? 'critical' : 'low';
	}
	if (action === 'shell' || action === 'git') {
		const segments = splitShellSegments(resource);
		let risk: RiskLevel = 'safe';
		if (SUBSTITUTION.test(resource)) {
			risk = 'high';
		}
		for (const segment of segments) {
			risk = maxRisk(risk, classifyCommand(segment));
		}
		return risk;
	}
	if (action === 'mcp') {
		if (/\b(delete|destroy|drop|deploy|send_email|force)\b/i.test(resource)) {
			return 'high';
		}
		return 'medium';
	}
	if (action === 'network' || action === 'web' || action === 'browser') {
		return LOCAL_HOST.test(resource) ? 'low' : 'medium';
	}
	if (action === 'subagent') {
		return 'medium';
	}
	return 'medium';
}

export function autoAllowsRisk(risk: RiskLevel): boolean {
	return risk === 'safe' || risk === 'low';
}
