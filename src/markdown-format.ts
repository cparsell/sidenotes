/**
 * Markdown formatting for plain-text contenteditable margins.
 *
 * These helpers predate the CM6 inline editors and are still used by the
 * window-level keyboard capture (Mod-B / Mod-I / Mod-K) while a margin is
 * contenteditable. They deliberately operate on `textContent` only — the
 * margin is a *plain-text* editing surface, so markdown is inserted as
 * literal characters rather than rendered.
 *
 * Nothing here touches plugin state.
 */

export interface SelectionOffsets {
	start: number;
	end: number;
}

interface SelectionScan extends SelectionOffsets {
	foundStart: boolean;
	foundEnd: boolean;
}

/**
 * Walk `element`'s text nodes to convert a Range into character offsets
 * within its `textContent`.
 *
 * Returns the offsets alongside whether each end was actually resolved, so
 * callers can choose their own policy for an unresolvable container. The two
 * callers genuinely differ here: `getSelectionOffsets` treats it as a failure,
 * while `applyMarkdownFormatting` falls through with offset 0.
 */
function scanSelectionOffsets(
	element: HTMLElement,
	range: Range,
): SelectionScan {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
	let currentOffset = 0;
	let startOffset = 0;
	let endOffset = 0;
	let foundStart = false;
	let foundEnd = false;
	let node: Text | null;

	while ((node = walker.nextNode() as Text | null)) {
		const nodeLength = node.textContent?.length || 0;

		if (!foundStart && node === range.startContainer) {
			startOffset = currentOffset + range.startOffset;
			foundStart = true;
		}
		if (!foundEnd && node === range.endContainer) {
			endOffset = currentOffset + range.endOffset;
			foundEnd = true;
		}

		if (foundStart && foundEnd) break;
		currentOffset += nodeLength;
	}

	// Handle case where container is the element itself
	if (!foundStart && range.startContainer === element) {
		startOffset = 0;
		for (
			let i = 0;
			i < range.startOffset && i < element.childNodes.length;
			i++
		) {
			startOffset += element.childNodes[i]?.textContent?.length ?? 0;
		}
		foundStart = true;
	}
	if (!foundEnd && range.endContainer === element) {
		endOffset = 0;
		for (let i = 0; i < range.endOffset && i < element.childNodes.length; i++) {
			endOffset += element.childNodes[i]?.textContent?.length ?? 0;
		}
		foundEnd = true;
	}

	return { start: startOffset, end: endOffset, foundStart, foundEnd };
}

/**
 * Get the start and end character offsets of the current selection
 * within a contentEditable element's text content.
 * @param element The contentEditable element
 * @param range The current selection range
 */
export function getSelectionOffsets(
	element: HTMLElement,
	range: Range,
): SelectionOffsets | null {
	const scan = scanSelectionOffsets(element, range);
	if (!scan.foundStart || !scan.foundEnd) return null;
	return { start: scan.start, end: scan.end };
}

/** Restore a selection spanning [start, end) of `element`'s first text node. */
function restoreSelection(
	element: HTMLElement,
	start: number,
	end: number,
	textLength: number,
	onError: (e: unknown) => void,
	fallbackToEnd = false,
) {
	window.requestAnimationFrame(() => {
		element.focus();
		const sel = window.getSelection();
		if (!sel) return;

		const textNode = element.firstChild;
		if (!textNode) return;

		try {
			const newRange = document.createRange();
			newRange.setStart(textNode, Math.min(start, textLength));
			newRange.setEnd(textNode, Math.min(end, textLength));
			sel.removeAllRanges();
			sel.addRange(newRange);
		} catch (e) {
			onError(e);
			if (fallbackToEnd) {
				const fallbackRange = document.createRange();
				fallbackRange.selectNodeContents(element);
				fallbackRange.collapse(false);
				sel.removeAllRanges();
				sel.addRange(fallbackRange);
			}
		}
	});
}

/**
 * Apply markdown formatting to the current selection or cursor position in a contenteditable element.
 * @param element The contenteditable element
 * @param prefix The prefix to add (e.g., "**" for bold, "*" for italic)
 * @param suffix The suffix to add (defaults to prefix)
 * @param linkMode If true, handle as a link with [text](url) format
 */
export function applyMarkdownFormatting(
	element: HTMLElement,
	prefix: string,
	suffix: string = prefix,
	linkMode: boolean = false,
) {
	// Ensure focus is on the element
	element.focus();

	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return;

	const range = selection.getRangeAt(0);

	// Check if selection is within the element
	if (
		!element.contains(range.startContainer) ||
		!element.contains(range.endContainer)
	) {
		// Selection is outside - just insert at end of element
		const textContent = element.textContent || "";
		if (linkMode) {
			element.textContent = textContent + "[link text](url)";
		} else {
			element.textContent = textContent + prefix + suffix;
		}
		// Place cursor appropriately
		const newRange = document.createRange();
		const textNode = element.firstChild || element;
		const pos = textContent.length + prefix.length;
		try {
			newRange.setStart(textNode, pos);
			newRange.setEnd(textNode, pos);
			selection.removeAllRanges();
			selection.addRange(newRange);
		} catch (e) {
			console.error("Error setting cursor position:", e);
			// Ignore
		}
		return;
	}

	const selectedText = range.toString();

	// Get the text content and cursor positions relative to the element's text
	const fullText = element.textContent || "";

	// Deliberately ignores the found flags: an unresolvable container falls
	// through with offset 0, which is what this function has always done.
	const { start: startOffset, end: endOffset } = scanSelectionOffsets(
		element,
		range,
	);

	// Build the new text
	let newText: string;
	let newCursorStart: number;
	let newCursorEnd: number;

	if (linkMode) {
		const linkText = selectedText || "link text";
		const replacement = `[${linkText}](url)`;
		newText =
			fullText.slice(0, startOffset) + replacement + fullText.slice(endOffset);
		// Select "url"
		newCursorStart = startOffset + 1 + linkText.length + 2; // [linkText](
		newCursorEnd = newCursorStart + 3; // url
	} else if (selectedText) {
		// Wrap selection
		const replacement = `${prefix}${selectedText}${suffix}`;
		newText =
			fullText.slice(0, startOffset) + replacement + fullText.slice(endOffset);
		// Select the wrapped text
		newCursorStart = startOffset + prefix.length;
		newCursorEnd = newCursorStart + selectedText.length;
	} else {
		// Insert at cursor
		newText =
			fullText.slice(0, startOffset) +
			prefix +
			suffix +
			fullText.slice(endOffset);
		// Place cursor between prefix and suffix
		newCursorStart = startOffset + prefix.length;
		newCursorEnd = newCursorStart;
	}

	// Update the element
	element.textContent = newText;

	// Restore cursor position
	restoreSelection(
		element,
		newCursorStart,
		newCursorEnd,
		newText.length,
		(e) => console.error("Error setting cursor position:", e),
		true,
	);
}

/**
 * Insert markdown wrapper (like ** for bold, * for italic) around the
 * current selection in a contentEditable element, or at cursor if no selection.
 * Uses manual text manipulation to maintain plain-text editing.
 */
export function insertMarkdownWrapper(element: HTMLElement, wrapper: string) {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return;

	const range = selection.getRangeAt(0);
	if (
		!element.contains(range.startContainer) ||
		!element.contains(range.endContainer)
	)
		return;

	const fullText = element.textContent || "";

	// Calculate offsets within the full text
	const offsets = getSelectionOffsets(element, range);
	if (!offsets) return;

	const { start, end } = offsets;
	const selectedText = fullText.slice(start, end);

	let newText: string;
	let cursorStart: number;
	let cursorEnd: number;

	if (selectedText) {
		// Wrap selection
		newText =
			fullText.slice(0, start) +
			wrapper +
			selectedText +
			wrapper +
			fullText.slice(end);
		cursorStart = start + wrapper.length;
		cursorEnd = cursorStart + selectedText.length;
	} else {
		// Insert wrapper pair at cursor
		newText =
			fullText.slice(0, start) + wrapper + wrapper + fullText.slice(end);
		cursorStart = start + wrapper.length;
		cursorEnd = cursorStart;
	}

	element.textContent = newText;

	// Restore cursor
	restoreSelection(element, cursorStart, cursorEnd, newText.length, (e) =>
		console.error("Sidenotes - Error setting cursor position:", e),
	);
}

/**
 * Insert a markdown link at the current cursor/selection in a contentEditable element.
 */
export function insertMarkdownLink(element: HTMLElement) {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return;

	const range = selection.getRangeAt(0);
	if (
		!element.contains(range.startContainer) ||
		!element.contains(range.endContainer)
	)
		return;

	const fullText = element.textContent || "";
	const offsets = getSelectionOffsets(element, range);
	if (!offsets) return;

	const { start, end } = offsets;
	const selectedText = fullText.slice(start, end);

	const linkText = selectedText || "link text";
	const replacement = `[${linkText}](url)`;

	const newText = fullText.slice(0, start) + replacement + fullText.slice(end);

	// Position cursor to select "url"
	const urlStart = start + 1 + linkText.length + 2; // [linkText](
	const urlEnd = urlStart + 3; // url

	element.textContent = newText;

	restoreSelection(element, urlStart, urlEnd, newText.length, (e) =>
		console.error("Sidenotes - Error setting cursor position:", e),
	);
}
