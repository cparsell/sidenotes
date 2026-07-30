import { setCssProps } from "./dom-utils";

/**
 * Core collision avoidance algorithm.
 *
 * Each margin is absolutely positioned to align with its anchor (the inline reference).
 * With --sidenote-shift: 0px, the margin's top aligns with its anchor's top.
 * We apply positive shifts to push margins down when they would overlap.
 *
 * @param margins - Array of margin elements to check for collisions
 * @param spacing - Minimum pixels between stacked sidenotes
 */
export function resolveCollisions(margins: HTMLElement[], spacing: number) {
	if (!margins || margins.length === 0) return;

	// Filter to only connected, visible margins
	const validMargins: HTMLElement[] = [];
	for (const m of margins) {
		if (!m.isConnected) continue;
		if (m.offsetHeight > 0) {
			validMargins.push(m);
			continue;
		}
		// Zero-height margins can't take part in the stacking chain, but a
		// leftover shift from a previous pass would be applied verbatim once
		// they render, so clear it. They rejoin via marginResizeObserver.
		setCssProps(m, { "--sidenote-shift": "0px" });
	}

	if (validMargins.length === 0) return;

	// Step 1: Reset all shifts to measure natural/anchor positions
	for (const margin of validMargins) {
		setCssProps(margin, { "--sidenote-shift": "0px" });
	}

	// Step 2: Force synchronous reflow to get accurate measurements
	void document.body.offsetHeight;

	// Step 3: Measure each margin at its natural position (shift=0)
	const items: {
		el: HTMLElement;
		anchorY: number; // Top position when shift=0 (aligned with anchor)
		height: number;
		shift: number; // Shift to apply (will be calculated)
	}[] = [];

	for (const margin of validMargins) {
		const rect = margin.getBoundingClientRect();
		if (rect.height <= 0) continue;

		items.push({
			el: margin,
			anchorY: rect.top,
			height: rect.height,
			shift: 0,
		});
	}

	if (items.length === 0) return;

	// Step 4: Sort by DOM order, not measured position.
	// Using rect.top can produce wrong order during layout transitions
	// (e.g. after editing a sidenote that changes height). DOM order
	// always reflects source order because decorations are sorted by
	// document position.
	items.sort((a, b) => {
		const pos = a.el.compareDocumentPosition(b.el);
		if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
		if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
		return 0;
	});

	// Step 5: Greedily assign positions to avoid collisions
	// Track where the next available vertical position is
	let nextFreeY = -Infinity;

	for (const item of items) {
		// This margin wants to be at anchorY
		// But it cannot start above nextFreeY
		const targetY = Math.max(item.anchorY, nextFreeY);

		// The shift is how far from anchorY we need to move
		item.shift = targetY - item.anchorY;

		// Update nextFreeY to be after this margin
		nextFreeY = targetY + item.height + spacing;
	}

	// Step 6: Apply the calculated shifts
	for (const item of items) {
		if (item.shift > 0.5) {
			item.el.style.setProperty("--sidenote-shift", `${item.shift}px`);
		} else {
			item.el.style.setProperty("--sidenote-shift", `${0}px`);
		}
	}
}
