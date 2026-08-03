import type { Editor } from "obsidian";
import type { SidenoteSettings } from "../settings";
import type { SidenoteSide } from "../content";

/**
 * The four "insert" commands are one operation with two independent flags.
 * They were previously four ~100-line copies that differed only in the values
 * derived below.
 */
export interface InsertNoteVariant {
	/** Unnumbered margin note: `margin-note` class / `mn-` ID prefix. */
	marginNote: boolean;
	/** Pin to the margin opposite the document-wide "Sidenote position". */
	oppositeMargin: boolean;
}

export interface InsertNoteContext {
	settings: SidenoteSettings;
	/**
	 * Register a footnote ID so its editor opens once the CM6 widget mounts.
	 * Only meaningful in the footnote formats.
	 */
	requestFootnoteEdit(footnoteId: string): void;
}

/** Highest number already used in the given ID series, or 0 if none. */
function nextNumberInSeries(content: string, marginNote: boolean): number {
	// Margin notes carry their own `mn-` series, numbered independently of
	// regular sidenotes — [^mn-1] and [^1] can both exist in one document.
	const pattern = marginNote
		? /\[\^mn-(\d+)(?:-[rl])?\]/g
		: /\[\^(\d+)(?:-[rl])?\]/g;
	const single = marginNote
		? /\[\^mn-(\d+)(?:-[rl])?\]/
		: /\[\^(\d+)(?:-[rl])?\]/;

	const existing = content.match(pattern) ?? [];
	const used = existing.map((ref) => {
		const match = ref.match(single);
		return match && match[1] ? parseInt(match[1], 10) : 0;
	});
	return used.length > 0 ? Math.max(...used) + 1 : 1;
}

/** Index of the last `[^id]:` definition line, or -1 if there are none. */
function findLastDefinitionLine(content: string): number {
	const lines = content.split("\n");
	let last = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line && line.match(/^\[\^[^\]]+\]:/)) {
			last = i;
		}
	}
	return last;
}

/**
 * Append a footnote definition, after the last existing one if there is one.
 *
 * `hadDefinitions` is measured *before* the reference was inserted; the
 * definition block is re-located in the updated document because inserting the
 * reference shifts every line below it.
 */
function appendDefinition(
	editor: Editor,
	definition: string,
	hadDefinitions: boolean,
) {
	if (!hadDefinitions) {
		// No existing footnotes - add at the very end with blank lines
		const lastLine = editor.lastLine();
		const lastLineContent = editor.getLine(lastLine);
		const prefix = lastLineContent.trim() ? "\n\n" : "\n";
		editor.replaceRange(prefix + definition, {
			line: lastLine,
			ch: lastLineContent.length,
		});
		return;
	}

	const lastDefLine = findLastDefinitionLine(editor.getValue());
	if (lastDefLine === -1) return;

	editor.replaceRange("\n" + definition, {
		line: lastDefLine,
		ch: editor.getLine(lastDefLine).length,
	});
}

/**
 * Insert a sidenote or margin note at the cursor, in whichever format the
 * `sidenoteFormat` setting selects.
 */
export function insertNote(
	ctx: InsertNoteContext,
	editor: Editor,
	variant: InsertNoteVariant,
) {
	const cursor = editor.getCursor();
	const selectedText = editor.getSelection();

	const oppositeSide: SidenoteSide =
		ctx.settings.sidenotePosition === "left" ? "right" : "left";

	if (ctx.settings.sidenoteFormat === "html") {
		const classes = [
			"sidenote",
			variant.marginNote ? "margin-note" : null,
			variant.oppositeMargin ? oppositeSide : null,
		]
			.filter(Boolean)
			.join(" ");
		const openTag = `<span class="${classes}">`;

		if (selectedText) {
			editor.replaceSelection(`${openTag}${selectedText}</span>`);
		} else {
			editor.replaceRange(`${openTag}</span>`, cursor);
			// Park the cursor between the tags
			editor.setCursor({
				line: cursor.line,
				ch: cursor.ch + openTag.length,
			});
		}
		return;
	}

	// Footnote format
	const content = editor.getValue();
	const nextNum = nextNumberInSeries(content, variant.marginNote);
	const hadDefinitions = findLastDefinitionLine(content) !== -1;

	const footnoteContent =
		selectedText || (variant.marginNote ? "New margin note" : "New sidenote");

	const suffix = variant.oppositeMargin
		? oppositeSide === "right"
			? "-r"
			: "-l"
		: "";
	const newId = `${variant.marginNote ? "mn-" : ""}${nextNum}${suffix}`;

	// Reference first, then the definition — appendDefinition re-reads the
	// document because this insertion shifts the line numbers below it.
	editor.replaceRange(`[^${newId}]`, cursor);
	appendDefinition(editor, `[^${newId}]: ${footnoteContent}`, hadDefinitions);

	ctx.requestFootnoteEdit(newId);
}
