/**
 * Shared CodeMirror 6 primitives for the inline sidenote editors, plus the
 * single `openInlineMarkdownEditor` used by all of them.
 *
 * These lived in `widgets.ts`, which made it impossible for anything
 * `widgets.ts` imports to reuse them. They are editor concerns, not widget
 * concerns, so they belong here.
 */

import { App, EditorPosition, TFile } from "obsidian";
import { EditorView, keymap, Command } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
// eslint-disable-next-line import/no-extraneous-dependencies -- @lezer/highlight is a transitive dependency pulled in by @codemirror/language, used directly here for syntax tags
import { tags } from "@lezer/highlight";
import { setCssProps } from "./dom-utils";

/** Minimal subset of Obsidian's Editor interface backed by a CM6 EditorView. */
interface MinimalEditor {
	getValue(): string;
	getLine(line: number): string;
	lineCount(): number;
	getCursor(): EditorPosition;
	setCursor(pos: EditorPosition): void;
	setSelection(anchor: EditorPosition, head?: EditorPosition): void;
	getSelection(): string;
	replaceSelection(text: string): void;
	getRange(from: EditorPosition, to: EditorPosition): string;
	replaceRange(
		text: string,
		from: EditorPosition,
		to?: EditorPosition,
	): void;
}

function cmToPos(view: EditorView, offset: number): EditorPosition {
	const line = view.state.doc.lineAt(offset);
	return { line: line.number - 1, ch: offset - line.from };
}

function posToCm(view: EditorView, pos: EditorPosition): number {
	const line = view.state.doc.line(pos.line + 1);
	return Math.max(line.from, Math.min(line.to, line.from + pos.ch));
}

export function cmEditorAdapter(view: EditorView): MinimalEditor {
	return {
		getValue() {
			return view.state.doc.toString();
		},

		getLine(line: number) {
			return view.state.doc.line(line + 1).text;
		},

		lineCount() {
			return view.state.doc.lines;
		},

		getCursor() {
			return cmToPos(view, view.state.selection.main.head);
		},

		setCursor(pos: EditorPosition) {
			const off = posToCm(view, pos);
			view.dispatch({ selection: { anchor: off } });
		},

		setSelection(anchor: EditorPosition, head?: EditorPosition) {
			const a = posToCm(view, anchor);
			const h = posToCm(view, head ?? anchor);
			view.dispatch({ selection: { anchor: a, head: h } });
		},

		getSelection() {
			const sel = view.state.selection.main;
			return view.state.sliceDoc(sel.from, sel.to);
		},

		replaceSelection(text: string) {
			const sel = view.state.selection.main;
			view.dispatch({
				changes: { from: sel.from, to: sel.to, insert: text },
			});
		},

		getRange(from: EditorPosition, to: EditorPosition) {
			const a = posToCm(view, from);
			const b = posToCm(view, to);
			return view.state.sliceDoc(Math.min(a, b), Math.max(a, b));
		},

		replaceRange(text: string, from: EditorPosition, to?: EditorPosition) {
			const a = posToCm(view, from);
			const b = posToCm(view, to ?? from);
			view.dispatch({
				changes: {
					from: Math.min(a, b),
					to: Math.max(a, b),
					insert: text,
				},
			});
		},
	};
}

type WorkspaceWithActiveEditor = {
	activeEditor: null | {
		editor: MinimalEditor;
		file: TFile | null;
	};
};

export function setWorkspaceActiveEditor(
	app: App,
	view: EditorView | null,
) {
	const ws = app.workspace as unknown as WorkspaceWithActiveEditor;

	if (!view) {
		ws.activeEditor = null;
		return;
	}

	ws.activeEditor = {
		editor: cmEditorAdapter(view),
		file: app.workspace.getActiveFile(),
	};
}

function wrapSelection(view: EditorView, left: string, right: string) {
	const changes: { from: number; to: number; insert: string }[] = [];
	const ranges: { anchor: number; head: number }[] = [];

	for (const range of view.state.selection.ranges) {
		const from = Math.min(range.from, range.to);
		const to = Math.max(range.from, range.to);
		const selected = view.state.sliceDoc(from, to);

		const insert = left + selected + right;
		changes.push({ from, to, insert });

		// place cursor inside markers when no selection; otherwise keep selection
		if (from === to) {
			const cursor = from + left.length;
			ranges.push({ anchor: cursor, head: cursor });
		} else {
			ranges.push({
				anchor: from + left.length,
				head: to + left.length,
			});
		}
	}

	view.dispatch({
		changes,
		selection: EditorSelection.create(
			ranges.map((r) => EditorSelection.range(r.anchor, r.head)),
		),
		userEvent: "input",
	});
}

const mdBold: Command = (view) => {
	wrapSelection(view, "**", "**");
	return true;
};

const mdItalic: Command = (view) => {
	wrapSelection(view, "*", "*");
	return true;
};

const mdLink: Command = (view) => {
	// If selection: [text]()
	// If none: []() and cursor inside []
	const changes: { from: number; to: number; insert: string }[] = [];
	const ranges: { anchor: number; head: number }[] = [];

	for (const range of view.state.selection.ranges) {
		const from = Math.min(range.from, range.to);
		const to = Math.max(range.from, range.to);
		const selected = view.state.sliceDoc(from, to);

		const insert = `[${selected}]()`;
		changes.push({ from, to, insert });

		if (from === to) {
			// cursor between [ ]
			const cursor = from + 1;
			ranges.push({ anchor: cursor, head: cursor });
		} else {
			// keep selection on the text inside []
			ranges.push({
				anchor: from + 1,
				head: from + 1 + selected.length,
			});
		}
	}

	view.dispatch({
		changes,
		selection: EditorSelection.create(
			ranges.map((r) => EditorSelection.range(r.anchor, r.head)),
		),
		userEvent: "input",
	});

	return true;
};

export const markdownEditHotkeys = keymap.of([
	{ key: "Mod-b", run: mdBold, preventDefault: true },
	{ key: "Mod-i", run: mdItalic, preventDefault: true },
	{ key: "Mod-k", run: mdLink, preventDefault: true },
]);

export const sidenoteEditorTheme = EditorView.theme({
	"&": {
		backgroundColor: "transparent !important",
		color: "inherit !important",
		padding: "0 !important",
		margin: "0 !important",
		border: "none !important",
		height: "auto !important",
		minHeight: "0 !important",
		fontFamily: "inherit !important",
		fontSize: "inherit !important",
	},
	"& .cm-scroller": {
		padding: "0 !important",
		paddingLeft: "0 !important",
		paddingRight: "0 !important",
		margin: "0 !important",
		overflow: "visible !important",
		height: "auto !important",
		minHeight: "0 !important",
		fontFamily: "inherit !important",
	},
	"& .cm-content": {
		padding: "2px 0 !important",
		paddingLeft: "0 !important",
		margin: "0 !important",
		minHeight: "auto !important",
		fontFamily: "inherit !important",
		fontSize: "inherit !important",
		lineHeight: "inherit !important",
		caretColor:
			"var(--caret-color, var(--text-accent, var(--text-normal))) !important",
	},
	"& .cm-content[contenteditable]": {
		padding: "2px 0 !important",
		paddingLeft: "0 !important",
	},
	"& .cm-line": {
		padding: "0 !important",
		paddingLeft: "0 !important",
		margin: "0 !important",
		fontFamily: "inherit !important",
	},
	"& .cm-gutters": {
		display: "none !important",
		width: "0 !important",
		minWidth: "0 !important",
		border: "none !important",
	},
	"& .cm-cursor": {
		borderLeftColor: "var(--caret-color, var(--text-normal)) !important",
	},
	"&.cm-focused": {
		outline: "none !important",
	},
	"&.cm-focused .cm-cursor": {
		borderLeftColor: "var(--caret-color, var(--text-normal)) !important",
	},
	"& .cm-activeLineGutter": {
		backgroundColor: "transparent !important",
		display: "none !important",
	},
	"& .cm-activeLine": {
		backgroundColor: "transparent !important",
	},
});

export const sidenoteHighlightStyle = HighlightStyle.define([
	{ tag: tags.strong, fontWeight: "bold" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.strikethrough, textDecoration: "line-through" },
	{
		tag: tags.monospace,
		fontFamily: "var(--font-monospace)",
		fontSize: "0.9em",
	},
	{
		tag: tags.link,
		color: "var(--link-color, var(--text-accent))",
		textDecoration: "underline",
	},
	{ tag: tags.url, color: "var(--link-color, var(--text-accent))" },
	// Dim the markdown syntax characters (**, *, `, [, ], etc.)
	{ tag: tags.processingInstruction, color: "var(--text-faint)" },
]);

// ==================== Unified inline editor ====================

export interface InlineEditorCloseResult {
	/** Document text at the moment of close. */
	text: string;
	/** `text` when committed, the original otherwise — what to re-render. */
	renderText: string;
	/** The caller asked to commit. */
	committed: boolean;
	/** Committed AND the text actually differs. Gates every side effect. */
	changed: boolean;
}

export interface InlineEditorHandle {
	readonly view: EditorView;
	readonly originalText: string;
	/** Idempotent — safe from the keymap, an outside click, and teardown. */
	close(opts: { commit: boolean }): void;
	isOpen(): boolean;
}

export interface InlineEditorOptions {
	app: App;
	/** Where the CM6 view mounts. The caller empties it beforehand. */
	parent: HTMLElement;
	doc: string;
	/** Select the whole document on open — the new-footnote placeholder case. */
	selectAll?: boolean;
	/**
	 * Elements treated as "inside" for the outside-pointerdown commit.
	 * Pass `null` to disable it entirely: the margin-note popup manages its
	 * own document-level click handler and would double-fire.
	 */
	outsideBoundary?: HTMLElement[] | null;
	/** Stop keydown escaping the editor — the popup needs this. */
	stopKeydownPropagation?: boolean;
	/**
	 * Runs once, after the view is destroyed, the listeners are removed and
	 * workspace routing is restored. Write-back and re-render belong here.
	 */
	onClose: (result: InlineEditorCloseResult) => void;
}

/**
 * Mount a small markdown editor inside `parent`.
 *
 * Replaces three hand-rolled copies that had drifted apart in the usual ways:
 * one registered Escape without `preventDefault`, one had `defaultKeymap` and
 * `historyKeymap` in the opposite order, and only one supported selecting the
 * document on open. Behaviour that genuinely differs per call site is an
 * option; everything else is fixed here.
 */
export function openInlineMarkdownEditor(
	opts: InlineEditorOptions,
): InlineEditorHandle {
	const originalText = opts.doc;
	let closed = false;
	let outsidePointerDown: ((ev: PointerEvent) => void) | undefined;

	// Declared before the keymap so the handlers can reach it.
	let handle: InlineEditorHandle;

	const closeKeymap = keymap.of([
		{
			key: "Escape",
			run: () => {
				handle.close({ commit: false });
				return true;
			},
			preventDefault: true,
		},
		{
			key: "Enter",
			run: () => {
				handle.close({ commit: true });
				return true;
			},
			preventDefault: true,
		},
		{
			key: "Shift-Enter",
			run: (view) => {
				view.dispatch(view.state.replaceSelection("\n"));
				return true;
			},
			preventDefault: true,
		},
	]);

	const state = EditorState.create({
		doc: originalText,
		selection: opts.selectAll
			? EditorSelection.single(0, originalText.length)
			: undefined,
		extensions: [
			closeKeymap,
			sidenoteEditorTheme,
			history(),
			markdown(),
			syntaxHighlighting(sidenoteHighlightStyle, { fallback: true }),
			markdownEditHotkeys,
			keymap.of(historyKeymap),
			keymap.of(defaultKeymap),
			EditorView.lineWrapping,
		],
	});

	const view = new EditorView({ state, parent: opts.parent });
	view.dom.classList.add("sidenote-cm-editor");

	// CM6 sets its own scroller padding; force it off so the text lines up
	// with the rendered margin it replaces.
	const scroller = view.dom.querySelector<HTMLElement>(".cm-scroller");
	if (scroller) {
		setCssProps(scroller, { "padding-left": "0", padding: "0" }, true);
	}

	// Route Obsidian commands to this editor while it holds focus. focusout is
	// not reliable for "click outside" with CM, so it only drops the routing.
	view.dom.addEventListener(
		"focusin",
		() => setWorkspaceActiveEditor(opts.app, view),
		true,
	);
	view.dom.addEventListener(
		"focusout",
		() => setWorkspaceActiveEditor(opts.app, null),
		true,
	);

	if (opts.stopKeydownPropagation) {
		view.dom.addEventListener("keydown", (e) => e.stopPropagation());
	}

	handle = {
		view,
		originalText,
		isOpen: () => !closed,
		close(closeOpts: { commit: boolean }) {
			if (closed) return;
			closed = true;

			const text = view.state.doc.toString();
			const committed = closeOpts.commit;
			const result: InlineEditorCloseResult = {
				text,
				renderText: committed ? text : originalText,
				committed,
				changed: committed && text !== originalText,
			};

			if (outsidePointerDown) {
				document.removeEventListener(
					"pointerdown",
					outsidePointerDown,
					true,
				);
				outsidePointerDown = undefined;
			}

			view.destroy();
			setWorkspaceActiveEditor(opts.app, null);

			opts.onClose(result);
		},
	};

	if (opts.outsideBoundary !== null) {
		const boundary = opts.outsideBoundary ?? [opts.parent];
		outsidePointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (view.dom.contains(target)) return;
			if (boundary.some((el) => el.contains(target))) return;
			handle.close({ commit: true });
		};
		document.addEventListener("pointerdown", outsidePointerDown, true);
	}

	window.requestAnimationFrame(() => view.focus());

	return handle;
}
