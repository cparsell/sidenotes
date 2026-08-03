import type { Editor } from "obsidian";

/** Structural view of Obsidian's Editor exposing the CM6 scroller. */
type HasCmScrollTop = {
	cm?: {
		scrollDOM?: {
			scrollTop?: number;
		};
	};
};

export interface ResequenceContext {
	/** The editing-mode CodeMirror root, used to restore scroll position. */
	getCmRoot(): HTMLElement | null;
	/**
	 * Raise/lower the guard that stops the plugin's own `.cm-content`
	 * MutationObserver from reacting to the rewrite below.
	 */
	setMutating(value: boolean): void;
}

function getScrollTopFromEditor(editor: Editor): number {
	const maybe = editor as unknown as HasCmScrollTop;
	const v = maybe.cm?.scrollDOM?.scrollTop;
	return typeof v === "number" ? v : 0;
}

/**
 * Replace the whole document, suppressing the plugin's mutation observer and
 * restoring the scroll position afterwards.
 *
 * `editor.setValue` resets the scroll to the top, which on a long note throws
 * the reader to the start. Written out three times before this was extracted.
 */
function applyRewrite(ctx: ResequenceContext, editor: Editor, content: string) {
	const scrollTop = getScrollTopFromEditor(editor);

	ctx.setMutating(true);
	try {
		editor.setValue(content);
	} finally {
		ctx.setMutating(false);
	}

	const scroller = ctx.getCmRoot()?.querySelector<HTMLElement>(".cm-scroller");
	if (scroller) scroller.scrollTop = scrollTop;
}

/**
 * Re-sequence all footnotes so references and definitions
 * are numbered sequentially in the order they appear in the text.
 * Margin notes ([^mn-...]) are re-sequenced separately.
 */
export function resequenceFootnotes(
	ctx: ResequenceContext,
	editor: Editor,
) {
	let content = editor.getValue();

	// --- A) Collect definitions FIRST so we can prune missing mn-* refs ---
	const defHeaderRegex = /^\[\^([^\]]+)\]:/gm;
	const definedIds = new Set<string>();
	let dm: RegExpExecArray | null;
	while ((dm = defHeaderRegex.exec(content)) !== null) {
		const id = dm[1];
		if (id) definedIds.add(id);
	}

	// --- 1) Collect all references in order of appearance (not definitions) ---
	const refRegex = /\[\^([^\]]+)\](?!:)/g;
	const seenIds: string[] = [];
	let m: RegExpExecArray | null;

	while ((m = refRegex.exec(content)) !== null) {
		const id = m[1];
		if (id && !seenIds.includes(id)) {
			seenIds.push(id);
		}
	}

	if (seenIds.length === 0) return;

	// --- B) Delete orphaned margin-note references (mn-*) that have no definition ---
	// Example: [^mn-3] exists but no "[^mn-3]:" definition block -> remove the reference token.
	// Do this BEFORE resequencing so counters aren’t affected by orphans.
	const orphanMarginIds = seenIds.filter(
		(id) => id.startsWith("mn-") && !definedIds.has(id),
	);

	if (orphanMarginIds.length > 0) {
		for (const oldId of orphanMarginIds) {
			const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

			// Remove occurrences of the reference token.
			// We also clean up a possible preceding space to avoid double spaces.
			// If you want to be more conservative, remove only the token itself.
			const orphanRefPattern = new RegExp(
				`\\s*\\[\\^${escaped}\\]`,
				"g",
			);
			content = content.replace(orphanRefPattern, "");

			// Remove from seenIds so it will not be resequenced.
			const idx = seenIds.indexOf(oldId);
			if (idx >= 0) seenIds.splice(idx, 1);
		}
	}

	if (seenIds.length === 0) {
		// After removing orphan mn-* refs, there may be nothing left to resequence.
		// Still apply the deletion to the editor if we changed content.
		if (orphanMarginIds.length > 0) {
			applyRewrite(ctx, editor, content);
		}
		return;
	}

	// --- 2) Build renumber map: old ID → new ID ---
	const renumberMap = new Map<string, string>();
	let regularCounter = 1;
	let marginCounter = 1;

	for (const oldId of seenIds) {
		// Preserve a trailing -r/-l margin override through renumbering,
		// e.g. "mn-3-r" -> "mn-1-r", "5-l" -> "2-l".
		const sideSuffixMatch = oldId.match(/-[rl]$/i);
		const sideSuffix = sideSuffixMatch ? sideSuffixMatch[0] : "";

		if (oldId.startsWith("mn-")) {
			renumberMap.set(oldId, `mn-${marginCounter}${sideSuffix}`);
			marginCounter++;
		} else {
			renumberMap.set(oldId, `${regularCounter}${sideSuffix}`);
			regularCounter++;
		}
	}

	// --- 3) Check if anything actually needs renumbering ---
	let needsRenumber = false;
	for (const [oldId, newId] of renumberMap) {
		if (oldId !== newId) {
			needsRenumber = true;
			break;
		}
	}

	// Even if no renumber is needed, we might have deleted orphan refs above.
	// Continue only if renumber needed; otherwise just apply orphan deletions.
	if (!needsRenumber) {
		if (orphanMarginIds.length > 0) {
			applyRewrite(ctx, editor, content);
		}
		return;
	}

	// --- 4) Replace all references and definitions using placeholder tokens ---
	const placeholders = new Map<string, string>();
	for (const oldId of seenIds) {
		const placeholder = `__FN_PLACEHOLDER_${crypto.randomUUID().slice(0, 8)}__`;
		placeholders.set(oldId, placeholder);
	}

	// Replace references: [^oldId] → [^placeholder]
	for (const [oldId, placeholder] of placeholders) {
		const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const refPattern = new RegExp(`\\[\\^${escaped}\\]`, "g");
		content = content.replace(refPattern, `[^${placeholder}]`);
	}

	// Second pass: placeholders → new IDs
	for (const [oldId, placeholder] of placeholders) {
		const newId = renumberMap.get(oldId)!;
		const placeholderPattern = new RegExp(
			`\\[\\^${placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`,
			"g",
		);
		content = content.replace(placeholderPattern, `[^${newId}]`);
	}

	// --- 5) Reorder definitions to match new sequence ---
	// Parse definitions with their full text (including multi-line)
	const definitions = new Map<string, string>();
	const defPositions: { start: number; end: number }[] = [];

	const lines = content.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line) {
			i++;
			continue;
		}
		const defMatch = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
		if (defMatch) {
			const id = defMatch[1];
			const textLines = [defMatch[2] || ""];
			const startLine = i;

			// Collect continuation lines
			i++;
			while (i < lines.length) {
				const contLine = lines[i];
				if (contLine && contLine.match(/^[ \t]+\S/)) {
					textLines.push(contLine);
					i++;
				} else {
					break;
				}
			}

			if (id) {
				definitions.set(id, textLines.join("\n"));
				defPositions.push({ start: startLine, end: i - 1 });
			}
		} else {
			i++;
		}
	}

	// Remove old definitions (in reverse to preserve line indices)
	for (let j = defPositions.length - 1; j >= 0; j--) {
		const pos = defPositions[j];
		if (!pos) continue;
		lines.splice(pos.start, pos.end - pos.start + 1);
	}

	// Build new definitions in order
	const newDefs: string[] = [];
	const orderedIds = [...renumberMap.entries()]
		.sort((a, b) => {
			const aIsMargin = a[1].startsWith("mn-");
			const bIsMargin = b[1].startsWith("mn-");
			if (aIsMargin !== bIsMargin) return aIsMargin ? 1 : -1;
			const aNum = parseInt(a[1].replace("mn-", ""), 10);
			const bNum = parseInt(b[1].replace("mn-", ""), 10);
			return aNum - bNum;
		})
		.map(([_, newId]) => newId);

	// Optional safety cleanup: only emit defs that are actually referenced after renumber
	const referencedNewIds = new Set<string>(orderedIds);

	for (const newId of orderedIds) {
		if (!referencedNewIds.has(newId)) continue;
		const defText = definitions.get(newId);
		if (defText !== undefined) {
			newDefs.push(`[^${newId}]: ${defText}`);
		}
	}

	// Remove trailing empty lines, add definitions
	while (
		lines.length > 0 &&
		(lines[lines.length - 1]?.trim() ?? "") === ""
	) {
		lines.pop();
	}
	lines.push("");
	lines.push(...newDefs);
	lines.push("");

	content = lines.join("\n");

	// --- 6) Apply to editor ---
	applyRewrite(ctx, editor, content);
}

/**
 * True when the active markdown view is showing rendered preview.
 *
 * This matters for every write-back path. In reading mode there is no live
 * editor backing the view: `editor.replaceRange` writes into a CodeMirror
 * document that Obsidian discards the moment you switch to editing mode, so
 * the edit renders correctly and then silently disappears. Writes made in
 * this mode have to go through `vault.process`, which touches the file.
 */
