/**
 * Removing the plugin's markup from a view.
 *
 * The two entry points are deliberately NOT one function with a mode flag.
 * Reading mode wraps footnote references as well as HTML spans, hides the
 * original footnote link, and leaves print-export artifacts behind; editing
 * mode does none of that. Only the per-wrapper cleanup below is genuinely
 * shared, so that is the only part that is shared.
 */

/** A margin carrying the teardown for whatever was mounted inside it. */
export interface SidenoteMarginElement extends HTMLElement {
	_sidenoteCleanup?: () => void;
}

/**
 * Popup-mode margin notes append their popup to `document.body` and register a
 * document-level click listener, so removing the wrapper is not enough — the
 * teardown has to be invoked explicitly.
 */
export interface SidenoteWrapperElement extends HTMLElement {
	_popupCleanup?: () => void;
}

export interface TeardownHooks {
	/** Stop observing a margin for visibility and height changes. */
	unobserveSidenoteVisibility(margin: HTMLElement): void;
}

/**
 * Run and clear a wrapper's popup teardown, if it has one.
 *
 * Guarded: this runs from `onunload`, where a throw would abort the rest of
 * the teardown and leave observers and listeners attached.
 */
export function runPopupCleanup(wrapper: Element) {
	const snWrapper = wrapper as SidenoteWrapperElement;
	if (!snWrapper._popupCleanup) return;
	try {
		snWrapper._popupCleanup();
	} catch (error) {
		console.error("Sidenote plugin: popup cleanup failed", error);
	}
	delete snWrapper._popupCleanup;
}

/**
 * Unwrap one `span.sidenote-number`: run the popup and margin teardowns, drop
 * the margin, and put the original element back where the wrapper was.
 *
 * `findOriginal` is the only part that differs between the two callers.
 */
function unwrapSidenoteWrapper(
	hooks: TeardownHooks,
	wrapper: HTMLElement,
	findOriginal: (wrapper: HTMLElement) => HTMLElement | null,
) {
	runPopupCleanup(wrapper);

	const originalEl = findOriginal(wrapper);

	const margin = wrapper.querySelector<HTMLElement>("small.sidenote-margin");
	if (margin) {
		const snMargin = margin as SidenoteMarginElement;
		if (snMargin._sidenoteCleanup) {
			snMargin._sidenoteCleanup();
			delete snMargin._sidenoteCleanup;
		}
		hooks.unobserveSidenoteVisibility(margin);
		margin.remove();
	}

	if (originalEl && wrapper.parentNode) {
		wrapper.parentNode.insertBefore(originalEl, wrapper);
	}

	wrapper.remove();
}

/**
 * Reading mode: unwraps HTML spans *and* footnote references, restores the
 * footnote link the renderer hid, and clears print-export artifacts.
 */
export function removeReadingModeMarkup(
	hooks: TeardownHooks,
	root: HTMLElement,
) {
	const wrappers = root.querySelectorAll<HTMLElement>("span.sidenote-number");

	for (const wrapper of Array.from(wrappers)) {
		unwrapSidenoteWrapper(hooks, wrapper, (w) => {
			const sidenoteSpan = w.querySelector<HTMLElement>("span.sidenote");
			const footnoteSup = w.querySelector<HTMLElement>(
				"sup.footnote-ref, sup[class*='footnote'], sup[data-footnote-id]",
			);

			// Restore footnote link visibility if needed
			if (footnoteSup) {
				const link = footnoteSup.querySelector<HTMLElement>("a");
				if (link) {
					link.classList.remove("sidenote-fn-link-hidden");
				}
			}

			return sidenoteSpan ?? footnoteSup;
		});
	}

	// Also remove any print-only sidenote elements
	root.querySelectorAll(".sidenote-print").forEach((el) => el.remove());
	// …and un-hide anything print export hid
	root
		.querySelectorAll(".sidenote-print-hidden")
		.forEach((el) => el.classList.remove("sidenote-print-hidden"));
}

/** Editing mode: HTML spans only — footnotes there are CM6 widgets. */
export function removeEditingModeMarkup(
	hooks: TeardownHooks,
	root: HTMLElement,
) {
	const wrappers = root.querySelectorAll<HTMLElement>("span.sidenote-number");

	for (const wrapper of Array.from(wrappers)) {
		unwrapSidenoteWrapper(hooks, wrapper, (w) =>
			w.querySelector<HTMLElement>("span.sidenote"),
		);
	}
}
