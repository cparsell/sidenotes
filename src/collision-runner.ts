/**
 * Thin wrapper around `collision.ts` that knows how to find the margins in a
 * root and which settings to resolve them with.
 *
 * This replaced seven near-copies of the same six lines — three named methods
 * plus four inlined call sites that bypassed them. Two of the inlined copies
 * filtered detached margins and the named methods did not, which is the kind of
 * divergence that only shows up as a rendering glitch under virtualization.
 */

import { resolveCollisionsBySide } from "./collision";
import type { SidenoteSettings } from "./settings";

/**
 * Re-stack the sidenote margins inside `root` so they do not overlap.
 * A missing, detached or empty root is a no-op.
 */
export function updateCollisionsIn(
	settings: SidenoteSettings,
	root: HTMLElement | null | undefined,
) {
	if (!root?.isConnected) return;

	const margins = Array.from(
		root.querySelectorAll<HTMLElement>("small.sidenote-margin"),
	)
		// Detached margins measure as zero-height rects, which would drag the
		// whole stack up. Reading mode virtualizes sections in and out, so this
		// happens routinely there.
		.filter((m) => m.isConnected);

	if (margins.length === 0) return;

	resolveCollisionsBySide(
		margins,
		settings.collisionSpacing,
		settings.sidenotePosition,
	);
}

/**
 * Resolve collisions in both roots.
 *
 * Callers (the visibility observer, the margin resize observer, the inline
 * editors) don't reliably know which mode the margins they care about live in,
 * and running against an empty root is a cheap no-op.
 */
export function updateAllCollisions(
	settings: SidenoteSettings,
	roots: { cmRoot: HTMLElement | null; readingRoot: HTMLElement | null },
) {
	updateCollisionsIn(settings, roots.cmRoot);
	updateCollisionsIn(settings, roots.readingRoot);
}
