"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDevTranspileEngine = resolveDevTranspileEngine;
exports.isFastTranspileEngine = isFastTranspileEngine;
function resolveDevTranspileEngine(explicit) {
    const raw = (explicit || process.env['VOLT_WATCH_ENGINE'] || '').trim().toLowerCase();
    if (process.env['VOLT_WATCH_TSC'] === '1' || raw === 'tsc') {
        return 'tsc';
    }
    if (raw === 'esbuild') {
        return 'esbuild';
    }
    if (raw === 'rolldown') {
        return 'rolldown';
    }
    return 'oxc';
}
function isFastTranspileEngine(engine) {
    return engine !== 'tsc';
}
//# sourceMappingURL=devEngine.js.map