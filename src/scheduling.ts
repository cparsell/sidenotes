/**
 * Owns every animation-frame handle, timer and observer the plugin schedules.
 *
 * The point of collecting them here is `cancelAll()`. These handles used to be
 * ten separate fields on the plugin, and the teardown cleared some of them —
 * `layoutTrailingTimer` and `readingModeResizeTrailingTimer` were both missed,
 * so a trailing layout pass could fire against a torn-down view after unload.
 * With one owner that class of bug is structurally hard to reintroduce.
 *
 * Timing constants are deliberately unchanged from the values they were tuned
 * to; do not "improve" them here.
 */

/** What the scheduler runs when a scheduled pass comes due. */
export interface SchedulerTargets {
	layout(): void;
	readingModeLayout(): void;
	collisions(): void;
}

export const TIMING = {
	RESIZE_DEBOUNCE: 100,
	SCROLL_DEBOUNCE: 50,
	MUTATION_DEBOUNCE: 100,
	FOOTNOTE_RENDER_DELAY: 100,
	WIDGET_LAYOUT_DELAY: 50,
	INSERT_SIDENOTE_DELAY: 150,
	/** Trailing pass after a leading layout, to catch a late reflow. */
	LAYOUT_TRAILING: 200,
} as const;

export class LayoutScheduler {
	private rafId: number | null = null;
	/**
	 * Kept separate from `rafId`: gating collisions on the layout handle meant
	 * a pending layout silently dropped the collision request instead of
	 * deferring it, leaving sidenotes stacked on top of each other.
	 */
	private collisionRafId: number | null = null;

	private mutationDebounceTimer: number | null = null;
	private layoutTrailingTimer: number | null = null;
	private scrollDebounceTimer: number | null = null;
	private readingScrollTimer: number | null = null;
	private footnoteProcessingTimer: number | null = null;
	private readingResizeTrailingTimer: number | null = null;

	private resizeThrottleTime = 0;
	private readingResizeThrottleTime = 0;

	private visibilityObserver: IntersectionObserver | null = null;
	private marginResizeObserver: ResizeObserver | null = null;
	private visibleSidenotes = new Set<HTMLElement>();

	constructor(private targets: SchedulerTargets) {
		this.visibilityObserver = new IntersectionObserver(
			(entries) => {
				let needsCollisionUpdate = false;
				for (const entry of entries) {
					const el = entry.target as HTMLElement;

					// Check if element is still in the DOM
					if (!el.isConnected) {
						this.visibleSidenotes.delete(el);
						continue;
					}

					if (entry.isIntersecting) {
						if (!this.visibleSidenotes.has(el)) {
							this.visibleSidenotes.add(el);
							needsCollisionUpdate = true;
						}
					} else {
						if (this.visibleSidenotes.has(el)) {
							this.visibleSidenotes.delete(el);
							needsCollisionUpdate = true;
						}
					}
				}
				if (needsCollisionUpdate) {
					this.scheduleCollisions();
				}
			},
			{ rootMargin: "100px 0px", threshold: 0 },
		);

		// Collision avoidance is a one-shot measurement: once a pass has run, a
		// margin that *later* changes height (image or embed finishing loading,
		// a webfont swapping in, the inline editor opening/closing, a section
		// re-flowing after virtualisation) silently invalidates every shift
		// below it and nothing re-measures. That is what leaves sidenotes
		// stacked on top of each other until an unrelated event happens to
		// trigger a layout.
		//
		// resolveCollisions only writes `transform`, which cannot change a
		// margin's own box size, so this cannot feed back into itself.
		this.marginResizeObserver = new ResizeObserver(() => {
			this.scheduleCollisions();
		});
	}

	// ---- observers -------------------------------------------------------

	observeMargin(margin: HTMLElement) {
		this.visibilityObserver?.observe(margin);
		this.marginResizeObserver?.observe(margin);
	}

	unobserveMargin(margin: HTMLElement) {
		if (this.visibilityObserver) {
			this.visibilityObserver.unobserve(margin);
			this.visibleSidenotes.delete(margin);
		}
		this.marginResizeObserver?.unobserve(margin);
	}

	/** Drop tracked visibility state — call when rebinding to a new view. */
	clearVisible() {
		this.visibleSidenotes.clear();
	}

	// ---- editing-mode layout ---------------------------------------------

	cancelLayout() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	scheduleLayout() {
		this.cancelLayout();
		this.rafId = window.requestAnimationFrame(() => {
			this.rafId = null;
			this.targets.layout();
		});
	}

	/** Leading rAF pass plus a trailing one, to catch a late reflow. */
	scheduleLayoutStable() {
		this.scheduleLayout();

		if (this.layoutTrailingTimer !== null) {
			window.clearTimeout(this.layoutTrailingTimer);
		}
		this.layoutTrailingTimer = window.setTimeout(() => {
			this.layoutTrailingTimer = null;
			this.targets.layout();
		}, TIMING.LAYOUT_TRAILING);
	}

	scheduleLayoutDebounced(delay: number = TIMING.MUTATION_DEBOUNCE) {
		if (this.mutationDebounceTimer !== null) {
			window.clearTimeout(this.mutationDebounceTimer);
		}
		this.mutationDebounceTimer = window.setTimeout(() => {
			this.mutationDebounceTimer = null;
			this.scheduleLayout();
		}, delay);
	}

	scheduleLayoutThrottled(minInterval: number = TIMING.RESIZE_DEBOUNCE) {
		const now = Date.now();
		if (now - this.resizeThrottleTime >= minInterval) {
			this.resizeThrottleTime = now;
			this.scheduleLayout();
		}
	}

	// ---- reading-mode layout ---------------------------------------------

	/** Leading + trailing throttle, so the final resize state is always applied. */
	scheduleReadingLayoutThrottled(
		minInterval: number = TIMING.RESIZE_DEBOUNCE,
	) {
		const now = Date.now();

		if (this.readingResizeTrailingTimer !== null) {
			window.clearTimeout(this.readingResizeTrailingTimer);
		}

		if (now - this.readingResizeThrottleTime >= minInterval) {
			this.readingResizeThrottleTime = now;
			this.targets.readingModeLayout();
		}

		this.readingResizeTrailingTimer = window.setTimeout(() => {
			this.readingResizeTrailingTimer = null;
			this.readingResizeThrottleTime = Date.now();
			this.targets.readingModeLayout();
		}, minInterval);
	}

	/**
	 * Debounced editing-mode scroll handling.
	 *
	 * Deliberately a separate handle from `scheduleReadingScroll`: the CM
	 * scroller and the reading root can both be scrolling, and sharing one
	 * timer would let each cancel the other's pending pass.
	 */
	scheduleEditorScroll(run: () => void, delay: number = TIMING.SCROLL_DEBOUNCE) {
		if (this.scrollDebounceTimer !== null) {
			window.clearTimeout(this.scrollDebounceTimer);
		}
		this.scrollDebounceTimer = window.setTimeout(() => {
			this.scrollDebounceTimer = null;
			run();
		}, delay);
	}

	/** Debounced reading-mode scroll handling. */
	scheduleReadingScroll(run: () => void, delay: number = TIMING.SCROLL_DEBOUNCE) {
		if (this.readingScrollTimer !== null) {
			window.clearTimeout(this.readingScrollTimer);
		}
		this.readingScrollTimer = window.setTimeout(() => {
			this.readingScrollTimer = null;
			run();
		}, delay);
	}

	/** Debounced reading-mode sidenote processing. */
	scheduleFootnoteProcessing(
		run: () => void,
		delay: number = TIMING.FOOTNOTE_RENDER_DELAY,
	) {
		if (this.footnoteProcessingTimer !== null) {
			window.clearTimeout(this.footnoteProcessingTimer);
		}
		this.footnoteProcessingTimer = window.setTimeout(() => {
			this.footnoteProcessingTimer = null;
			run();
		}, delay);
	}

	// ---- collisions ------------------------------------------------------

	scheduleCollisions() {
		if (this.collisionRafId !== null) return;

		this.collisionRafId = window.requestAnimationFrame(() => {
			this.collisionRafId = null;
			this.targets.collisions();
		});
	}

	// ---- teardown --------------------------------------------------------

	/** Cancel every pending frame and timer. Safe to call more than once. */
	cancelAll() {
		for (const raf of [this.rafId, this.collisionRafId]) {
			if (raf !== null) cancelAnimationFrame(raf);
		}
		this.rafId = null;
		this.collisionRafId = null;

		for (const timer of [
			this.mutationDebounceTimer,
			this.layoutTrailingTimer,
			this.scrollDebounceTimer,
			this.readingScrollTimer,
			this.footnoteProcessingTimer,
			this.readingResizeTrailingTimer,
		]) {
			if (timer !== null) window.clearTimeout(timer);
		}
		this.mutationDebounceTimer = null;
		this.layoutTrailingTimer = null;
		this.scrollDebounceTimer = null;
		this.readingScrollTimer = null;
		this.footnoteProcessingTimer = null;
		this.readingResizeTrailingTimer = null;
	}

	/** Full teardown: cancel everything and disconnect the observers. */
	dispose() {
		this.cancelAll();

		this.visibilityObserver?.disconnect();
		this.visibilityObserver = null;
		this.marginResizeObserver?.disconnect();
		this.marginResizeObserver = null;
		this.visibleSidenotes.clear();
	}
}
