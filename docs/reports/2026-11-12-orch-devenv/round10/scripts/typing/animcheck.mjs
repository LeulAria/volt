// Which CSS animations in a saved trace (typeprof.mjs --out) ran on the compositor and which fell back to the main
// thread, with Chromium's reasons (the Animation events' compositeFailed bits and unsupportedProperties). Analysis aid.
//   node animcheck.mjs trace.json
import { readFileSync } from 'fs';

// cc/animation compositor_animations.h failure reasons, in bit order (Chromium 13x).
const REASONS = ['AcceleratedAnimationsDisabled', 'EffectSuppressedByDevtools', 'InvalidAnimationOrEffect', 'EffectHasUnsupportedTimingParameters', 'EffectHasNonReplaceCompositeMode', 'TargetHasInvalidCompositingState', 'TargetHasIncompatibleAnimations', 'TargetHasCSSOffset', 'AnimationAffectsNonCSSProperties', 'TransformRelatedPropertyCannotBeAcceleratedOnTarget', 'TransformRelatedPropertyDependsOnBoxSize', 'FilterRelatedPropertyMayMovePixels', 'UnsupportedCSSProperty', 'MixedKeyframeValueTypes', 'TimelineSourceHasInvalidCompositingState', 'AnimationHasNoVisibleChange', 'AffectsImportantProperty', 'SVGTargetHasIndependentTransformProperty', 'TargetHasInvalidPaintProperty', 'TargetHasInlineTransform'];

const events = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const byName = new Map();
for (const e of events) {
	if (e.name !== 'Animation' || !e.args?.data) { continue; }
	const d = e.args.data;
	const key = `${d.name ?? d.displayName ?? '?'} ${d.nodeName ?? ''}`;
	const s = byName.get(key) ?? { n: 0, failed: new Map(), props: new Set(), states: new Map() };
	s.n++;
	if (d.state) { s.states.set(d.state, (s.states.get(d.state) ?? 0) + 1); }
	if (d.compositeFailed) {
		const reasons = REASONS.filter((_, i) => d.compositeFailed & (1 << i)).join('+') || `bits ${d.compositeFailed}`;
		s.failed.set(reasons, (s.failed.get(reasons) ?? 0) + 1);
	}
	for (const p of d.unsupportedProperties ?? []) { s.props.add(p); }
	byName.set(key, s);
}
for (const [k, s] of [...byName].sort((a, b) => b[1].n - a[1].n)) {
	console.log(`${String(s.n).padStart(6)} ${k} | states ${[...s.states].map(([a, b]) => `${a}:${b}`).join(' ')} | failed ${[...s.failed].map(([a, b]) => `${a}:${b}`).join(' ') || '-'} | unsupported ${[...s.props].join(',') || '-'}`);
}
