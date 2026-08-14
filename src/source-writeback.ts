/**
 * Locating sidenote text in a note's source so it can be replaced.
 *
 * Deliberately split from *how* the write happens. There are two mechanisms —
 * `editor.replaceRange` while editing, `vault.process` in reading mode, where
 * there is no live editor behind the view — and they used to carry their own
 * copies of the "find the sidenote and build its replacement" logic. The copies
 * drifted: the editor path's footnote pattern matched a single line while the
 * reading path's handled continuation lines, so a multi-line footnote edited in
 * editing mode lost everything after its first line.
 *
 * Everything here is a pure function of the source text.
 */

import { SIDENOTE_SPAN_REGEX } from "./patterns";

/** A replacement to make in the source, as character offsets. */
export interface SourceEdit {
	from: number;
	to: number;
	replacement: string;
}

/** Apply an edit to a string. */
export function applyEdit(content: string, edit: SourceEdit): string {
	return (
		content.slice(0, edit.from) + edit.replacement + content.slice(edit.to)
	);
}

/**
 * Locate an HTML sidenote span by its exact inner text.
 *
 * The opening tag is preserved verbatim so per-note class overrides
 * (`sidenote right`, `sidenote margin-note left`) survive the edit.
 */
export function findHtmlSpanEdit(
	content: string,
	originalText: string,
	newText: string,
): SourceEdit | null {
	const regex = SIDENOTE_SPAN_REGEX();
	let match: RegExpExecArray | null;

	while ((match = regex.exec(content)) !== null) {
		if (match[1] !== originalText) continue;

		const openingTag = match[0].substring(0, match[0].indexOf(">") + 1);
		return {
			from: match.index,
			to: match.index + match[0].length,
			replacement: `${openingTag}${newText}</span>`,
		};
	}

	return null;
}

/**
 * Locate a footnote definition's text by ID.
 *
 * The pattern spans continuation lines — an indented line following the
 * definition belongs to it — so a multi-line footnote is replaced whole.
 */
export function findFootnoteDefinitionEdit(
	content: string,
	footnoteId: string,
	newText: string,
): SourceEdit | null {
	const escapedId = footnoteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// `(?:\n[ \t]+.+)*` — the newline is INSIDE the repeated group, so every
	// indented continuation line is consumed. Both older copies of this pattern
	// wrote `(?:\n(?:[ \t]+.+)*)?`, which allows only one continuation line and
	// silently stranded the rest of a three-line footnote on edit.
	const regex = new RegExp(
		`^(\\[\\^${escapedId}\\]:[ \\t]*)(.+(?:\\n[ \\t]+.+)*)$`,
		"gm",
	);

	const match = regex.exec(content);
	if (!match || match.index === undefined) return null;

	const prefix = match[1] ?? "";
	return {
		// Keep the `[^id]: ` prefix; only the text after it is replaced.
		from: match.index + prefix.length,
		to: match.index + match[0].length,
		replacement: newText,
	};
}
