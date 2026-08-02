import { MarkdownView, Plugin, TFile, Menu, Editor } from "obsidian";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
	DEFAULT_SETTINGS,
	SidenoteSettings,
	SidenoteSettingTab,
} from "./settings";

// CM6 building blocks for proper shortcuts + undo
import {
	defaultKeymap,
	history,
	historyKeymap,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { setCssProps } from "./dom-utils";
import {
	buildSourceRefOrder,
	formatNumber,
	getSidenoteSideOverride,
	isMarginNote,
	normalizeText,
	parseFootnoteDefinitions,
	renderLinksToFragment,
	resolveFootnoteBaseId,
	type SidenoteSide,
	stripSideSuffix,
} from "./content";
import { resolveCollisionsBySide } from "./collision";
import {
	injectPrintSidenotes,
	type PrintExportContext,
} from "./print-export";
import {
	createFootnoteSidenotePlugin,
	markdownEditHotkeys,
	sidenoteEditorTheme,
	sidenoteHighlightStyle,
	setWorkspaceActiveEditor,
} from "./widgets";

type CleanupFn = () => void;

// Near the top of the file, with your other type definitions
interface SidenoteMarginElement extends HTMLElement {
	_sidenoteCleanup?: () => void;
}

type HasCmScrollTop = {
	cm?: {
		scrollDOM?: {
			scrollTop?: number;
		};
	};
};

// Regex to detect sidenote spans in source text (includes margin-note variant)
const SIDENOTE_PATTERN = () =>
	/<span\s+class\s*=\s*["']sidenote(?:\s+margin-note)?["'][^>]*>/gi;

const SIDENOTE_SPAN_REGEX = () =>
	/<span\s+class\s*=\s*["']sidenote(?:\s+margin-note)?["'][^>]*>([\s\S]*?)<\/span>/gi;

// ======================================================
// ================= Main Plugin Class ==================
// ======================================================
export default class SidenotePlugin extends Plugin {
	settings: SidenoteSettings;

	private rafId: number | null = null;
	private cleanups: CleanupFn[] = [];
	private cmRoot: HTMLElement | null = null;
	private isMutating = false;
	private resizeObserver: ResizeObserver | null = null;
	private styleEl: HTMLStyleElement | null = null;

	// Map from sidenote text content (or position) to assigned number
	private sidenoteRegistry: Map<string, number> = new Map();
	private headingSidenoteNumbers: Map<string, number> = new Map();

	// Incremented on every settings save to signal the CM6 ViewPlugin to rebuild
	private _settingsVersion = 0;

	// Track whether current document has any sidenotes
	private documentHasSidenotes = false;

	// Performance: Debounce/throttle timers
	private scrollDebounceTimer: number | null = null;
	private mutationDebounceTimer: number | null = null;
	private resizeThrottleTime: number = 0;

	// Performance: Layout caching
	private lastSidenoteCount: number = 0;

	// Performance: Visible sidenotes tracking
	private visibilityObserver: IntersectionObserver | null = null;
	private visibleSidenotes: Set<HTMLElement> = new Set();

	private isEditingMargin = false;
	private readingModeScrollTimer: number | null = null;

	private footnoteProcessingTimer: number | null = null;
	public needsReadingModeRefresh = true;

	private pendingFootnoteEdit: string | null = null;
	private pendingFootnoteEditRetries = 0;

	// Cached source content for reading mode (editor.getValue() can be empty)
	private cachedSourceContent: string = "";

	// Timing constants (in milliseconds)
	private static readonly RESIZE_DEBOUNCE = 100;
	private static readonly SCROLL_DEBOUNCE = 50;
	private static readonly MUTATION_DEBOUNCE = 100;
	private static readonly FOOTNOTE_RENDER_DELAY = 100;
	private static readonly WIDGET_LAYOUT_DELAY = 50;
	private static readonly INSERT_SIDENOTE_DELAY = 150;
	private static readonly MAX_FOOTNOTE_EDIT_RETRIES = 10;
	private readingModeResizeThrottleTime: number = 0;
	private readingModeResizeTrailingTimer: number | null = null;

	private spanCmView: EditorView | null = null;
	private spanOutsidePointerDown?: (ev: PointerEvent) => void;
	private spanOriginalText: string = "";

	// Reading-mode footnote editing state
	private readingCmView: EditorView | null = null;
	private readingCmOutsidePointerDown?: (ev: PointerEvent) => void;
	private readingCmOriginalText: string = "";
	private readingCmFootnoteId: string = "";
	private activeReadingModeMargin: HTMLElement | null = null;

	// Track the currently editing margin element for the global capture listener
	private currentlyEditingMargin: HTMLElement | null = null;
	// Cooldown timer after a reading-mode edit commit to prevent
	// the MutationObserver-triggered rebuild from overwriting the
	// freshly re-rendered margin with stale source data.
	private postEditCooldown: number | null = null;

	// Pre-cached file content for PDF export (keyed by file path)
	private fileContentCache = new Map<string, string>();

	// Delegated click handler for reading mode margins (survives virtualization)
	private readingModeDelegateHandler: ((ev: MouseEvent) => void) | null =
		null;

	// Track which footnote is being edited (by footnote ID)
	private activeFootnoteEdit: string | null = null;
	private layoutTrailingTimer: number | null = null;

	// Collision avoidance scheduling. Kept separate from `rafId` (used by
	// scheduleLayout) so a pending layout never swallows a collision request.
	private collisionRafId: number | null = null;
	// Watches every margin for height changes (late image/embed loads, inline
	// editor open/close, font swaps) and re-resolves collisions.
	private marginResizeObserver: ResizeObserver | null = null;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new SidenoteSettingTab(this.app, this));
		this.injectStyles();
		this.setupVisibilityObserver();
		this.setupMarginResizeObserver();

		// Register the CM6 extension for footnote sidenotes in editing mode
		this.registerEditorExtension([createFootnoteSidenotePlugin(this)]);

		// Add command to insert sidenote
		this.addCommand({
			id: "insert-sidenote",
			name: "Insert sidenote",
			editorCallback: (editor) => {
				const cursor = editor.getCursor();
				const selectedText = editor.getSelection();

				if (this.settings.sidenoteFormat === "html") {
					if (selectedText) {
						editor.replaceSelection(
							`<span class="sidenote">${selectedText}</span>`,
						);
					} else {
						const sidenoteText = '<span class="sidenote"></span>';
						editor.replaceRange(sidenoteText, cursor);
						const newCursor = {
							line: cursor.line,
							ch: cursor.ch + '<span class="sidenote">'.length,
						};
						editor.setCursor(newCursor);
					}
				} else {
					// Footnote format - need to find next available footnote number
					const content = editor.getValue();
					const existingRefs =
						content.match(/\[\^(\d+)(?:-[rl])?\]/g) ?? [];
					const usedNumbers = existingRefs.map((fn) => {
						const match = fn.match(/\[\^(\d+)(?:-[rl])?\]/);
						return match && match[1] ? parseInt(match[1], 10) : 0;
					});
					const nextNum =
						usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 1;

					// Determine the content for the footnote
					const footnoteContent = selectedText
						? selectedText
						: "New sidenote";

					// Find where footnote definitions are in the document
					const lines = content.split("\n");
					let lastFootnoteLine = -1;

					for (let i = 0; i < lines.length; i++) {
						const line = lines[i];
						if (line && line.match(/^\[\^[^\]]+\]:/)) {
							lastFootnoteLine = i;
						}
					}

					// Build the definition
					const definition = `[^${nextNum}]: ${footnoteContent}`;

					// Insert the reference at cursor
					editor.replaceRange(`[^${nextNum}]`, cursor);

					// Re-read content after first insertion
					const updatedContent = editor.getValue();
					const updatedLines = updatedContent.split("\n");

					if (lastFootnoteLine === -1) {
						// No existing footnotes - add at the very end with blank lines
						const lastLine = editor.lastLine();
						const lastLineContent = editor.getLine(lastLine);
						const prefix = lastLineContent.trim() ? "\n\n" : "\n";
						editor.replaceRange(prefix + definition, {
							line: lastLine,
							ch: lastLineContent.length,
						});
					} else {
						// Find the last footnote line again in the updated content
						let newLastFootnoteLine = -1;
						for (let i = 0; i < updatedLines.length; i++) {
							const line = updatedLines[i];
							if (line && line.match(/^\[\^[^\]]+\]:/)) {
								newLastFootnoteLine = i;
							}
						}

						if (newLastFootnoteLine !== -1) {
							// Insert after the last footnote
							const insertLineContent = editor.getLine(
								newLastFootnoteLine,
							);
							editor.replaceRange("\n" + definition, {
								line: newLastFootnoteLine,
								ch: insertLineContent.length,
							});
						}
					}

					// Set flag to auto-edit this footnote when the widget appears
					this.pendingFootnoteEdit = String(nextNum);

					// Schedule the auto-edit after widgets are rendered
					window.setTimeout(() => {
						this.triggerPendingFootnoteEdit();
					}, SidenotePlugin.INSERT_SIDENOTE_DELAY);
				}
			},
		});

		// Command for resequencing footnotes
		this.addCommand({
			id: "resequence-footnotes",
			name: "Resequence footnotes (if out of order)",
			editorCallback: (editor) => {
				this.resequenceFootnotes(editor);
			},
		});

		// Command for inserting a Sidenote - will default to whichever
		// margin is set in the settings
		this.addCommand({
			id: "insert-sidenote",
			name: "Insert sidenote",
			editorCallback: (editor) => {
				const cursor = editor.getCursor();
				const selectedText = editor.getSelection();

				if (this.settings.sidenoteFormat === "html") {
					if (selectedText) {
						editor.replaceSelection(
							`<span class="sidenote">${selectedText}</span>`,
						);
					} else {
						const sidenoteText = '<span class="sidenote"></span>';
						editor.replaceRange(sidenoteText, cursor);
						const newCursor = {
							line: cursor.line,
							ch: cursor.ch + '<span class="sidenote">'.length,
						};
						editor.setCursor(newCursor);
					}
				} else {
					// Footnote format - need to find next available footnote number
					const content = editor.getValue();
					const existingRefs =
						content.match(/\[\^(\d+)(?:-[rl])?\]/g) ?? [];
					const usedNumbers = existingRefs.map((fn) => {
						const match = fn.match(/\[\^(\d+)(?:-[rl])?\]/);
						return match && match[1] ? parseInt(match[1], 10) : 0;
					});
					const nextNum =
						usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 1;

					// Determine the content for the footnote
					const footnoteContent = selectedText
						? selectedText
						: "New sidenote";

					// Find where footnote definitions are in the document
					const lines = content.split("\n");
					let lastFootnoteLine = -1;

					for (let i = 0; i < lines.length; i++) {
						const line = lines[i];
						if (line && line.match(/^\[\^[^\]]+\]:/)) {
							lastFootnoteLine = i;
						}
					}

					// Build the definition
					const definition = `[^${nextNum}]: ${footnoteContent}`;

					// Insert the reference at cursor
					editor.replaceRange(`[^${nextNum}]`, cursor);

					// Re-read content after first insertion
					const updatedContent = editor.getValue();
					const updatedLines = updatedContent.split("\n");

					if (lastFootnoteLine === -1) {
						// No existing footnotes - add at the very end with blank lines
						const lastLine = editor.lastLine();
						const lastLineContent = editor.getLine(lastLine);
						const prefix = lastLineContent.trim() ? "\n\n" : "\n";
						editor.replaceRange(prefix + definition, {
							line: lastLine,
							ch: lastLineContent.length,
						});
					} else {
						// Find the last footnote line again in the updated content
						let newLastFootnoteLine = -1;
						for (let i = 0; i < updatedLines.length; i++) {
							const line = updatedLines[i];
							if (line && line.match(/^\[\^[^\]]+\]:/)) {
								newLastFootnoteLine = i;
							}
						}

						if (newLastFootnoteLine !== -1) {
							// Insert after the last footnote
							const insertLineContent = editor.getLine(
								newLastFootnoteLine,
							);
							editor.replaceRange("\n" + definition, {
								line: newLastFootnoteLine,
								ch: insertLineContent.length,
							});
						}
					}

					// Set flag to auto-edit this footnote when the widget appears
					this.pendingFootnoteEdit = String(nextNum);

					// Schedule the auto-edit after widgets are rendered
					window.setTimeout(() => {
						this.triggerPendingFootnoteEdit();
					}, SidenotePlugin.INSERT_SIDENOTE_DELAY);
				}
			},
		});

		// Command to insert a Sidenote pinned to the margin opposite the
		// document-wide "Sidenote position" setting (see getSidenoteSideOverride).
		this.addCommand({
			id: "insert-sidenote-opposite-margin",
			name: "Insert sidenote (opposite margin, experimental)",
			editorCallback: (editor) => {
				const cursor = editor.getCursor();
				const selectedText = editor.getSelection();
				const oppositeSide: SidenoteSide =
					this.settings.sidenotePosition === "left" ? "right" : "left";

				if (this.settings.sidenoteFormat === "html") {
					const openTag = `<span class="sidenote ${oppositeSide}">`;
					if (selectedText) {
						editor.replaceSelection(`${openTag}${selectedText}</span>`);
					} else {
						editor.replaceRange(`${openTag}</span>`, cursor);
						const newCursor = {
							line: cursor.line,
							ch: cursor.ch + openTag.length,
						};
						editor.setCursor(newCursor);
					}
				} else {
					// Footnote format — same numbering logic as "Insert sidenote",
					// plus the -r/-l suffix that pins it to the opposite margin.
					const suffix = oppositeSide === "right" ? "-r" : "-l";
					const content = editor.getValue();
					const existingRefs =
						content.match(/\[\^(\d+)(?:-[rl])?\]/g) ?? [];
					const usedNumbers = existingRefs.map((fn) => {
						const match = fn.match(/\[\^(\d+)(?:-[rl])?\]/);
						return match && match[1] ? parseInt(match[1], 10) : 0;
					});
					const nextNum =
						usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 1;

					const footnoteContent = selectedText
						? selectedText
						: "New sidenote";

					const lines = content.split("\n");
					let lastFootnoteLine = -1;

					for (let i = 0; i < lines.length; i++) {
						const line = lines[i];
						if (line && line.match(/^\[\^[^\]]+\]:/)) {
							lastFootnoteLine = i;
						}
					}

					const newId = `${nextNum}${suffix}`;
					const definition = `[^${newId}]: ${footnoteContent}`;

					editor.replaceRange(`[^${newId}]`, cursor);

					const updatedContent = editor.getValue();
					const updatedLines = updatedContent.split("\n");

					if (lastFootnoteLine === -1) {
						const lastLine = editor.lastLine();
						const lastLineContent = editor.getLine(lastLine);
						const prefix = lastLineContent.trim() ? "\n\n" : "\n";
						editor.replaceRange(prefix + definition, {
							line: lastLine,
							ch: lastLineContent.length,
						});
					} else {
						let newLastFootnoteLine = -1;
						for (let i = 0; i < updatedLines.length; i++) {
							const line = updatedLines[i];
							if (line && line.match(/^\[\^[^\]]+\]:/)) {
								newLastFootnoteLine = i;
							}
						}

						if (newLastFootnoteLine !== -1) {
							const insertLineContent = editor.getLine(
								newLastFootnoteLine,
							);
							editor.replaceRange("\n" + definition, {
								line: newLastFootnoteLine,
								ch: insertLineContent.length,
							});
						}
					}

					// Set flag to auto-edit this footnote when the widget appears
					this.pendingFootnoteEdit = newId;

					// Schedule the auto-edit after widgets are rendered
					window.setTimeout(() => {
						this.triggerPendingFootnoteEdit();
					}, SidenotePlugin.INSERT_SIDENOTE_DELAY);
				}
			},
		});

		// Command to insert margin note (unnumbered)
		this.addCommand({
			id: "insert-margin-note",
			name: "Insert margin note",
			editorCallback: (editor) => {
				const cursor = editor.getCursor();
				const selectedText = editor.getSelection();

				if (this.settings.sidenoteFormat === "html") {
					if (selectedText) {
						editor.replaceSelection(
							`<span class="sidenote margin-note">${selectedText}</span>`,
						);
					} else {
						const marginText =
							'<span class="sidenote margin-note"></span>';
						editor.replaceRange(marginText, cursor);
						const newCursor = {
							line: cursor.line,
							ch: cursor.ch + '<span class="sidenote margin-note">'.length,
						};
						editor.setCursor(newCursor);
					}
				} else {
					// Footnote format — use mn- prefix
					const content = editor.getValue();
					// Find next available mn- number
					const existingMnRefs =
						content.match(/\[\^mn-(\d+)(?:-[rl])?\]/g) ?? [];
					const usedNumbers = existingMnRefs.map((fn) => {
						const match = fn.match(/\[\^mn-(\d+)(?:-[rl])?\]/);
						return match && match[1] ? parseInt(match[1], 10) : 0;
					});
					const nextNum =
						usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 1;

					const footnoteContent = selectedText
						? selectedText
						: "New margin note";

					const lines = content.split("\n");
					let lastFootnoteLine = -1;

					for (let i = 0; i < lines.length; i++) {
						const line = lines[i];
						if (line && line.match(/^\[\^[^\]]+\]:/)) {
							lastFootnoteLine = i;
						}
					}

					const definition = `[^mn-${nextNum}]: ${footnoteContent}`;

					editor.replaceRange(`[^mn-${nextNum}]`, cursor);

					const updatedContent = editor.getValue();
					const updatedLines = updatedContent.split("\n");

					if (lastFootnoteLine === -1) {
						const lastLine = editor.lastLine();
						const lastLineContent = editor.getLine(lastLine);
						const prefix = lastLineContent.trim() ? "\n\n" : "\n";
						editor.replaceRange(prefix + definition, {
							line: lastLine,
							ch: lastLineContent.length,
						});
					} else {
						let newLastFootnoteLine = -1;
						for (let i = 0; i < updatedLines.length; i++) {
							const line = updatedLines[i];
							if (line && line.match(/^\[\^[^\]]+\]:/)) {
								newLastFootnoteLine = i;
							}
						}

						if (newLastFootnoteLine !== -1) {
							const insertLineContent = editor.getLine(
								newLastFootnoteLine,
							);
							editor.replaceRange("\n" + definition, {
								line: newLastFootnoteLine,
								ch: insertLineContent.length,
							});
						}
					}

					this.pendingFootnoteEdit = `mn-${nextNum}`;

					window.setTimeout(() => {
						this.triggerPendingFootnoteEdit();
					}, SidenotePlugin.INSERT_SIDENOTE_DELAY);
				}
			},
		});

		// Command to insert a margin note pinned to the margin opposite
		// the document-wide "Sidenote position" setting.
		this.addCommand({
			id: "insert-margin-note-opposite-margin",
			name: "Insert margin note (opposite margin, experimental)",
			editorCallback: (editor) => {
				const cursor = editor.getCursor();
				const selectedText = editor.getSelection();
				const oppositeSide: SidenoteSide =
					this.settings.sidenotePosition === "left" ? "right" : "left";

				if (this.settings.sidenoteFormat === "html") {
					const openTag = `<span class="sidenote margin-note ${oppositeSide}">`;
					if (selectedText) {
						editor.replaceSelection(`${openTag}${selectedText}</span>`);
					} else {
						editor.replaceRange(`${openTag}</span>`, cursor);
						const newCursor = {
							line: cursor.line,
							ch: cursor.ch + openTag.length,
						};
						editor.setCursor(newCursor);
					}
				} else {
					// Footnote format — mn- prefix plus the -r/-l suffix that
					// pins it to the opposite margin.
					const suffix = oppositeSide === "right" ? "-r" : "-l";
					const content = editor.getValue();
					const existingMnRefs =
						content.match(/\[\^mn-(\d+)(?:-[rl])?\]/g) ?? [];
					const usedNumbers = existingMnRefs.map((fn) => {
						const match = fn.match(/\[\^mn-(\d+)(?:-[rl])?\]/);
						return match && match[1] ? parseInt(match[1], 10) : 0;
					});
					const nextNum =
						usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 1;

					const footnoteContent = selectedText
						? selectedText
						: "New margin note";

					const lines = content.split("\n");
					let lastFootnoteLine = -1;

					for (let i = 0; i < lines.length; i++) {
						const line = lines[i];
						if (line && line.match(/^\[\^[^\]]+\]:/)) {
							lastFootnoteLine = i;
						}
					}

					const newId = `mn-${nextNum}${suffix}`;
					const definition = `[^${newId}]: ${footnoteContent}`;

					editor.replaceRange(`[^${newId}]`, cursor);

					const updatedContent = editor.getValue();
					const updatedLines = updatedContent.split("\n");

					if (lastFootnoteLine === -1) {
						const lastLine = editor.lastLine();
						const lastLineContent = editor.getLine(lastLine);
						const prefix = lastLineContent.trim() ? "\n\n" : "\n";
						editor.replaceRange(prefix + definition, {
							line: lastLine,
							ch: lastLineContent.length,
						});
					} else {
						let newLastFootnoteLine = -1;
						for (let i = 0; i < updatedLines.length; i++) {
							const line = updatedLines[i];
							if (line && line.match(/^\[\^[^\]]+\]:/)) {
								newLastFootnoteLine = i;
							}
						}

						if (newLastFootnoteLine !== -1) {
							const insertLineContent = editor.getLine(
								newLastFootnoteLine,
							);
							editor.replaceRange("\n" + definition, {
								line: newLastFootnoteLine,
								ch: insertLineContent.length,
							});
						}
					}

					this.pendingFootnoteEdit = newId;

					window.setTimeout(() => {
						this.triggerPendingFootnoteEdit();
					}, SidenotePlugin.INSERT_SIDENOTE_DELAY);
				}
			},
		});

		this.registerMarkdownPostProcessor((element, context) => {
			let hasContent = false;

			if (this.settings.sidenoteFormat === "html") {
				hasContent = element.querySelectorAll("span.sidenote").length > 0;
			} else {
				hasContent =
					element.querySelectorAll(
						"sup.footnote-ref, sup[id^='fnref-'], sup[data-footnote-id], a.footnote-link, section.footnotes",
					).length > 0;
			}

			if (hasContent) {
				if (this.settings.sidenoteFormat !== "html") {
					this.scheduleFootnoteProcessing();
				} else {
					window.setTimeout(() => {
						window.requestAnimationFrame(() => {
							window.requestAnimationFrame(() => {
								this.processReadingModeSidenotes(element);
							});
						});
					}, 0);
				}

				// Inject print sidenotes synchronously for PDF export
				injectPrintSidenotes(this.printExportContext(), element, context);
			}
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.resetRegistry();
				this.invalidateLayoutCache();
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.rebind();
				this.scheduleLayoutStable();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				// Update cached source so reading mode picks up edits
				// made in editing mode (and vice versa)
				this.scanDocumentForSidenotes();
				this.needsReadingModeRefresh = true;
				this.invalidateLayoutCache();
				this.rebindAndSchedule();
				void this.preCacheFileContent();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (_file: TFile | null) => {
				this.resetRegistry();
				this.invalidateLayoutCache();
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.rebindAndSchedule();
				void this.preCacheFileContent();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				if (this.isEditingMargin) return;
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.invalidateLayoutCache();
				this.scheduleLayoutDebounced(SidenotePlugin.MUTATION_DEBOUNCE);
				void this.preCacheFileContent();
			}),
		);

		this.registerDomEvent(window, "resize", () => {
			this.needsReadingModeRefresh = true;
			this.scheduleLayoutThrottled(SidenotePlugin.RESIZE_DEBOUNCE);
			this.scheduleReadingModeLayoutThrottled(100);
		});

		// Immediate — works if plugin is enabled/reloaded after startup
		// this.scanDocumentForSidenotes();
		// this.rebindAndSchedule();
		// void this.preCacheFileContent();

		this.app.workspace.onLayoutReady(() => {
			this.scanDocumentForSidenotes();
			this.rebindAndSchedule();
			void this.preCacheFileContent();

			// Debug: log what state we're in
			// setTimeout(() => {
			// 	const cmRoot = this.cmRoot;
			// 	console.log("[Sidenotes] Startup check:", {
			// 		hasCmRoot: !!cmRoot,
			// 		cmRootConnected: cmRoot?.isConnected,
			// 		cmRootWidth: cmRoot?.getBoundingClientRect().width,
			// 		mode: cmRoot?.dataset.sidenoteMode,
			// 		hasSidenotes: cmRoot?.dataset.hasSidenotes,
			// 		marginCount: cmRoot?.querySelectorAll("small.sidenote-margin")
			// 			.length,
			// 		resizeObserverExists: !!this.resizeObserver,
			// 	});
			// }, 2000);
		});
	}

	onunload() {
		this.cancelAllTimers();
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		// Clear pending edit
		this.pendingFootnoteEdit = null;
		this.pendingFootnoteEditRetries = 0;
		this.currentlyEditingMargin = null;
		// Clear post-edit cooldown
		if (this.postEditCooldown !== null) {
			window.clearTimeout(this.postEditCooldown);
			this.postEditCooldown = null;
		}

		// Clear delegated reading mode handler
		this.readingModeDelegateHandler = null;

		// Clear active footnote edit
		this.activeFootnoteEdit = null;

		// Clean up footnote processing timer
		if (this.footnoteProcessingTimer !== null) {
			window.clearTimeout(this.footnoteProcessingTimer);
			this.footnoteProcessingTimer = null;
		}

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		if (this.visibilityObserver) {
			this.visibilityObserver.disconnect();
			this.visibilityObserver = null;
		}

		if (this.marginResizeObserver) {
			this.marginResizeObserver.disconnect();
			this.marginResizeObserver = null;
		}

		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
		}

		// Clean up reading mode scroll timer
		if (this.readingModeScrollTimer !== null) {
			window.clearTimeout(this.readingModeScrollTimer);
			this.readingModeScrollTimer = null;
		}

		const view = this.getMarkdownView();
		this.cleanupView(view);

		// Remove CSS custom properties and data attributes
		const root = document.documentElement;
		const propsToRemove = Array.from(root.style).filter((p) =>
			p.startsWith("--sn-"),
		);
		for (const prop of propsToRemove) {
			root.style.removeProperty(prop);
		}

		delete root.dataset.snBadgeStyle;
		delete root.dataset.snShowNumbers;
		delete root.dataset.snFormat;
		delete root.dataset.snHideFootnotes;
		delete root.dataset.snHideFootnoteNumbers;
		delete root.dataset.snEditInReadingMode;
	}

	// Add public methods that the widget can call
	public renderLinksToFragmentPublic(text: string): DocumentFragment {
		return this.renderLinksToFragment(text);
	}

	public normalizeTextPublic(s: string): string {
		return this.normalizeText(s);
	}

	public parseFootnoteDefinitionsPublic(
		content: string,
	): Map<string, string> {
		return this.parseFootnoteDefinitions(content);
	}

	public formatNumberPublic(num: number): string {
		return this.formatNumber(num);
	}

	public scheduleEditingModeCollisionUpdate() {
		this.scheduleCollisionUpdate();
	}

	/**
	 * Register a widget-created margin with the visibility/resize observers.
	 * Margins built by the CM6 widget bypass the layout() path that normally
	 * does this, so without it their height changes go unnoticed.
	 */
	public observeSidenoteMarginPublic(margin: HTMLElement) {
		this.observeSidenoteVisibility(margin);
	}

	public unobserveSidenoteMarginPublic(margin: HTMLElement) {
		this.unobserveSidenoteVisibility(margin);
	}

	public getActiveFootnoteEdit(): string | null {
		return this.activeFootnoteEdit;
	}

	public setActiveFootnoteEdit(footnoteId: string | null) {
		this.activeFootnoteEdit = footnoteId;
	}

	public isFootnoteBeingEdited(): boolean {
		return this.activeFootnoteEdit !== null;
	}

	public setCurrentlyEditingMargin(margin: HTMLElement | null) {
		this.currentlyEditingMargin = margin;
	}

	public getCurrentlyEditingMargin(): HTMLElement | null {
		return this.currentlyEditingMargin;
	}

	public forceReadingModeRefreshPublic() {
		this.forceReadingModeRefresh();
	}

	public refreshCachedSourceContentPublic() {
		this.refreshCachedSourceContent();
	}

	public injectStylesPublic() {
		this.injectStyles();
	}

	public get settingsVersion(): number {
		return this._settingsVersion;
	}

	/**
	 * Snapshot of the state `injectPrintSidenotes` (src/print-export.ts)
	 * needs, built fresh on every post-processor pass.
	 */
	private printExportContext(): PrintExportContext {
		return {
			app: this.app,
			settings: this.settings,
			fileContentCache: this.fileContentCache,
			cachedSourceContent: this.cachedSourceContent,
			getMarkdownView: () => this.getMarkdownView(),
		};
	}

	/**
	 * Determine whether an element or footnote ID represents a margin note
	 * (unnumbered sidenote).
	 * - HTML format: <span class="sidenote margin-note">
	 * - Footnote format: [^mn-...]
	 */
	public isMarginNote(elOrId: HTMLElement | string): boolean {
		return isMarginNote(elOrId);
	}

	/**
	 * Which margin a sidenote actually renders in: its own override if it has
	 * one (HTML "right"/"left" class, or a footnote -r/-l ID suffix), else
	 * the document-wide "Sidenote position" setting.
	 */
	public getSidenoteSide(elOrId: HTMLElement | string): SidenoteSide {
		return (
			getSidenoteSideOverride(elOrId) ?? this.settings.sidenotePosition
		);
	}

	public setupMarginNotePopupPublic(
		wrapper: HTMLElement,
		margin: HTMLElement,
		contentText: string,
		editable: boolean = false,
		footnoteId?: string,
	) {
		this.setupMarginNotePopup(
			wrapper,
			margin,
			contentText,
			editable,
			footnoteId,
		);
	}

	private cleanupView(view: MarkdownView | null) {
		if (!view) return;

		const cmRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (cmRoot) {
			cmRoot
				.querySelectorAll("span.sidenote-number")
				.forEach((wrapper) => {
					const parent = wrapper.parentNode;
					if (!parent) return;
					// Move the original span.sidenote back before the wrapper
					const sidenote = wrapper.querySelector("span.sidenote");
					if (sidenote) {
						parent.insertBefore(sidenote, wrapper);
					}
					// Now safe to remove the wrapper (only contains the margin)
					wrapper.remove();
				});
			cmRoot
				.querySelectorAll("small.sidenote-margin")
				.forEach((n) => n.remove());
			cmRoot.style.removeProperty("--editor-width");
			cmRoot.style.removeProperty("--sidenote-scale");
			cmRoot.dataset.sidenoteMode = "";
			cmRoot.dataset.hasSidenotes = "";
			cmRoot.dataset.sidenotePosition = "";
			cmRoot.dataset.sidenoteHasOpposite = "";
		}

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			readingRoot
				.querySelectorAll("span.sidenote-number")
				.forEach((n) => n.remove());
			readingRoot
				.querySelectorAll("small.sidenote-margin")
				.forEach((n) => n.remove());
			readingRoot.style.removeProperty("--editor-width");
			readingRoot.style.removeProperty("--sidenote-scale");
			readingRoot.dataset.sidenoteMode = "";
			readingRoot.dataset.hasSidenotes = "";
			readingRoot.dataset.sidenotePosition = "";
			readingRoot.dataset.sidenoteHasOpposite = "";

			// Clear processed flags
			readingRoot
				.querySelectorAll("[data-sidenotes-processed]")
				.forEach((el) => {
					delete (el as HTMLElement).dataset.sidenotesProcessed;
				});
		}

		// Clean up margin note popups appended to document.body
		document
			.querySelectorAll(".margin-note-popup")
			.forEach((el) => el.remove());
	}

	async loadSettings() {
		try {
			const data = (await this.loadData()) as
				| Partial<SidenoteSettings>
				| undefined;
			this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		} catch (error) {
			console.error("Sidenote plugin: Failed to load settings", error);
			this.settings = Object.assign({}, DEFAULT_SETTINGS);
		}
	}

	async saveSettings() {
		try {
			// Validate settings before saving
			const s = this.settings;

			// Ensure min <= max for widths
			if (s.minSidenoteWidth > s.maxSidenoteWidth) {
				s.minSidenoteWidth = s.maxSidenoteWidth;
			}

			// Ensure breakpoints are in order
			if (s.hideBelow >= s.compactBelow) {
				s.compactBelow = s.hideBelow + 100;
			}
			if (s.compactBelow >= s.fullAbove) {
				s.fullAbove = s.compactBelow + 100;
			}

			// Clamp values to reasonable ranges
			s.collisionSpacing = Math.max(0, Math.min(50, s.collisionSpacing));
			s.fontSize = Math.max(50, Math.min(150, s.fontSize));
			s.fontSizeCompact = Math.max(50, Math.min(150, s.fontSizeCompact));
			s.lineHeight = Math.max(1, Math.min(3, s.lineHeight));
			s.pageOffsetFactor = Math.max(0, Math.min(1, s.pageOffsetFactor));

			await this.saveData(this.settings);

			// Bump the settings version so the CM6 ViewPlugin rebuilds
			this._settingsVersion++;

			// Apply new CSS variables
			this.injectStyles();

			// Reset numbering state
			this.resetRegistry();
			this.invalidateLayoutCache();
			this.scanDocumentForSidenotes();

			// --- Reading mode: full teardown + rebuild ---
			this.cleanupReadingMode();
			this.needsReadingModeRefresh = true;
			this.forceReadingModeRefresh();

			// --- Editing mode: let CM6 handle it ---
			// Don't manually remove DOM inside .cm-content — that corrupts
			// CM6's internal state. Instead, force CM6 to re-render.
			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			const cmEditor = (mdView?.editor as { cm?: EditorView })?.cm;
			if (cmEditor) {
				// requestMeasure triggers a geometry pass, which causes
				// the ViewPlugin's update() to fire and see the bumped
				// settingsVersion, rebuilding all decorations.
				cmEditor.requestMeasure();
			}

			// Re-bind scroll/resize/mutation observers and schedule layout
			this.rebindAndSchedule();
		} catch (error) {
			console.error("Sidenote plugin: Failed to save settings", error);
		}
	}

	/**
	 * Pre-cache the current file's content so it's available
	 * synchronously during PDF export post-processing.
	 */
	private async preCacheFileContent() {
		const view = this.getMarkdownView();
		const file = view?.file ?? this.app.workspace.getActiveFile();
		if (!file) return;

		const content = await this.app.vault.cachedRead(file);
		if (content) {
			this.fileContentCache.set(file.path, content);
		}
	}

	private getMarkdownView(): MarkdownView | null {
		// Try active view first
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active;

		// Fallback: find any visible markdown leaf
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			if (leaf.view instanceof MarkdownView) {
				return leaf.view;
			}
		}
		return null;
	}

	/**
	 * Clean up sidenote markup from reading mode only.
	 * Never manually remove DOM inside CM6 .cm-content — that
	 * corrupts CM6's internal state and causes sidenotes to vanish.
	 */
	private cleanupReadingMode() {
		const view = this.getMarkdownView();
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			this.removeAllSidenoteMarkupFromReadingMode(readingRoot);
			readingRoot.dataset.sidenoteMode = "";
			readingRoot.dataset.hasSidenotes = "";
		}
	}

	/**
	 * Force a refresh of reading mode sidenotes.
	 */
	private forceReadingModeRefresh() {
		this.needsReadingModeRefresh = true;
		const view = this.getMarkdownView();
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (!readingRoot) return;

		// Clear any processed flags
		readingRoot
			.querySelectorAll("[data-sidenotes-processed]")
			.forEach((el) => {
				delete (el as HTMLElement).dataset.sidenotesProcessed;
			});

		// Reset the mode so it gets recalculated
		readingRoot.dataset.sidenoteMode = "";
		readingRoot.style.removeProperty("--sidenote-scale");

		// Schedule reprocessing with a delay to ensure cleanup is complete
		window.setTimeout(() => {
			const useFootnotes =
				this.settings.sidenoteFormat === "footnote" ||
				this.settings.sidenoteFormat === "footnote-edit";

			if (useFootnotes) {
				// Wait until footnote defs are present, then process.
				this.scheduleFootnoteProcessing();
				return;
			}

			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => {
					this.processReadingModeSidenotes(readingRoot);
				});
			});
		}, SidenotePlugin.FOOTNOTE_RENDER_DELAY);
	}

	/**
	 * Install a single delegated click handler on the reading-mode root.
	 * This survives DOM virtualization because it lives on the persistent
	 * ancestor, not on individual margin elements that Obsidian may destroy.
	 */
	private ensureReadingModeDelegation(readingRoot: HTMLElement) {
		// Already installed on this element
		if (this.readingModeDelegateHandler) return;

		const handler = (ev: MouseEvent) => {
			if (!this.settings.editInReadingMode) return;

			const target = ev.target as HTMLElement | null;
			if (!target) return;

			const margin = target.closest<HTMLElement>("small.sidenote-margin");
			if (!margin) return;

			// Skip popup-mode margin notes — let the icon's own handler deal with it
			if (margin.classList.contains("popup-mode-margin")) {
				return;
			}

			// Don't interfere with an editor that's already open
			if (margin.dataset.editing === "true") {
				ev.stopPropagation();
				return;
			}

			// Don't intercept clicks on links inside the margin
			if (target.closest("a")) return;

			ev.preventDefault();
			ev.stopPropagation();

			const sidenoteType = margin.dataset.sidenoteType;
			if (sidenoteType === "footnote") {
				const footnoteId = margin.dataset.footnoteId;
				if (!footnoteId) return;

				// The margin already displays the correct text (it was
				// re-rendered after the last commit). Read from it
				// directly to avoid any stale-cache issues with
				// vault.process() async timing.
				const displayedText = this.normalizeText(margin.textContent ?? "");

				// Strip the number prefix if the margin's ::before
				// content is included in textContent (it isn't for
				// pseudo-elements, but guard against it)
				const footnoteText =
					displayedText || this.getFootnoteSourceText(footnoteId) || "";
				if (!footnoteText) return;

				this.startReadingModeFootnoteEdit(
					margin,
					footnoteId,
					footnoteText,
				);
			} else if (sidenoteType === "html") {
				const rawText = margin.dataset.sidenoteRawText ?? "";

				if (!rawText) return;

				// Find this exact text in the source to confirm it exists
				const view2 = this.app.workspace.getActiveViewOfType(MarkdownView);
				const content =
					view2?.editor?.getValue() ||
					(view2 as { data?: string })?.data ||
					this.cachedSourceContent ||
					"";
				if (!content) return;

				// Search for a span containing this exact raw text
				const regex = SIDENOTE_SPAN_REGEX();
				let m: RegExpExecArray | null;
				while ((m = regex.exec(content)) !== null) {
					if (m[1] === rawText) {
						this.startReadingModeHtmlEdit(margin, rawText);
						break;
					}
				}
			}
		};

		readingRoot.addEventListener("click", handler, true);
		this.readingModeDelegateHandler = handler;

		// Store a cleanup that removes the handler if the view is torn down
		this.cleanups.push(() => {
			readingRoot.removeEventListener("click", handler, true);
			this.readingModeDelegateHandler = null;
		});
	}

	/**
	 * Trigger editing mode for a newly inserted footnote sidenote.
	 */
	private triggerPendingFootnoteEdit() {
		if (!this.pendingFootnoteEdit) return;

		const footnoteId = this.pendingFootnoteEdit;
		this.pendingFootnoteEdit = null;

		const cmRoot = this.cmRoot;
		if (!cmRoot) return;

		// Find the wrapper for this footnote by its ID
		const wrapper = cmRoot.querySelector<HTMLElement>(
			`span.sidenote-number[data-footnote-id="${footnoteId}"]`,
		);

		if (!wrapper) {
			// Widget might not be rendered yet, try again (with limit)
			if (
				this.pendingFootnoteEditRetries <
				SidenotePlugin.MAX_FOOTNOTE_EDIT_RETRIES
			) {
				this.pendingFootnoteEdit = footnoteId;
				this.pendingFootnoteEditRetries++;
				window.setTimeout(() => {
					this.triggerPendingFootnoteEdit();
				}, SidenotePlugin.FOOTNOTE_RENDER_DELAY);
			} else {
				// Give up after max retries
				this.pendingFootnoteEditRetries = 0;
			}
			return;
		}

		// Find the margin inside the wrapper
		const margin = wrapper.querySelector<HTMLElement>(
			"small.sidenote-margin",
		);
		if (!margin) return;

		// Tell the CM6 editor (mounted by FootnoteSidenoteWidget.startMarginEdit)
		// to select all its text as soon as it opens, so the placeholder
		// content is easy to type over.
		margin.dataset.selectAllOnOpen = "true";

		// Simulate a click to start editing
		margin.click();
	}

	// ==================== Performance Utilities ====================

	private cancelAllTimers() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		if (this.collisionRafId !== null) {
			cancelAnimationFrame(this.collisionRafId);
			this.collisionRafId = null;
		}
		if (this.scrollDebounceTimer !== null) {
			window.clearTimeout(this.scrollDebounceTimer);
			this.scrollDebounceTimer = null;
		}
		if (this.mutationDebounceTimer !== null) {
			window.clearTimeout(this.mutationDebounceTimer);
			this.mutationDebounceTimer = null;
		}
	}

	private invalidateLayoutCache() {
		this.lastSidenoteCount = 0;
		// this.lastCollisionHash = "";
	}

	private scheduleLayoutDebounced(
		delay: number = SidenotePlugin.MUTATION_DEBOUNCE,
	) {
		if (this.mutationDebounceTimer !== null) {
			window.clearTimeout(this.mutationDebounceTimer);
		}
		this.mutationDebounceTimer = window.setTimeout(() => {
			this.mutationDebounceTimer = null;
			this.scheduleLayout();
		}, delay);
	}

	private scheduleLayoutThrottled(
		minInterval: number = SidenotePlugin.RESIZE_DEBOUNCE,
	) {
		const now = Date.now();
		if (now - this.resizeThrottleTime >= minInterval) {
			this.resizeThrottleTime = now;
			this.scheduleLayout();
		}
	}

	private scheduleReadingModeLayoutThrottled(
		minInterval: number = SidenotePlugin.RESIZE_DEBOUNCE,
	) {
		const now = Date.now();

		// Clear any pending trailing call
		if (this.readingModeResizeTrailingTimer !== null) {
			window.clearTimeout(this.readingModeResizeTrailingTimer);
		}

		if (now - this.readingModeResizeThrottleTime >= minInterval) {
			this.readingModeResizeThrottleTime = now;
			this.scheduleReadingModeLayout();
		}

		// Always schedule a trailing call to catch the final state
		this.readingModeResizeTrailingTimer = window.setTimeout(() => {
			this.readingModeResizeTrailingTimer = null;
			this.readingModeResizeThrottleTime = Date.now();
			this.scheduleReadingModeLayout();
		}, minInterval);
	}

	private setupVisibilityObserver() {
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
					this.scheduleCollisionUpdate();
				}
			},
			{
				rootMargin: "100px 0px",
				threshold: 0,
			},
		);
	}

	/**
	 * Watch margins for height changes.
	 *
	 * Collision avoidance is a one-shot measurement: once a pass has run, a
	 * margin that *later* changes height (image or embed finishing loading, a
	 * webfont swapping in, the inline editor opening/closing, a section
	 * re-flowing after virtualisation) silently invalidates every shift below
	 * it and nothing re-measures. That is what leaves sidenotes stacked on top
	 * of each other until an unrelated event happens to trigger a layout.
	 *
	 * resolveCollisions only writes `transform`, which cannot change a margin's
	 * own box size, so this cannot feed back into itself.
	 */
	private setupMarginResizeObserver() {
		this.marginResizeObserver = new ResizeObserver(() => {
			this.scheduleCollisionUpdate();
		});
	}

	private observeSidenoteVisibility(margin: HTMLElement) {
		if (this.visibilityObserver) {
			this.visibilityObserver.observe(margin);
		}
		if (this.marginResizeObserver) {
			this.marginResizeObserver.observe(margin);
		}
	}

	private unobserveSidenoteVisibility(margin: HTMLElement) {
		if (this.visibilityObserver) {
			this.visibilityObserver.unobserve(margin);
			this.visibleSidenotes.delete(margin);
		}
		if (this.marginResizeObserver) {
			this.marginResizeObserver.unobserve(margin);
		}
	}

	// ==================== Style Injection ====================

	private injectStyles() {
		const s = this.settings;
		const root = document.documentElement;

		// Layout variables
		root.style.setProperty("--sn-base-width", `${s.minSidenoteWidth}rem`);
		root.style.setProperty(
			"--sn-max-extra",
			`${s.maxSidenoteWidth - s.minSidenoteWidth}rem`,
		);
		root.style.setProperty("--sn-gap", `${s.sidenoteGap}rem`);
		root.style.setProperty("--sn-gap2", `${s.sidenoteGap2}rem`);
		root.style.setProperty(
			"--sn-page-offset-factor",
			`${s.pageOffsetFactor}`,
		);

		// Compact mode
		root.style.setProperty(
			"--sn-base-width-compact",
			`${Math.max(s.minSidenoteWidth - 2, 6)}rem`,
		);
		root.style.setProperty(
			"--sn-max-extra-compact",
			`${Math.max((s.maxSidenoteWidth - s.minSidenoteWidth) / 2, 2)}rem`,
		);
		root.style.setProperty(
			"--sn-gap-compact",
			`${Math.max(s.sidenoteGap - 1, 0.5)}rem`,
		);
		root.style.setProperty(
			"--sn-gap2-compact",
			`${Math.max(s.sidenoteGap2 - 0.5, 0.25)}rem`,
		);

		// Full mode
		root.style.setProperty(
			"--sn-base-width-full",
			`${s.maxSidenoteWidth}rem`,
		);
		root.style.setProperty("--sn-gap-full", `${s.sidenoteGap + 1}rem`);
		root.style.setProperty("--sn-gap2-full", `${s.sidenoteGap2 + 0.5}rem`);

		// Typography.
		//
		// Resolve the size against Obsidian's base text size rather than
		// emitting a bare percentage. A percentage font-size resolves against
		// the *parent's* font size, so a sidenote anchored in an <h1> rendered
		// at 80% of the heading — much larger than one in body text. The var()
		// is substituted at the point of use, so it picks up --font-text-size
		// from the note's own cascade (themes and the Appearance setting still
		// apply); the px fallback only matters if that variable is missing.
		const baseFontSize = "var(--font-text-size, 16px)";
		root.style.setProperty(
			"--sn-font-size",
			`calc(${baseFontSize} * ${s.fontSize / 100})`,
		);
		root.style.setProperty(
			"--sn-font-size-compact",
			`calc(${baseFontSize} * ${s.fontSizeCompact / 100})`,
		);

		// Text Color
		root.style.setProperty(
			"--sn-text-color",
			s.textColor || "var(--text-normal)",
		);

		// Text color on hover
		if (s.hoverColor) {
			root.style.setProperty("--sn-hover-color", s.hoverColor);
		} else {
			root.style.removeProperty("--sn-hover-color");
		}

		// Line Height
		root.style.setProperty("--sn-line-height", `${s.lineHeight}`);
		root.style.setProperty(
			"--sn-line-height-compact",
			`${Math.max(s.lineHeight - 0.1, 1.1)}`,
		);

		// Text alignment
		const defaultAlignment =
			s.sidenotePosition === "left" ? "right" : "left";
		// Mirrored alignment for sidenotes overridden onto the opposite margin —
		// same explicit choice (justify/left/right) if the user set one, else
		// the alignment that faces the body text from the *other* side.
		const oppositeAlignment =
			s.sidenotePosition === "left" ? "left" : "right";
		const resolveAlignment = (auto: string) =>
			s.textAlignment === "justify"
				? "justify"
				: s.textAlignment === "left" || s.textAlignment === "right"
					? s.textAlignment
					: auto;
		const textAlign = resolveAlignment(defaultAlignment);
		root.style.setProperty("--sn-text-align", textAlign);
		root.style.setProperty(
			"--sn-text-align-opposite",
			resolveAlignment(oppositeAlignment),
		);

		// Number color
		if (s.numberColor) {
			root.style.setProperty("--sn-number-color", s.numberColor);
		} else {
			root.style.removeProperty("--sn-number-color");
		}

		// Transitions
		root.style.setProperty(
			"--sn-transition",
			s.enableTransitions
				? "width 0.15s ease-out, left 0.15s ease-out, right 0.15s ease-out, opacity 0.15s ease-out"
				: "none",
		);

		// Print margin changes
		this.injectPrintPageStyle();

		// Data attributes for CSS selectors
		root.dataset.snBadgeStyle = s.numberBadgeStyle;
		root.dataset.snShowNumbers = s.showSidenoteNumbers ? "true" : "false";
		root.dataset.snFormat = s.sidenoteFormat;
		root.dataset.snHideFootnotes = s.hideFootnotes ? "true" : "false";
		root.dataset.snHideFootnoteNumbers = s.hideFootnoteNumbers
			? "true"
			: "false";
		root.dataset.snEditInReadingMode = s.editInReadingMode
			? "true"
			: "false";

		// Margin note specific styles
		root.style.setProperty(
			"--sn-mn-popup-scale",
			`${s.popupIconScaleFactor}em`,
		);
		root.style.setProperty(
			"--sn-mn-marker-scale",
			`${s.marginNoteScaleFactor}em`,
		);
	}

	/**
	 * Calculate and apply sidenote positioning based on anchor mode and gaps.
	 *
	 * For LEFT sidenotes:
	 * - TEXT ANCHOR: Sidenote's right edge is gap1 away from text. As editor widens,
	 *   gap between sidenote and editor edge increases.
	 * - EDGE ANCHOR: Sidenote's left edge is gap2 away from editor edge. As editor widens,
	 *   gap between sidenote and text increases.
	 *
	 * Both modes respect both gap constraints as minimums.
	 */
	private updateSidenotePositioning(
		root: HTMLElement,
		isReadingMode: boolean,
	) {
		const s = this.settings;
		const position = s.sidenotePosition;
		const anchorMode = s.sidenoteAnchor;

		// Whenever a per-sidenote override actually places a note on the
		// non-default margin, reserve page-offset space there too (see the
		// matching CSS rules gated on [data-sidenote-has-opposite]) — without
		// it, the override side has no room at all and edge-anchored notes
		// collapse against (or past) the pane's real edge instead of
		// respecting sidenoteGap/sidenoteGap2.
		const oppositeSide: SidenoteSide =
			position === "left" ? "right" : "left";
		const hasOppositeOverride =
			root.querySelector(
				`.sidenote-margin[data-sidenote-side="${oppositeSide}"]`,
			) !== null;
		root.dataset.sidenoteHasOpposite = hasOppositeOverride
			? "true"
			: "false";

		// Get root element rect
		const rootRect = root.getBoundingClientRect();

		// console.log("[Sidenotes] updateSidenotePositioning:", {
		// 	rootWidth: rootRect.width,
		// 	isReadingMode,
		// 	isConnected: root.isConnected,
		// });

		// Get rem to px conversion
		const remToPx =
			parseFloat(getComputedStyle(document.documentElement).fontSize) ||
			16;
		// Base gaps (minimums)
		const baseGap1 = s.sidenoteGap * remToPx; // gap between sidenote and text
		const baseGap2 = s.sidenoteGap2 * remToPx; // gap between sidenote and edge

		// Scale gaps proportionally as editor grows.
		// Use the pageOffsetFactor setting to control growth rate.
		// At hideBelow width, gaps are at their minimum.
		// As width increases, gaps grow by a fraction of the extra available space.
		const editorWidth = rootRect.width;
		const growthFactor = s.sidenoteGapDrift; // 0 = no growth, 1 = maximum growth
		const extraSpace = Math.max(0, editorWidth - s.hideBelow);
		const gapGrowth = extraSpace * growthFactor * 0.25; // subtle growth

		const gap1 = baseGap1 + gapGrowth;
		const gap2 = baseGap2 + gapGrowth;

		// Find a representative line/paragraph to measure the text column edge.
		// In reading mode, Obsidian virtualises content so the first <p> may
		// have zero size or be nested inside a blockquote/list.  Walk the
		// sizer's direct child <div>s and pick the first one that contains a
		// visible block-level element at the top level of the content flow.
		let refLine: HTMLElement | null = null;
		if (isReadingMode) {
			const sizer = root.querySelector<HTMLElement>(
				".markdown-preview-sizer",
			);
			if (sizer) {
				const sections =
					sizer.querySelectorAll<HTMLElement>(":scope > div");
				for (const section of Array.from(sections)) {
					if (section.offsetHeight === 0) continue;
					const candidate = section.querySelector<HTMLElement>(
						":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6",
					);
					if (candidate && candidate.offsetHeight > 0) {
						refLine = candidate;
						break;
					}
				}
			}
			if (!refLine) {
				refLine = root.querySelector<HTMLElement>(
					".markdown-preview-sizer",
				);
			}
		} else {
			refLine = this.findStableCmRefLine(root);
		}

		if (!refLine) return;

		const refRect = refLine.getBoundingClientRect();

		// Get sidenote width from an existing margin element, or fall back to calculation
		const sidenoteWidth = this.getSidenoteWidthPx(root);

		// Compute both sides unconditionally so a per-sidenote override can
		// place an individual note in the margin opposite the document-wide
		// "Sidenote position" setting.

		// --- LEFT ---
		// Available space between editor left edge and the text (refLine left edge)
		const textLeft = isReadingMode
			? (this.getReadingTextLeft(root) ?? refRect.left)
			: (this.getEditorTextEdges(root)?.left ?? refRect.left);

		let cssLeft: number;
		if (anchorMode === "text") {
			// TEXT ANCHOR MODE:
			// Position sidenote so its right edge is exactly gap1 from text (if in left margin)
			cssLeft = -(gap1 + sidenoteWidth);
		} else {
			// EDGE ANCHOR MODE (LEFT):
			// Use the real editor edge (scroller/view), not rootRect.left (which may already be padded).
			const editorEdgeLeft = (() => {
				if (isReadingMode) return root.getBoundingClientRect().left;
				const scroller = root.querySelector<HTMLElement>(".cm-scroller");
				return (scroller ?? root).getBoundingClientRect().left;
			})();

			// Place sidenote so its LEFT edge is gap2 from the editor edge
			// cssLeft is relative to the text column edge (textLeft)
			cssLeft = editorEdgeLeft + gap2 - textLeft;

			// Keep it from intruding into the text column (best-effort safety).
			// If cssLeft is too large (not negative enough), the sidenote overlaps text.
			const maxCssLeft = -(gap1 + sidenoteWidth);
			if (cssLeft > maxCssLeft) cssLeft = maxCssLeft;
		}

		// --- RIGHT ---
		// Available space between text (refLine right edge) and editor right edge
		const textEdges = !isReadingMode
			? this.getEditorTextEdges(root)
			: null;
		const textRight = textEdges ? textEdges.right : refRect.right;

		let cssRight: number;
		if (anchorMode === "text") {
			// TEXT ANCHOR MODE:
			// Position sidenote so its left edge is exactly gap1 from text
			// cssRight works inversely: negative moves element to the right
			cssRight = -(gap1 + sidenoteWidth);
		} else {
			const editorEdgeRight = (() => {
				if (isReadingMode) return root.getBoundingClientRect().right;

				const scroller = root.querySelector<HTMLElement>(".cm-scroller");
				return (scroller ?? root).getBoundingClientRect().right;
			})();

			cssRight = editorEdgeRight - gap2 - textRight;

			const maxCssRight = -(gap1 + sidenoteWidth);
			if (cssRight > maxCssRight) cssRight = maxCssRight;
		}

		root.style.setProperty("--sidenote-offset-left", `${cssLeft}px`);
		root.style.setProperty("--sidenote-offset-right", `${cssRight}px`);
		root.style.setProperty(
			"--sidenote-offset",
			`${position === "left" ? cssLeft : cssRight}px`,
		);
	}

	private measureCssLengthPx(
		host: HTMLElement,
		cssLengthExpr: string,
	): number {
		const probe = createDiv();
		probe.classList.add("sidenote-measure-probe");
		probe.style.width = cssLengthExpr;
		host.appendChild(probe);
		const w = probe.getBoundingClientRect().width;
		probe.remove();
		return w;
	}

	private getSidenoteWidthPx(root: HTMLElement): number {
		// Root here should be the element that has --sidenote-width in scope
		const cs = getComputedStyle(root);
		const expr = cs.getPropertyValue("--sidenote-width").trim();
		if (expr) return this.measureCssLengthPx(root, expr);

		// fallback
		const remToPx =
			parseFloat(getComputedStyle(document.documentElement).fontSize) ||
			16;
		return this.settings.minSidenoteWidth * remToPx;
	}

	private getReadingTextLeft(root: HTMLElement): number | null {
		const sizer = root.querySelector<HTMLElement>(
			".markdown-preview-sizer",
		);
		if (!sizer) return null;
		const r = sizer.getBoundingClientRect();
		const cs = getComputedStyle(sizer);
		const pl = parseFloat(cs.paddingLeft) || 0;
		return r.left + pl;
	}

	private getEditorTextEdges(
		root: HTMLElement,
	): { left: number; right: number } | null {
		// The page offset for sidenotes is applied to the scroller, so measure from it.
		const scroller = root.querySelector<HTMLElement>(".cm-scroller");
		if (!scroller) return null;

		const r = scroller.getBoundingClientRect();
		const cs = getComputedStyle(scroller);
		const pl = parseFloat(cs.paddingLeft) || 0;
		const pr = parseFloat(cs.paddingRight) || 0;

		return {
			left: r.left + pl,
			right: r.right - pr,
		};
	}

	/**
	 * Helper for updateSidenotePositioning to find a stable reference line
	 * This helps to establish reliable positioning even when the first lines are empty or virtualized.
	 * @param root
	 * @returns
	 */
	private findStableCmRefLine(root: HTMLElement): HTMLElement | null {
		const rootRect = root.getBoundingClientRect();
		const lines = Array.from(
			root.querySelectorAll<HTMLElement>(".cm-line"),
		);

		// Prefer a line that is:
		// - visible (height > 0)
		// - not collapsed to left edge (left significantly inside the root)
		// - has non-trivial width
		for (const el of lines) {
			if (!el.isConnected) continue;
			const r = el.getBoundingClientRect();
			if (r.height < 8) continue;
			if (r.width < 40) continue;

			const inset = r.left - rootRect.left;

			// Heuristic: text column is usually inset by padding/gutter; reject 0–2px.
			if (inset <= 2) continue;

			return el;
		}

		// Fallback: first line with height
		for (const el of lines) {
			const r = el.getBoundingClientRect();
			if (r.height > 0) return el;
		}

		return null;
	}

	/**
	 * Correct per-wrapper --sidenote-offset for sidenotes inside indented
	 * containers (li, blockquote, callout).  Called AFTER updateSidenotePositioning
	 * so that the global --sidenote-offset on the root is already set.
	 *
	 * Uses the SAME refLine search logic as updateSidenotePositioning to
	 * guarantee consistency. The global offset positions sidenotes relative
	 * to refLine. For wrappers inside an indented parent, position:absolute
	 * resolves against that parent instead, so we compute a per-wrapper
	 * offset that compensates for the difference.
	 */
	private correctIndentedSidenotePositions(root: HTMLElement) {
		const position = this.settings.sidenotePosition;

		// Read the global offsets that updateSidenotePositioning just set
		const globalOffset =
			parseFloat(root.style.getPropertyValue("--sidenote-offset")) || 0;
		const globalOffsetLeft =
			parseFloat(root.style.getPropertyValue("--sidenote-offset-left")) ||
			0;
		const globalOffsetRight =
			parseFloat(root.style.getPropertyValue("--sidenote-offset-right")) ||
			0;

		// Find the SAME reference element updateSidenotePositioning used
		const sizer = root.querySelector<HTMLElement>(
			".markdown-preview-sizer",
		);
		if (!sizer) return;

		let refEl: HTMLElement | null = null;
		const sections = sizer.querySelectorAll<HTMLElement>(":scope > div");
		for (const section of Array.from(sections)) {
			if (section.offsetHeight === 0) continue;
			const candidate = section.querySelector<HTMLElement>(
				":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6",
			);
			if (candidate && candidate.offsetHeight > 0) {
				refEl = candidate;
				break;
			}
		}
		if (!refEl) return;

		const refRect = refEl.getBoundingClientRect();

		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
			const indentedParent = wrapper.closest<HTMLElement>(
				"li, blockquote, .callout-content",
			);

			if (!indentedParent) {
				// Not indented — inherit the global offsets
				wrapper.style.removeProperty("--sidenote-offset");
				wrapper.style.removeProperty("--sidenote-offset-left");
				wrapper.style.removeProperty("--sidenote-offset-right");
				continue;
			}

			const parentRect = indentedParent.getBoundingClientRect();

			// Left-margin offset is relative to refEl's left edge; this wrapper
			// resolves position:absolute against indentedParent, so shift by how
			// much further right the parent is vs refEl.
			const shiftLeft = parentRect.left - refRect.left;
			// Right-margin offset is relative to refEl's right edge; shift by how
			// much further left the parent's right edge is vs refEl.
			const shiftRight = refRect.right - parentRect.right;

			wrapper.style.setProperty(
				"--sidenote-offset-left",
				`${globalOffsetLeft - shiftLeft}px`,
			);
			wrapper.style.setProperty(
				"--sidenote-offset-right",
				`${globalOffsetRight - shiftRight}px`,
			);
			wrapper.style.setProperty(
				"--sidenote-offset",
				`${globalOffset - (position === "left" ? shiftLeft : shiftRight)}px`,
			);
		}
	}

	/**
	 * Find an HTML sidenote in the source by its text content.
	 * Returns the match details or null if not found.
	 */
	private findHtmlSidenoteInSource(sidenoteText: string): {
		text: string;
		fullMatch: string;
		index: number;
		openingTag: string;
	} | null {
		const view = this.getMarkdownView();
		const content =
			view?.editor?.getValue() ||
			(view as { data?: string })?.data ||
			this.cachedSourceContent ||
			"";
		if (!content) return null;

		const regex = SIDENOTE_SPAN_REGEX();
		let match: RegExpExecArray | null;

		// Try exact match first
		while ((match = regex.exec(content)) !== null) {
			if ((match[1] ?? "") === sidenoteText) {
				return {
					text: match[1] ?? "",
					fullMatch: match[0],
					index: match.index,
					openingTag: match[0].substring(0, match[0].indexOf(">") + 1),
				};
			}
		}

		// Fallback: try normalized match
		const normalized = this.normalizeText(sidenoteText);
		const regex2 = SIDENOTE_SPAN_REGEX();
		while ((match = regex2.exec(content)) !== null) {
			if (this.normalizeText(match[1] ?? "") === normalized) {
				return {
					text: match[1] ?? "",
					fullMatch: match[0],
					index: match.index,
					openingTag: match[0].substring(0, match[0].indexOf(">") + 1),
				};
			}
		}
		return null;
	}

	// ==================== Number Formatting ====================

	private formatNumber(num: number): string {
		return formatNumber(num, this.settings.numberStyle);
	}

	// ==================== Reading Mode Processing ====================

	private processReadingModeSidenotes(element: HTMLElement) {
		const view = this.getMarkdownView();
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (!readingRoot) return;

		// Skip full reprocessing during the post-edit cooldown.
		// After a reading-mode edit, the margin was already re-rendered
		// with the correct text. Obsidian's async DOM re-render fires
		// the MutationObserver, but source caches may still be stale.
		// Let the cooldown expire before allowing a full rebuild.
		if (this.postEditCooldown !== null) {
			return;
		}

		// Ensure the delegated click handler is installed (survives virtualization)
		this.ensureReadingModeDelegation(readingRoot);

		// Check if there are footnote refs or sidenote spans not yet wrapped
		const unwrappedFootnotes = readingRoot.querySelectorAll(
			"sup.footnote-ref:not(.sidenote-number sup), sup[id^='fnref-']:not(.sidenote-number sup), sup[data-footnote-id]:not(.sidenote-number sup)",
		);
		const unwrappedSpans = readingRoot.querySelectorAll(
			"span.sidenote:not(.sidenote-number span.sidenote)",
		);
		const hasUnwrapped =
			unwrappedFootnotes.length > 0 || unwrappedSpans.length > 0;

		const hasAnyMargins =
			readingRoot.querySelector("small.sidenote-margin") !== null;

		// If nothing new to wrap and no full refresh needed, still recompute positioning.
		// This is required when settings like sidenoteAnchor / sidenotePosition change.
		if (!this.needsReadingModeRefresh && !hasUnwrapped) {
			if (hasAnyMargins) {
				window.requestAnimationFrame(() => {
					if (!readingRoot.isConnected) return;

					// Force reflow so measurements are accurate
					void readingRoot.offsetHeight;

					// Re-apply global offset based on current settings (text vs edge)
					this.updateSidenotePositioning(readingRoot, true);

					// Re-apply per-wrapper corrections (li/blockquote/callout)
					this.correctIndentedSidenotePositions(readingRoot);

					// Optional but usually good: re-resolve collisions
					const allMargins = Array.from(
						readingRoot.querySelectorAll<HTMLElement>(
							"small.sidenote-margin",
						),
					).filter((m) => m.isConnected);

					resolveCollisionsBySide(
						allMargins,
						this.settings.collisionSpacing,
						this.settings.sidenotePosition,
					);
				});
			}
			return;
		}

		const isFullRefresh = this.needsReadingModeRefresh;

		const rect = readingRoot.getBoundingClientRect();
		const width = rect.width;

		readingRoot.style.setProperty("--editor-width", `${width}px`);

		const mode = this.calculateMode(width);
		readingRoot.dataset.sidenoteMode = mode;
		readingRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
		readingRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

		const scaleFactor = this.calculateScaleFactor(width);
		readingRoot.style.setProperty(
			"--sidenote-scale",
			scaleFactor.toFixed(3),
		);

		if (mode === "hidden") {
			return;
		}

		// Only do full teardown on explicit refresh (file change, settings change).
		// For incremental processing (new sections scrolled into view), keep
		// existing sidenotes and only wrap the new unwrapped refs.
		if (isFullRefresh) {
			this.removeAllSidenoteMarkupFromReadingMode(readingRoot);
		}

		// Collect items based on the sidenoteFormat setting
		// Note: footnoteHtml is optional and only used for footnotes
		const allItems: {
			el: HTMLElement;
			rect: DOMRect;
			type: "sidenote" | "footnote";
			text: string;
			rawText?: string;
			footnoteId?: string;
			footnoteHtml?: HTMLElement;
		}[] = [];

		// Determine what to collect
		const useHtmlSidenotes = this.settings.sidenoteFormat === "html";
		const useFootnotes =
			this.settings.sidenoteFormat === "footnote" ||
			this.settings.sidenoteFormat === "footnote-edit";

		// Build list of raw source texts for HTML sidenotes
		const htmlSidenoteRawTexts: string[] = [];
		if (useHtmlSidenotes) {
			const view2 = this.app.workspace.getActiveViewOfType(MarkdownView);
			const sourceContent =
				view2?.editor?.getValue() ||
				(view2 as { data?: string })?.data ||
				this.cachedSourceContent ||
				"";
			if (sourceContent) {
				const regex = SIDENOTE_SPAN_REGEX();
				let m: RegExpExecArray | null;
				while ((m = regex.exec(sourceContent)) !== null) {
					htmlSidenoteRawTexts.push(m[1] ?? "");
				}
			}
		}

		if (useHtmlSidenotes) {
			const spans = Array.from(
				readingRoot.querySelectorAll<HTMLElement>("span.sidenote"),
			).filter(
				(span) =>
					!span.parentElement?.classList.contains("sidenote-number"),
			);

			let rawIdx = 0;
			for (const el of spans) {
				allItems.push({
					el,
					rect: el.getBoundingClientRect(),
					type: "sidenote",
					text: el.textContent ?? "",
					rawText: htmlSidenoteRawTexts[rawIdx] ?? el.textContent ?? "",
				});
				rawIdx++;
			}
		}

		const sourceRefOrder: string[] = [];

		if (useFootnotes) {
			// Get footnote definitions from SOURCE MARKDOWN, not from rendered HTML.
			// Obsidian uses virtualized rendering — the <section class="footnotes">
			// may not exist in the DOM for long documents where it's off-screen.

			// Try multiple methods to get source content (in order of reliability):
			// 1. view.editor.getValue() — works in editing mode, sometimes in reading mode
			// 2. (view as any).data — Obsidian's cached file content (always available)
			// 3. this.cachedSourceContent — cached from scanDocumentForSidenotes()
			const view2 = this.app.workspace.getActiveViewOfType(MarkdownView);
			let sourceContent =
				view2?.editor?.getValue() ||
				(view2 as { data?: string })?.data ||
				this.cachedSourceContent ||
				"";

			// If still empty, try async cachedRead as last resort
			if (!sourceContent) {
				const file = view2?.file ?? this.app.workspace.getActiveFile();
				if (file) {
					void this.app.vault.cachedRead(file).then((text) => {
						const current =
							this.app.workspace.getActiveViewOfType(MarkdownView);
						if (!current || current.file?.path !== file.path) return;
						// Cache the result so the next call succeeds synchronously
						this.cachedSourceContent = text;
						this.scheduleFootnoteProcessing();
					});
				}
				if (!useHtmlSidenotes) return;
			}

			const definitions = this.parseFootnoteDefinitions(sourceContent);

			// Build a map from rendered order to source ID
			sourceRefOrder.push(...buildSourceRefOrder(sourceContent));
			if (definitions.size === 0) {
				if (!useHtmlSidenotes) return;
			}

			// Find all footnote references in the rendered HTML
			const footnoteSups = readingRoot.querySelectorAll<HTMLElement>(
				// Obsidian preview often uses sup#fnref-* with a.footnote-link
				"sup.footnote-ref, sup[class*='footnote'], sup[id^='fnref-'], sup[data-footnote-id], a.footnote-link",
			);

			const processedBaseIds = new Set<string>();

			for (const sup of Array.from(footnoteSups)) {
				if (sup.closest(".sidenote-number")) continue;
				// Skip elements inside the footnotes section (these are backrefs, not refs)
				if (sup.closest("section.footnotes, .footnotes")) continue;

				// Extract the base footnote ID from the rendered markup
				let baseId = resolveFootnoteBaseId(sup);

				if (!baseId || processedBaseIds.has(baseId)) continue;

				// Map Obsidian's rendered sequential number back to the source footnote ID
				const originalBaseId = baseId;
				const renderedNum = parseInt(baseId, 10);
				if (
					!isNaN(renderedNum) &&
					renderedNum >= 1 &&
					renderedNum <= sourceRefOrder.length
				) {
					const sourceId = sourceRefOrder[renderedNum - 1];
					if (sourceId && definitions.has(sourceId)) {
						baseId = sourceId;
					}
				}

				// Mark both original and remapped IDs as processed
				if (processedBaseIds.has(baseId)) continue;
				processedBaseIds.add(originalBaseId);
				processedBaseIds.add(baseId);

				// Look up definition from SOURCE markdown
				const footnoteText = definitions.get(baseId);
				if (!footnoteText) continue;

				// For footnotes, hide the original [1] link
				const anchor = sup.querySelector("a");
				if (anchor && this.settings.hideFootnoteNumbers) {
					anchor.classList.add("sidenote-fn-link-hidden");
				}

				allItems.push({
					el: sup,
					rect: sup.getBoundingClientRect(),
					type: "footnote",
					text: footnoteText,
					footnoteId: baseId,
					// No footnoteHtml — render from source text instead
				});
			}
		}

		// console.log(
		// 	"[Sidenotes] allItems:",
		// 	allItems.length,
		// 	allItems.map((i) => i.footnoteId),
		// );

		if (allItems.length === 0) {
			readingRoot.dataset.hasSidenotes = "false";
			return;
		}

		this.needsReadingModeRefresh = false;

		readingRoot.dataset.hasSidenotes = "true";

		// Sort by vertical position. Items with valid rects sort by top position;
		// items with zero rects (not yet laid out) sort by their DOM order,
		// which querySelectorAll already preserves.
		allItems.sort((a, b) => a.rect.top - b.rect.top);

		// Start numbering from 1
		let num = 1;

		const marginNotes: HTMLElement[] = [];

		for (const item of allItems) {
			if (this.settings.resetNumberingPerHeading) {
				const heading = this.findPrecedingHeading(item.el);
				if (heading) {
					const headingId = this.getHeadingId(heading);
					if (!this.headingSidenoteNumbers.has(headingId)) {
						this.headingSidenoteNumbers.set(headingId, 1);
					}
					num = this.headingSidenoteNumbers.get(headingId)!;
					this.headingSidenoteNumbers.set(headingId, num + 1);
				}
			}

			// Determine if this is a margin note (unnumbered)
			const isMargin =
				item.type === "sidenote"
					? this.isMarginNote(item.el)
					: item.footnoteId
						? this.isMarginNote(item.footnoteId)
						: false;

			// Per-sidenote margin override (opposite side from the document-wide setting)
			const sideOverride =
				item.type === "sidenote"
					? getSidenoteSideOverride(item.el)
					: item.footnoteId
						? getSidenoteSideOverride(item.footnoteId)
						: null;

			// For footnotes, use the footnote's own ID as the number
			// (so [^3] always displays as "3" regardless of which refs are visible).
			// For HTML sidenotes, use the sequential counter.
			// For margin notes, use empty string (no number).
			let numStr: string;
			if (isMargin) {
				numStr = "";
			} else if (item.footnoteId) {
				numStr = stripSideSuffix(item.footnoteId);
			} else {
				numStr = this.formatNumber(num++);
			}

			const wrapper = createSpan();
			wrapper.className = "sidenote-number";
			const margin = createEl("small");
			margin.className = "sidenote-margin";

			if (isMargin) {
				wrapper.classList.add("margin-note");
				margin.classList.add("margin-note");
			}
			if (sideOverride) {
				wrapper.dataset.sidenoteSide = sideOverride;
				margin.dataset.sidenoteSide = sideOverride;
			}
			wrapper.dataset.sidenoteNum = numStr;
			margin.dataset.sidenoteNum = numStr;

			if (item.footnoteId) {
				wrapper.dataset.footnoteId = item.footnoteId;
			}

			if (item.type === "sidenote") {
				this.cloneContentToMargin(item.el, margin);
				if (
					this.settings.editInReadingMode &&
					!(isMargin && this.settings.marginNoteDisplay === "popup")
				) {
					margin.dataset.editing = "false";
					margin.dataset.sidenoteType = "html";
					margin.dataset.sidenoteRawText = item.rawText ?? item.text;
				}
			} else {
				// For footnotes, hide the original [1] link inside the sup
				const anchor = item.el.querySelector("a.footnote-link");
				if (anchor && this.settings.hideFootnoteNumbers) {
					anchor.classList.add("sidenote-fn-link-hidden");
				}

				// Render from source markdown text
				margin.appendChild(
					this.renderLinksToFragment(this.normalizeText(item.text)),
				);

				margin.dataset.editing = "false";

				if (
					this.settings.editInReadingMode &&
					item.footnoteId &&
					!(isMargin && this.settings.marginNoteDisplay === "popup")
				) {
					margin.dataset.sidenoteType = "footnote";
					margin.dataset.footnoteId = item.footnoteId;
				}
			}

			if (isMargin && this.settings.marginNoteDisplay === "popup") {
				this.setupMarginNotePopup(
					wrapper,
					margin,
					item.rawText ?? item.text,
					false,
					item.footnoteId,
				);
			}

			item.el.parentNode?.insertBefore(wrapper, item.el);
			wrapper.appendChild(item.el);
			wrapper.appendChild(margin);

			this.applyLineOffset(wrapper, margin, false);

			this.observeSidenoteVisibility(margin);
			marginNotes.push(margin);
		}

		// Hide margin note entries from the footnotes section
		const footnotesSection = readingRoot.querySelector(
			"section.footnotes ol",
		);
		if (footnotesSection) {
			for (const item of allItems) {
				if (item.footnoteId && this.isMarginNote(item.footnoteId)) {
					const renderedIndex = sourceRefOrder.indexOf(item.footnoteId);
					if (renderedIndex >= 0) {
						const li = footnotesSection.children[
							renderedIndex
						] as HTMLElement | null;
						if (li) {
							li.classList.add("sidenote-footnote-item-hidden");
						}
					}
				}
			}
		}

		// Run positioning after DOM is fully settled and elements are laid out.
		// We defer twice: once to let the browser insert elements, once to lay them out.

		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				if (!readingRoot.isConnected) return;

				// Force reflow
				void readingRoot.offsetHeight;

				// Recompute line offsets now that elements are actually laid out
				const wrappers = readingRoot.querySelectorAll<HTMLElement>(
					"span.sidenote-number",
				);
				for (const wrapper of Array.from(wrappers)) {
					const margin = wrapper.querySelector<HTMLElement>(
						"small.sidenote-margin",
					);
					if (margin) {
						this.applyLineOffset(wrapper, margin, false);
					}
				}

				// Calculate and apply global sidenote positioning
				this.updateSidenotePositioning(readingRoot, true);

				// Correct per-wrapper offset for indented parents
				this.correctIndentedSidenotePositions(readingRoot);

				// Use all margins in the DOM (not just newly created ones)
				// so that collisions between old and new sidenotes are resolved.
				const allMargins = Array.from(
					readingRoot.querySelectorAll<HTMLElement>(
						"small.sidenote-margin",
					),
				).filter((m) => m.isConnected);

				resolveCollisionsBySide(
					allMargins,
					this.settings.collisionSpacing,
					this.settings.sidenotePosition,
				);
			});
		});
	}

	private injectPrintPageStyle() {
		// @page (in styles.css) reads these as CSS variables on :root, since
		// Obsidian doesn't allow plugins to inject <style> elements.
		const isRight = this.settings.sidenotePosition !== "left";
		setCssProps(document.documentElement, {
			"--sn-print-margin-left": isRight ? "1.5cm" : "0.1cm",
			"--sn-print-margin-right": isRight ? "0.1cm" : "1.5cm",
		});
	}

	private scheduleFootnoteProcessing() {
		// Debounce multiple calls
		if (this.footnoteProcessingTimer !== null) {
			window.clearTimeout(this.footnoteProcessingTimer);
		}

		this.footnoteProcessingTimer = window.setTimeout(() => {
			this.footnoteProcessingTimer = null;

			const view = this.getMarkdownView();
			if (!view) return;

			const readingRoot = view.containerEl.querySelector<HTMLElement>(
				".markdown-reading-view",
			);
			if (!readingRoot) {
				// console.log(
				// 	"[Sidenotes] scheduleFootnoteProcessing: no readingRoot found",
				// );
				return;
			}

			// Only require refs in DOM (defs may be virtualized away)
			const refElements = readingRoot.querySelectorAll(
				"sup.footnote-ref, sup[data-footnote-id], sup[id^='fnref-'], a.footnote-link",
			);
			const hasRefs = refElements.length > 0;

			if (hasRefs) {
				// Check if all refs are already wrapped — if so, skip
				const unwrappedRefs = Array.from(refElements).filter(
					(el) => !el.closest(".sidenote-number"),
				);
				if (unwrappedRefs.length === 0 && !this.needsReadingModeRefresh) {
					// Nothing new to wrap, but the DOM mutation that got us here
					// still changed the page: Obsidian virtualises preview
					// sections in and out, which adds/removes margins and moves
					// the anchors of the ones that remain. Skipping the restack
					// is what leaves sidenotes overlapping until an unrelated
					// event happens to trigger one.
					this.scheduleCollisionUpdate();
					return;
				}

				window.requestAnimationFrame(() => {
					window.requestAnimationFrame(() => {
						this.processReadingModeSidenotes(readingRoot);
					});
				});
			}
		}, 100);
	}

	/**
	 * Calculate and apply the vertical offset so the sidenote aligns with
	 * the specific line where the reference appears, not the top of the paragraph.
	 */
	private applyLineOffset(
		wrapper: HTMLElement,
		margin: HTMLElement,
		isEditingMode: boolean = false,
	) {
		if (isEditingMode) {
			// In editing mode, sidenotes are inside .cm-line which already has position: relative
			// The wrapper is inline within the line, so we need to find the offset within the line
			const line = wrapper.closest<HTMLElement>(".cm-line");
			if (!line) return;

			// Get positions
			const wrapperRect = wrapper.getBoundingClientRect();
			const lineRect = line.getBoundingClientRect();

			// The offset is how far down the wrapper is from the top of the line
			// For single-line content this is ~0, for wrapped text it could be more
			const lineOffset = wrapperRect.top - lineRect.top;

			margin.style.setProperty(
				"--sidenote-line-offset",
				`${lineOffset}px`,
			);
		} else {
			// Reading mode: anchor to the nearest positioning context that *you* define in CSS
			const positionedParent =
				wrapper.closest(
					"p, li, h1, h2, h3, h4, h5, h6, blockquote, .callout",
				) ?? wrapper.parentElement;

			if (!positionedParent) return;

			// For inline content, prefer the first line box rect (more stable than getBoundingClientRect)
			const rects = wrapper.getClientRects();
			const wrapperRect = rects.length > 0 ? rects.item(0) : null;
			const effectiveWrapperRect =
				wrapperRect ?? wrapper.getBoundingClientRect();

			const parentRect = positionedParent.getBoundingClientRect();
			const lineOffset = effectiveWrapperRect.top - parentRect.top;

			margin.style.setProperty(
				"--sidenote-line-offset",
				`${lineOffset}px`,
			);
		}
	}

	/**
	 * Remove all sidenote markup from reading mode to allow fresh processing.
	 */
	private removeAllSidenoteMarkupFromReadingMode(root: HTMLElement) {
		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
			// Find the original element inside
			const sidenoteSpan =
				wrapper.querySelector<HTMLElement>("span.sidenote");
			const footnoteSup = wrapper.querySelector<HTMLElement>(
				"sup.footnote-ref, sup[class*='footnote'], sup[data-footnote-id]",
			);

			const originalEl = sidenoteSpan ?? footnoteSup;

			// Restore footnote link visibility if needed
			if (footnoteSup) {
				const link = footnoteSup.querySelector<HTMLElement>("a");
				if (link) {
					link.classList.remove("sidenote-fn-link-hidden");
				}
			}

			// Clean up margin
			const margin = wrapper.querySelector<HTMLElement>(
				"small.sidenote-margin",
			);
			if (margin) {
				const snMargin = margin as SidenoteMarginElement;
				if (snMargin._sidenoteCleanup) {
					snMargin._sidenoteCleanup();
					delete snMargin._sidenoteCleanup;
				}
				this.unobserveSidenoteVisibility(margin);
				margin.remove();
			}

			// Unwrap original element
			if (originalEl && wrapper.parentNode) {
				wrapper.parentNode.insertBefore(originalEl, wrapper);
			}

			wrapper.remove();
		}
		// Also remove any print-only sidenote elements
		root.querySelectorAll(".sidenote-print").forEach((el) => el.remove());
		// …and un-hide anything print export hid
		root
			.querySelectorAll(".sidenote-print-hidden")
			.forEach((el) => el.classList.remove("sidenote-print-hidden"));
	}

	private findPrecedingHeading(el: HTMLElement): HTMLElement | null {
		let current: Element | null = el;
		while (current) {
			let sibling = current.previousElementSibling;
			while (sibling) {
				if (/^H[1-6]$/.test(sibling.tagName)) {
					return sibling as HTMLElement;
				}
				const heading = sibling.querySelector("h1, h2, h3, h4, h5, h6");
				if (heading) {
					return heading as HTMLElement;
				}
				sibling = sibling.previousElementSibling;
			}
			current = current.parentElement;
		}
		return null;
	}

	private getHeadingId(heading: HTMLElement): string {
		return (
			heading.textContent?.trim() || heading.id || Math.random().toString()
		);
	}

	/**
	 * Clone content from a sidenote span to a margin element,
	 * preserving links and other HTML elements.
	 * Also sets up click handlers for internal Obsidian links.
	 */
	private cloneContentToMargin(source: HTMLElement, target: HTMLElement) {
		for (const child of Array.from(source.childNodes)) {
			const cloned = child.cloneNode(true);

			if (cloned.instanceOf(HTMLAnchorElement)) {
				this.setupLink(cloned);
			}

			if (cloned.instanceOf(HTMLElement)) {
				const links = cloned.querySelectorAll("a");
				links.forEach((link) => this.setupLink(link));
			}

			target.appendChild(cloned);
		}
	}

	// ==================== Reading Mode HTML Editing ========================

	/**
	 * Read the current footnote definition text from the source file.
	 * Always reads fresh from the editor/cache so delegated clicks
	 * never use stale text captured at DOM-creation time.
	 */
	private getFootnoteSourceText(footnoteId: string): string | null {
		const view = this.getMarkdownView();
		const content =
			this.cachedSourceContent ||
			view?.editor?.getValue() ||
			(view as { data?: string })?.data ||
			"";
		if (!content) return null;

		const definitions = this.parseFootnoteDefinitions(content);
		return definitions.get(footnoteId) ?? null;
	}

	private getScrollTopFromEditor(editor: Editor): number {
		const maybe = editor as unknown as HasCmScrollTop;
		const v = maybe.cm?.scrollDOM?.scrollTop;
		return typeof v === "number" ? v : 0;
	}

	/**
	 * Re-sequence all footnotes so references and definitions
	 * are numbered sequentially in the order they appear in the text.
	 * Margin notes ([^mn-...]) are re-sequenced separately.
	 */
	private resequenceFootnotes(editor: Editor) {
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
				const scrollInfo = this.getScrollTopFromEditor(editor);
				this.isMutating = true;
				try {
					editor.setValue(content);
				} finally {
					this.isMutating = false;
				}
				const scroller =
					this.cmRoot?.querySelector<HTMLElement>(".cm-scroller");
				if (scroller) scroller.scrollTop = scrollInfo;
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
				const scrollInfo = this.getScrollTopFromEditor(editor);
				this.isMutating = true;
				try {
					editor.setValue(content);
				} finally {
					this.isMutating = false;
				}
				const scroller =
					this.cmRoot?.querySelector<HTMLElement>(".cm-scroller");
				if (scroller) scroller.scrollTop = scrollInfo;
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
		const scrollInfo = this.getScrollTopFromEditor(editor);

		this.isMutating = true;
		try {
			editor.setValue(content);
		} finally {
			this.isMutating = false;
		}

		const scroller =
			this.cmRoot?.querySelector<HTMLElement>(".cm-scroller");
		if (scroller) scroller.scrollTop = scrollInfo;
	}

	/**
	 * Open a CM6 editor for an HTML span sidenote in reading mode,
	 * using the raw markdown source text.
	 */
	private startReadingModeHtmlEdit(margin: HTMLElement, rawText: string) {
		if (this.spanCmView) return;

		this.spanOriginalText = rawText;
		this.activeReadingModeMargin = margin;

		margin.dataset.editing = "true";
		margin.innerHTML = "";

		const commitAndClose = (opts: { commit: boolean }) => {
			const cm = this.spanCmView;
			if (!cm) return;

			const newText = cm.state.doc.toString();
			const renderText = opts.commit ? newText : this.spanOriginalText;

			if (this.spanOutsidePointerDown) {
				document.removeEventListener(
					"pointerdown",
					this.spanOutsidePointerDown,
					true,
				);
				this.spanOutsidePointerDown = undefined;
			}

			this.spanCmView = null;
			cm.destroy();

			setWorkspaceActiveEditor(this, null);

			margin.dataset.editing = "false";

			if (opts.commit && newText !== this.spanOriginalText) {
				this.commitHtmlSpanSidenoteText(this.spanOriginalText, newText);
			}

			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(renderText)),
			);

			this.activeReadingModeMargin = null;

			if (opts.commit && newText !== this.spanOriginalText) {
				this.refreshCachedSourceContent();
				this.needsReadingModeRefresh = true;
				this.invalidateLayoutCache();
			}
		};

		const closeKeymap = keymap.of([
			{
				key: "Escape",
				run: () => {
					commitAndClose({ commit: false });
					return true;
				},
				preventDefault: true,
			},
			{
				key: "Enter",
				run: () => {
					commitAndClose({ commit: true });
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
			doc: rawText,
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

		const cm = new EditorView({ state, parent: margin });
		this.spanCmView = cm;
		cm.dom.classList.add("sidenote-cm-editor");

		const scroller = cm.dom.querySelector<HTMLElement>(".cm-scroller");
		if (scroller) {
			setCssProps(scroller, { "padding-left": "0", padding: "0" }, true);
		}

		cm.dom.addEventListener(
			"focusin",
			() => setWorkspaceActiveEditor(this, cm),
			true,
		);
		cm.dom.addEventListener(
			"focusout",
			() => setWorkspaceActiveEditor(this, null),
			true,
		);

		const cleanupKeyboard = this.setupMarginKeyboardCapture(margin);
		const snMargin = margin as SidenoteMarginElement;
		snMargin._sidenoteCleanup = () => {
			cleanupKeyboard();
			if (this.spanCmView === cm) {
				commitAndClose({ commit: false });
			}
		};

		this.spanOutsidePointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (margin.contains(target) || cm.dom.contains(target)) return;
			commitAndClose({ commit: true });
		};
		document.addEventListener(
			"pointerdown",
			this.spanOutsidePointerDown,
			true,
		);

		window.requestAnimationFrame(() => cm.focus());
	}

	// ==================== Reading Mode Footnote Editing ====================

	/**
	 * Open a CM6 editor inside a reading-mode sidenote margin for a footnote.
	 */
	private startReadingModeFootnoteEdit(
		margin: HTMLElement,
		footnoteId: string,
		footnoteText: string,
	) {
		// If already editing another reading-mode margin, commit it first
		if (this.readingCmView && this.activeReadingModeMargin) {
			this.finishReadingModeFootnoteEdit(
				this.activeReadingModeMargin,
				true,
			);
		}

		// Clear any post-edit cooldown from the previous edit
		if (this.postEditCooldown !== null) {
			window.clearTimeout(this.postEditCooldown);
			this.postEditCooldown = null;
		}

		this.readingCmOriginalText = footnoteText;
		this.readingCmFootnoteId = footnoteId;
		this.isEditingMargin = true;

		margin.dataset.editing = "true";
		this.activeReadingModeMargin = margin;
		margin.innerHTML = "";

		const commitAndClose = (opts: { commit: boolean }) => {
			this.finishReadingModeFootnoteEdit(margin, opts.commit);
		};

		const closeKeymap = keymap.of([
			{
				key: "Escape",
				run: () => {
					commitAndClose({ commit: false });
					return true;
				},
				preventDefault: true,
			},
			{
				key: "Enter",
				run: () => {
					commitAndClose({ commit: true });
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
			doc: footnoteText,
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

		const cm = new EditorView({ state, parent: margin });
		this.readingCmView = cm;

		cm.dom.classList.add("sidenote-cm-editor");

		const scroller = cm.dom.querySelector<HTMLElement>(".cm-scroller");
		if (scroller) {
			setCssProps(scroller, { "padding-left": "0", padding: "0" }, true);
		}

		// Route Obsidian's active editor to this CM instance
		cm.dom.addEventListener(
			"focusin",
			() => setWorkspaceActiveEditor(this, cm),
			true,
		);
		cm.dom.addEventListener(
			"focusout",
			() => setWorkspaceActiveEditor(this, null),
			true,
		);

		// Set up keyboard capture so Obsidian hotkeys don't interfere
		const cleanupKeyboard = this.setupMarginKeyboardCapture(margin);
		const snMargin = margin as SidenoteMarginElement;
		snMargin._sidenoteCleanup = () => {
			cleanupKeyboard();
			if (this.readingCmView === cm) {
				this.finishReadingModeFootnoteEdit(margin, false);
			}
		};

		// Click outside → commit and close
		this.readingCmOutsidePointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (margin.contains(target) || cm.dom.contains(target)) return;
			commitAndClose({ commit: true });
		};
		document.addEventListener(
			"pointerdown",
			this.readingCmOutsidePointerDown,
			true,
		);

		window.requestAnimationFrame(() => cm.focus());

		// Watch for editor height changes and re-run collision avoidance
		const resizeObs = new ResizeObserver(() => {
			const readingRoot = this.app.workspace
				.getActiveViewOfType(MarkdownView)
				?.containerEl.querySelector<HTMLElement>(".markdown-reading-view");
			if (!readingRoot) return;

			const allMargins = Array.from(
				readingRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
			).filter((m) => m.isConnected);

			resolveCollisionsBySide(
				allMargins,
				this.settings.collisionSpacing,
				this.settings.sidenotePosition,
			);
		});

		resizeObs.observe(cm.dom);

		// Chain onto existing cleanup so teardown disconnects the observer
		const prevCleanup = snMargin._sidenoteCleanup;
		snMargin._sidenoteCleanup = () => {
			resizeObs.disconnect();
			if (prevCleanup) prevCleanup();
		};
	}

	/**
	 * Close the reading-mode footnote editor, optionally committing changes.
	 */
	private finishReadingModeFootnoteEdit(
		margin: HTMLElement,
		commit: boolean,
	) {
		const cm = this.readingCmView;
		if (!cm) return;

		const newText = cm.state.doc.toString();
		const renderText = commit ? newText : this.readingCmOriginalText;

		// Remove outside-click listener
		if (this.readingCmOutsidePointerDown) {
			document.removeEventListener(
				"pointerdown",
				this.readingCmOutsidePointerDown,
				true,
			);
			this.readingCmOutsidePointerDown = undefined;
		}

		// Destroy CM
		this.readingCmView = null;
		cm.destroy();

		// Restore Obsidian active editor routing
		setWorkspaceActiveEditor(this, null);

		// Keep isEditingMargin = true through the commit so that
		// editor-change doesn't set needsReadingModeRefresh = true
		// and the MutationObserver skips during the commit.
		margin.dataset.editing = "false";
		this.activeReadingModeMargin = null;

		// Commit to the source file if changed
		if (commit && newText !== this.readingCmOriginalText) {
			this.commitReadingModeFootnoteText(
				this.readingCmFootnoteId,
				newText,
			);

			// Immediately patch the cached source content so that
			// clicking the sidenote again reads the new text, rather
			// than waiting for the async file write to propagate.
			if (this.cachedSourceContent) {
				const escapedId = this.readingCmFootnoteId.replace(
					/[.*+?^${}()|[\]\\]/g,
					"\\$&",
				);
				const regex = new RegExp(
					`^(\\[\\^${escapedId}\\]:\\s*)(.+(?:\\n(?:[ \\t]+.+)*)?)$`,
					"gm",
				);
				const match = regex.exec(this.cachedSourceContent);
				if (match) {
					const prefix = match[1] ?? "";
					const before = this.cachedSourceContent.slice(
						0,
						match.index + prefix.length,
					);
					const after = this.cachedSourceContent.slice(
						match.index + match[0].length,
					);
					this.cachedSourceContent = before + newText + after;
				}
			}
		}

		// NOW clear the editing flag
		this.isEditingMargin = false;

		// Re-render the sidenote display with the correct text
		margin.innerHTML = "";
		margin.appendChild(
			this.renderLinksToFragment(this.normalizeText(renderText)),
		);

		// Set a cooldown to prevent the MutationObserver-triggered
		// rebuild from overwriting this margin with stale source data.
		// Obsidian re-renders the preview DOM asynchronously after the
		// file write, which fires the MutationObserver → scheduleFootnoteProcessing
		// → processReadingModeSidenotes. If that rebuild reads source content
		// before Obsidian has updated its internal cache, it gets the OLD text
		// and overwrites our correct re-render.
		if (commit && newText !== this.readingCmOriginalText) {
			if (this.postEditCooldown !== null) {
				window.clearTimeout(this.postEditCooldown);
			}
			this.postEditCooldown = window.setTimeout(() => {
				this.postEditCooldown = null;
				// Now that Obsidian has had time to update its caches,
				// refresh our cached content too
				this.refreshCachedSourceContent();
			}, 500);
		}

		// Re-run collision avoidance since the margin height changed
		window.requestAnimationFrame(() => {
			const readingRoot = this.app.workspace
				.getActiveViewOfType(MarkdownView)
				?.containerEl.querySelector<HTMLElement>(".markdown-reading-view");
			if (!readingRoot) return;

			const allMargins = Array.from(
				readingRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
			).filter((m) => m.isConnected);

			resolveCollisionsBySide(
				allMargins,
				this.settings.collisionSpacing,
				this.settings.sidenotePosition,
			);
		});
	}

	/**
	 * Write the new footnote text back to the source file.
	 * Works even in reading mode by using view.editor (which Obsidian
	 * keeps synchronized) or falling back to vault.modify().
	 */
	private commitReadingModeFootnoteText(
		footnoteId: string,
		newText: string,
	) {
		const view = this.getMarkdownView();
		const file = view?.file ?? this.app.workspace.getActiveFile();
		if (!file) return;

		void this.app.vault.process(file, (content) => {
			const escapedId = footnoteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(
				`^(\\[\\^${escapedId}\\]:\\s*)(.+(?:\\n(?:[ \\t]+.+)*)?)$`,
				"gm",
			);

			const match = regex.exec(content);
			if (!match) return content; // no change

			const prefix = match[1] ?? "";
			const before = content.slice(0, match.index + prefix.length);
			const after = content.slice(match.index + match[0].length);

			return before + newText + after;
		});
	}

	/**
	 * Set up a link element with proper attributes and click handlers.
	 * Handles both external links and internal Obsidian links.
	 */
	private setupLink(link: HTMLAnchorElement) {
		// Check if it's an internal Obsidian link
		const isInternalLink =
			link.classList.contains("internal-link") ||
			link.hasAttribute("data-href") ||
			(link.href &&
				!link.href.startsWith("http://") &&
				!link.href.startsWith("https://") &&
				!link.href.startsWith("mailto:"));

		if (isInternalLink) {
			// Get the target from data-href (Obsidian's way) or href
			const target =
				link.getAttribute("data-href") || link.getAttribute("href") || "";

			// Ensure it has the internal-link class
			link.classList.add("internal-link");

			// Set data-href if not present
			if (!link.hasAttribute("data-href") && target) {
				link.setAttribute("data-href", target);
			}

			// Add click handler for internal navigation
			link.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();

				const linkTarget =
					link.getAttribute("data-href") ||
					link.getAttribute("href") ||
					"";
				if (linkTarget) {
					void this.app.workspace.openLinkText(linkTarget, "", false);
				}
			});

			// Don't open in new tab
			link.removeAttribute("target");
		} else {
			// External link - add external-link class for the icon
			link.classList.add("external-link");
			link.rel = "noopener noreferrer";
			link.target = "_blank";
		}
	}

	// ==================== Mode Calculation ====================

	private calculateMode(
		width: number,
	): "hidden" | "compact" | "normal" | "full" {
		const s = this.settings;
		// Sanity check: if width is 0 or unreasonably small, hide
		if (width <= 0 || width < 200) {
			return "hidden";
		}
		if (width < s.hideBelow) {
			return "hidden";
		} else if (width < s.compactBelow) {
			return "compact";
		} else if (width < s.fullAbove) {
			return "normal";
		} else {
			return "full";
		}
	}

	private calculateScaleFactor(width: number): number {
		const s = this.settings;
		if (width < s.hideBelow) {
			return 0;
		}
		return Math.min(
			1,
			(width - s.hideBelow) / (s.fullAbove - s.hideBelow),
		);
	}

	// ==================== Reading Mode Layout ====================

	private scheduleReadingModeLayout() {
		window.requestAnimationFrame(() => {
			const view = this.getMarkdownView();
			if (!view) return;

			const readingRoot = view.containerEl.querySelector<HTMLElement>(
				".markdown-reading-view",
			);
			if (!readingRoot) return;

			const rect = readingRoot.getBoundingClientRect();
			const width = rect.width;

			readingRoot.style.setProperty("--editor-width", `${width}px`);

			const mode = this.calculateMode(width);
			readingRoot.dataset.sidenoteMode = mode;
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;
			readingRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

			const scaleFactor = this.calculateScaleFactor(width);
			readingRoot.style.setProperty(
				"--sidenote-scale",
				scaleFactor.toFixed(3),
			);

			// Check if we have sidenotes
			const hasMargins =
				readingRoot.querySelectorAll("small.sidenote-margin").length > 0;

			// If no margins exist but we should have sidenotes, reprocess
			if (!hasMargins && this.documentHasSidenotes && mode !== "hidden") {
				this.processReadingModeSidenotes(readingRoot);
				return;
			}

			// Update positioning and run collision avoidance
			if (mode !== "hidden" && hasMargins) {
				window.requestAnimationFrame(() => {
					this.updateSidenotePositioning(readingRoot, true);
					this.correctIndentedSidenotePositions(readingRoot);
					this.updateReadingModeCollisions();
				});
			}
		});
	}

	// ==================== Document Scanning ====================

	private scanDocumentForSidenotes() {
		console.warn("[Sidenotes] Scanning document for sidenotes...");
		const view = this.getMarkdownView();
		if (!view) {
			this.documentHasSidenotes = false;
			return;
		}

		const editor = view.editor;
		if (!editor) {
			this.documentHasSidenotes = false;
			return;
		}

		const content = editor.getValue();

		// Cache source content for reading mode
		// (view.editor.getValue() can return "" in reading mode)
		if (content) {
			this.cachedSourceContent = content;
		}

		if (this.settings.sidenoteFormat === "html") {
			this.documentHasSidenotes = SIDENOTE_PATTERN().test(content);
			SIDENOTE_PATTERN().lastIndex = 0;
		} else {
			this.documentHasSidenotes = /\[\^[^\]]+\](?!:)/.test(content);
		}

		// Check if we're in Source mode
		const cmRoot = this.cmRoot;
		const isSourceMode =
			cmRoot && !cmRoot.classList.contains("is-live-preview");

		if (cmRoot) {
			let editingHasSidenotes = false;

			// Sidenotes only exist in Live Preview — Source mode shows the
			// bare markdown
			if (isSourceMode) {
				editingHasSidenotes = false;
			} else if (this.settings.sidenoteFormat === "html") {
				editingHasSidenotes = SIDENOTE_PATTERN().test(content);
				SIDENOTE_PATTERN().lastIndex = 0;
			} else if (this.settings.sidenoteFormat === "footnote-edit") {
				editingHasSidenotes = /\[\^[^\]]+\](?!:)/.test(content);
			}
			// For "footnote" format, editing mode has no sidenotes at all

			cmRoot.dataset.hasSidenotes = editingHasSidenotes ? "true" : "false";
		}

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			readingRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";
		}
	}

	/**
	 * Re-read source content from the editor and update the cache.
	 * Call this after any commit (editing or reading mode) so that
	 * subsequent mode switches and undo operations see fresh data.
	 */
	private refreshCachedSourceContent() {
		const view = this.getMarkdownView();
		const content =
			view?.editor?.getValue() || (view as { data?: string })?.data || "";
		if (content) {
			this.cachedSourceContent = content;
		}
	}

	/**
	 * Parse footnote definitions from the document content.
	 * Returns a map of footnote ID to footnote text.
	 */
	private parseFootnoteDefinitions(content: string): Map<string, string> {
		return parseFootnoteDefinitions(content);
	}

	// ==================== Scheduling ====================

	private cancelScheduled() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	private scheduleLayout() {
		this.cancelScheduled();
		this.rafId = window.requestAnimationFrame(() => {
			this.rafId = null;
			this.layout();
		});
	}

	private scheduleLayoutStable() {
		this.cancelScheduled();

		// Leading pass: ASAP
		this.rafId = window.requestAnimationFrame(() => {
			this.rafId = null;
			this.layout();
		});

		// Trailing pass: catches the “one second later” reflow
		if (this.layoutTrailingTimer !== null) {
			window.clearTimeout(this.layoutTrailingTimer);
		}
		this.layoutTrailingTimer = window.setTimeout(() => {
			this.layoutTrailingTimer = null;
			this.layout();
		}, 200);
	}

	private rebindAndSchedule() {
		this.rebind();
		this.scheduleLayout();
	}

	// ==================== Binding ====================

	private rebind() {
		// First confirm we have a view and something to bind to before tearing
		// down the old setup.
		const view = this.getMarkdownView();
		if (!view) return; // Don't tear down if there's no view to bind to

		const root = view.containerEl;
		const cmRoot = root.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		const readingRoot = root.querySelector<HTMLElement>(
			".markdown-reading-view",
		);

		// A leaf opened straight into reading mode may have no source view at
		// all. Bailing here used to skip the reading-mode scroll and mutation
		// listeners entirely, so nothing ever re-resolved collisions and
		// overlapping sidenotes stayed overlapped.
		if (!cmRoot && !readingRoot) return;

		// Only now tear down the old setup, after confirming we have something
		// new to bind to.
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		this.visibleSidenotes.clear();

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		// Handle resize events with a debounce to prevent thrashing
		let resizeTimeout: number | null = null;
		let lastObservedWidth = 0;

		this.resizeObserver = new ResizeObserver((entries) => {
			const entry = entries[0];
			const currentWidth = entry?.contentRect?.width ?? 0;

			if (Math.abs(currentWidth - lastObservedWidth) < 1) return;
			lastObservedWidth = currentWidth;

			if (resizeTimeout !== null) {
				window.clearTimeout(resizeTimeout);
			}
			resizeTimeout = window.setTimeout(() => {
				resizeTimeout = null;
				this.scheduleLayout();
				this.scheduleReadingModeLayout();
			}, 50);
		});

		// Store cleanup for the resize timeout
		this.cleanups.push(() => {
			if (resizeTimeout !== null) {
				window.clearTimeout(resizeTimeout);
				resizeTimeout = null;
			}
		});

		if (cmRoot) {
			this.cmRoot = cmRoot;

			cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";
			cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
			// cmRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

			this.resizeObserver.observe(cmRoot);
		} else {
			// Reading-only leaf: don't keep pointing at another view's editor.
			this.cmRoot = null;
		}

		if (readingRoot) {
			this.resizeObserver.observe(readingRoot);
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;
			readingRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

			// Ensure delegated click handler for reading mode margins
			this.ensureReadingModeDelegation(readingRoot);

			const onReadingScroll = () => {
				if (this.readingModeScrollTimer !== null) {
					window.clearTimeout(this.readingModeScrollTimer);
				}
				this.readingModeScrollTimer = window.setTimeout(() => {
					this.readingModeScrollTimer = null;
					this.avoidCollisionsInReadingMode(readingRoot);
				}, 100);
			};

			// Listen on the reading root in the capture phase rather than on
			// .markdown-preview-view. Scroll doesn't bubble, but it does
			// capture, so this keeps working when the preview scroller is
			// mounted (or replaced) after rebind — previously we resolved the
			// scroller once and silently fell back to a non-scrolling element.
			readingRoot.addEventListener("scroll", onReadingScroll, {
				passive: true,
				capture: true,
			});
			this.cleanups.push(() =>
				readingRoot.removeEventListener("scroll", onReadingScroll, {
					capture: true,
				}),
			);

			// Re-process reading mode when Obsidian virtualizes/mounts new preview DOM
			const readingContent =
				readingRoot.querySelector<HTMLElement>(
					".markdown-preview-sizer",
				) ?? readingRoot;

			let readingMutationTimer: number | null = null;

			const readingMo = new MutationObserver((mutations) => {
				// Skip while margin editing (prevents flicker)
				if (this.isEditingMargin) return;

				// Only react to added/removed nodes; characterData churn can be noisy
				let relevant = false;
				for (const m of mutations) {
					if (m.type !== "childList") continue;
					if (m.addedNodes.length || m.removedNodes.length) {
						relevant = true;
						break;
					}
				}
				if (!relevant) return;

				if (readingMutationTimer !== null)
					window.clearTimeout(readingMutationTimer);
				readingMutationTimer = window.setTimeout(() => {
					readingMutationTimer = null;
					if (this.settings.sidenoteFormat === "html") {
						// HTML sidenotes have no footnote refs for
						// scheduleFootnoteProcessing to find, so newly
						// virtualized <span class="sidenote"> sections need
						// their own reprocessing pass here.
						window.requestAnimationFrame(() => {
							window.requestAnimationFrame(() => {
								this.processReadingModeSidenotes(readingRoot);
							});
						});
					} else {
						// This will now run even if <section.footnotes> is not mounted
						this.scheduleFootnoteProcessing();
					}
				}, 75);
			});

			readingMo.observe(readingContent, {
				childList: true,
				subtree: true,
			});

			this.cleanups.push(() => {
				readingMo.disconnect();
				if (readingMutationTimer !== null) {
					window.clearTimeout(readingMutationTimer);
					readingMutationTimer = null;
				}
			});
		}

		if (!cmRoot) return;

		const scroller = cmRoot.querySelector<HTMLElement>(".cm-scroller");
		if (!scroller) return;

		const onScroll = () => {
			if (this.scrollDebounceTimer !== null) {
				window.clearTimeout(this.scrollDebounceTimer);
			}
			this.scrollDebounceTimer = window.setTimeout(() => {
				this.scrollDebounceTimer = null;
				this.scheduleLayout();
			}, SidenotePlugin.SCROLL_DEBOUNCE);
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		this.cleanups.push(() =>
			scroller.removeEventListener("scroll", onScroll),
		);

		const content = cmRoot.querySelector<HTMLElement>(".cm-content");
		if (content) {
			const mo = new MutationObserver(() => {
				if (this.isMutating) return;
				this.scheduleLayoutDebounced(SidenotePlugin.MUTATION_DEBOUNCE);
			});
			mo.observe(content, {
				childList: true,
				subtree: true,
				characterData: true,
			});
			this.cleanups.push(() => mo.disconnect());
		}

		// Watch for Live Preview / Source mode toggle on cmRoot
		const modeMo = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (
					mutation.type === "attributes" &&
					mutation.attributeName === "class"
				) {
					// View mode changed, reschedule layout
					this.invalidateLayoutCache();
					this.scheduleLayout();
					break;
				}
			}
		});
		modeMo.observe(cmRoot, {
			attributes: true,
			attributeFilter: ["class"],
		});
		this.cleanups.push(() => modeMo.disconnect());
	}

	// ==================== Document Position ====================

	private getDocumentPosition(el: HTMLElement): number | null {
		const view = this.getMarkdownView();
		if (!view) return null;

		const editor = (view.editor as { cm?: EditorView })?.cm;
		if (!editor?.state || !editor?.lineBlockAt) return null;

		const lineEl = el.closest(".cm-line");
		if (!lineEl) return null;

		const rect = lineEl.getBoundingClientRect();

		const pos = editor.posAtCoords({
			x: rect.left,
			y: rect.top + rect.height / 2,
		});
		if (pos === null) return null;

		const spanRect = el.getBoundingClientRect();
		const offsetInLine = spanRect.left - rect.left;

		return pos * 10000 + Math.floor(offsetInLine);
	}

	// ==================== Registry Management ====================

	private resetRegistry() {
		this.sidenoteRegistry.clear();
		this.headingSidenoteNumbers.clear();
	}

	// ==================== Main Layout ====================

	private layout() {
		const cmRoot = this.cmRoot;
		if (!cmRoot) {
			console.warn("[Sidenotes] layout() - no cmRoot");
			return;
		}

		const cmRootRect = cmRoot.getBoundingClientRect();
		const editorWidth = cmRootRect.width;
		const mode = this.calculateMode(editorWidth);

		// console.log("[Sidenotes] layout():", {
		// 	editorWidth,
		// 	mode,
		// 	isConnected: cmRoot.isConnected,
		// 	unwrappedCount: cmRoot.querySelectorAll(
		// 		"span.sidenote:not(.sidenote-number span.sidenote)",
		// 	).length,
		// 	wrappedCount: cmRoot.querySelectorAll("small.sidenote-margin")
		// 		.length,
		// });

		cmRoot.style.setProperty("--editor-width", `${editorWidth}px`);
		cmRoot.dataset.sidenoteMode = mode;
		cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
		cmRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

		const scaleFactor = this.calculateScaleFactor(editorWidth);
		cmRoot.style.setProperty("--sidenote-scale", scaleFactor.toFixed(3));

		// Check if we're in Source mode (not Live Preview)
		const isSourceMode = !cmRoot.classList.contains("is-live-preview");

		// Determine if we should process sidenotes in editing mode
		// const processHtmlSidenotes = this.settings.sidenoteFormat === "html";
		const processFootnoteSidenotes =
			this.settings.sidenoteFormat === "footnote-edit" && !isSourceMode;

		// Source mode shows the raw markdown — no sidenotes, and no page
		// offset reserving margin space for them
		if (isSourceMode) {
			cmRoot.dataset.hasSidenotes = "false";
			return;
		}

		// For footnote-edit mode, the CM6 widget handles the sidenotes
		// We just need to set the data attributes and run collision avoidance
		if (processFootnoteSidenotes) {
			cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";

			// Run positioning and collision avoidance for widget-created margins
			if (mode !== "hidden" && this.documentHasSidenotes) {
				window.setTimeout(() => {
					window.requestAnimationFrame(() => {
						window.requestAnimationFrame(() => {
							if (!cmRoot.isConnected) return;
							this.updateSidenotePositioning(cmRoot, false);
							this.updateEditingModeCollisions();
						});
					});
				}, SidenotePlugin.WIDGET_LAYOUT_DELAY);
			}
			return;
		}

		// For reading-only footnote mode, don't process anything in editing
		if (this.settings.sidenoteFormat === "footnote") {
			cmRoot.dataset.hasSidenotes = "false";
			return;
		}

		// HTML sidenote processing (existing logic)
		cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
			? "true"
			: "false";

		const unwrappedSpans = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) => !span.parentElement?.classList.contains("sidenote-number"),
		);
		// console.warn(unwrappedSpans.length, "unwrapped sidenote spans found");
		// If there are new sidenotes to process, we need to renumber everything
		if (unwrappedSpans.length > 0 && mode !== "hidden") {
			// Remove all existing sidenote wrappers and margins to renumber from scratch
			this.removeAllSidenoteMarkup(cmRoot);

			// Get the source content to determine correct indices
			const view = this.getMarkdownView();
			if (!view?.editor) return;

			const content = view.editor.getValue();

			// Build a map of sidenote text content + position to their index
			const sidenoteIndexMap = this.buildSidenoteOnlyIndexMap(content);

			// Now get ALL sidenote spans (they're all unwrapped now)
			const allSpans = Array.from(
				cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
			);

			if (allSpans.length === 0) {
				this.lastSidenoteCount = 0;
				return;
			}

			// Collect all sidenotes to process
			const allItems = allSpans.map((el) => ({
				el,
				docPos: this.getDocumentPosition(el),
				text: el.textContent ?? "",
			}));

			// Match each visible item to its index in the full document
			const itemsWithIndex = allItems.map((item) => {
				const index = this.findSidenoteIndex(
					sidenoteIndexMap,
					item.text,
					item.docPos,
				);
				return { ...item, index };
			});

			// Assign source index BEFORE sorting (DOM order = source order)
			let sourceCounter = 1;
			const itemsWithSourceIndex = itemsWithIndex.map((item) => ({
				...item,
				sourceIndex: sourceCounter++,
			}));

			// Sort by index for consistent display ordering
			itemsWithSourceIndex.sort((a, b) => a.index - b.index);

			this.isMutating = true;
			try {
				for (const item of itemsWithSourceIndex) {
					const isMargin = this.isMarginNote(item.el);
					const sideOverride = getSidenoteSideOverride(item.el);
					const numStr = isMargin ? "" : this.formatNumber(item.index);
					const wrapper = createSpan();
					wrapper.className = "sidenote-number";
					const margin = createEl("small");
					margin.className = "sidenote-margin";

					if (isMargin) {
						wrapper.classList.add("margin-note");
						margin.classList.add("margin-note");
					}
					if (sideOverride) {
						wrapper.dataset.sidenoteSide = sideOverride;
						margin.dataset.sidenoteSide = sideOverride;
					}

					wrapper.dataset.sidenoteNum = numStr;
					margin.dataset.sidenoteNum = numStr;

					if (isMargin) {
						const marker = createSpan();
						marker.className = "margin-note-marker";

						const iconSetting = this.settings.popupIcon || "ⓘ";

						if (
							iconSetting.endsWith(".png") ||
							iconSetting.endsWith(".svg") ||
							iconSetting.endsWith(".jpg")
						) {
							const img = createEl("img");
							img.src = this.app.vault.adapter.getResourcePath(
								`${this.manifest.dir}/assets/${iconSetting}`,
							);
							img.className = "margin-note-marker-img";
							marker.appendChild(img);
						} else {
							marker.textContent = iconSetting;
						}

						if (this.settings.marginNoteDisplay === "popup") {
							marker.addEventListener("click", (e) => {
								e.preventDefault();
								e.stopPropagation();
								// Find the popup icon in the margin and click it
								const popupIcon = margin.querySelector<HTMLElement>(
									".margin-note-icon",
								);
								if (popupIcon) popupIcon.click();
							});
						} else {
							marker.addEventListener("click", (e) => {
								e.preventDefault();
								e.stopPropagation();
								this.startMarginEdit(margin, item.el, item.index, e);
							});
						}
						marker.addEventListener("mousedown", (e) => {
							e.stopPropagation();
						});
						wrapper.appendChild(marker);
					}

					const raw = this.normalizeText(item.el.textContent ?? "");
					margin.appendChild(this.renderLinksToFragment(raw));

					// Setup popup AFTER margin has content
					if (isMargin && this.settings.marginNoteDisplay === "popup") {
						this.setupMarginNotePopup(wrapper, margin, item.text, true);
					}
					// Make margin editable and set up edit handling
					this.setupMarginEditing(
						margin,
						item.el,
						item.docPos,
						item.index,
					);

					// Add click handler to select only text content
					this.setupSidenoteClickHandler(wrapper, item.text);

					item.el.parentNode?.insertBefore(wrapper, item.el);
					wrapper.appendChild(item.el);
					wrapper.appendChild(margin);

					// Calculate line offset for this sidenote (editing mode)
					this.applyLineOffset(wrapper, margin, true);

					this.observeSidenoteVisibility(margin);
				}
			} finally {
				this.isMutating = false;
			}

			this.lastSidenoteCount =
				cmRoot.querySelectorAll(".sidenote-margin").length;

			// Run positioning and collision avoidance after DOM is settled
			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => {
					if (!cmRoot.isConnected) return;
					this.updateSidenotePositioning(cmRoot, false);
					this.updateEditingModeCollisions();
				});
			});
		} else {
			// No new sidenotes to process
			this.lastSidenoteCount =
				cmRoot.querySelectorAll(".sidenote-margin").length;

			if (this.lastSidenoteCount > 0 && mode !== "hidden") {
				// Still run positioning and collision avoidance for existing sidenotes
				window.requestAnimationFrame(() => {
					window.requestAnimationFrame(() => {
						if (!cmRoot.isConnected) return;
						this.updateSidenotePositioning(cmRoot, false);
						this.updateEditingModeCollisions();
					});
				});
			}
		}
	}

	/**
	 * Build a map of sidenotes only (not footnotes) in the source document.
	 * Used for editing mode where footnote conversion is disabled.
	 */
	private buildSidenoteOnlyIndexMap(content: string): {
		index: number;
		charPos: number;
		text: string;
		isMarginNote: boolean;
	}[] {
		const items: {
			index: number;
			charPos: number;
			text: string;
			isMarginNote: boolean;
		}[] = [];

		// Find all sidenotes (including margin-note variant)
		const sidenoteRegex = SIDENOTE_SPAN_REGEX();
		let match: RegExpExecArray | null;

		while ((match = sidenoteRegex.exec(content)) !== null) {
			const isMargin = /margin-note/.test(match[0]);
			items.push({
				index: 0,
				charPos: match.index,
				text: this.normalizeText(match[1] ?? ""),
				isMarginNote: isMargin,
			});
		}

		// Sort by position and assign indices (only numbered sidenotes get incremented)
		items.sort((a, b) => a.charPos - b.charPos);
		let counter = 1;
		items.forEach((item) => {
			if (item.isMarginNote) {
				item.index = -1; // Margin notes have no number
			} else {
				item.index = counter++;
			}
		});

		return items;
	}

	/**
	 * Find the index of a sidenote in the document based on its text and approximate position.
	 */
	private findSidenoteIndex(
		sidenoteMap: {
			index: number;
			charPos: number;
			text: string;
			isMarginNote?: boolean;
		}[],
		text: string,
		docPos: number | null,
	): number {
		const normalizedText = this.normalizeText(text);

		// Find all sidenotes with matching text
		const matchingByText = sidenoteMap.filter(
			(s) => s.text === normalizedText,
		);

		if (matchingByText.length === 1) {
			const match = matchingByText[0];
			if (match) {
				return match.index;
			}
		}

		if (matchingByText.length > 1 && docPos !== null) {
			const approxCharPos = Math.floor(docPos / 10000);
			let closest: {
				index: number;
				charPos: number;
				text: string;
			} | null = null;
			let closestDist = Infinity;

			for (const s of matchingByText) {
				const dist = Math.abs(s.charPos - approxCharPos);
				if (dist < closestDist) {
					closestDist = dist;
					closest = s;
				}
			}

			if (closest) {
				return closest.index;
			}
		}

		// Fallback: return next available index
		const maxIndex = sidenoteMap.reduce(
			(max, s) => Math.max(max, s.index),
			0,
		);
		return maxIndex + 1;
	}

	/**
	 * Remove all sidenote markup (wrappers and margins) so we can renumber from scratch.
	 * This unwraps the original span.sidenote elements and footnote ref spans.
	 */
	private removeAllSidenoteMarkup(root: HTMLElement) {
		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
			const sidenoteSpan =
				wrapper.querySelector<HTMLElement>("span.sidenote");

			const margin = wrapper.querySelector<HTMLElement>(
				"small.sidenote-margin",
			);
			if (margin) {
				// Call cleanup if it exists
				const snMargin = margin as SidenoteMarginElement;
				if (snMargin._sidenoteCleanup) {
					snMargin._sidenoteCleanup();
					delete snMargin._sidenoteCleanup;
				}
				this.unobserveSidenoteVisibility(margin);
				margin.remove();
			}

			if (sidenoteSpan && wrapper.parentNode) {
				wrapper.parentNode.insertBefore(sidenoteSpan, wrapper);
			}

			wrapper.remove();
		}
	}

	// ==================== Text Normalization ====================

	private normalizeText(s: string): string {
		return normalizeText(s);
	}

	/**
	 * Set up a click handler on the sidenote wrapper to select only the text content,
	 * not the HTML tags, when clicked in the editor.
	 */
	private setupSidenoteClickHandler(
		wrapper: HTMLElement,
		sidenoteText: string,
	) {
		wrapper.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			if (target.closest(".sidenote-margin")) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();

			const view = this.getMarkdownView();
			if (!view?.editor) return;

			const editor = view.editor;

			const found = this.findHtmlSidenoteInSource(sidenoteText);
			if (found) {
				const openingTagEnd = found.openingTag.length;
				const textStart = found.index + openingTagEnd;
				const textEnd = textStart + found.text.length;

				const from = editor.offsetToPos(textStart);
				const to = editor.offsetToPos(textEnd);

				editor.setSelection(from, to);
				editor.focus();
			}
		});
	}

	// ==================== Margin Editing ====================

	/**
	 * Set up a margin element to be editable in place.
	 * When clicked, it becomes editable. On blur, changes are saved to the source.
	 */
	private setupMarginEditing(
		margin: HTMLElement,
		sourceSpan: HTMLElement,
		docPos: number | null,
		sidenoteIndex: number,
	) {
		margin.dataset.editing = "false";
		margin.dataset.sidenoteIndex = String(sidenoteIndex);

		const onMouseDown = (e: MouseEvent) => {
			// When editing, allow normal mousedown behavior for cursor positioning
			if (margin.dataset.editing === "true") {
				// Don't stop propagation or prevent default - let browser handle cursor
				return;
			}
			e.stopPropagation();
			e.preventDefault();
		};

		const onClick = (e: MouseEvent) => {
			// When editing, allow normal click behavior
			if (margin.dataset.editing === "true") {
				e.stopPropagation(); // Still prevent clicks from bubbling to parent elements
				return;
			}

			e.preventDefault();
			e.stopPropagation();
			this.startMarginEdit(margin, sourceSpan, sidenoteIndex, e);
		};

		margin.addEventListener("mousedown", onMouseDown);
		margin.addEventListener("click", onClick);

		// Store cleanup reference on the element for later removal
		(margin as SidenoteMarginElement)._sidenoteCleanup = () => {
			margin.removeEventListener("mousedown", onMouseDown);
			margin.removeEventListener("click", onClick);
		};
	}

	/**
	 * Start editing a margin sidenote in place.
	 */
	private startMarginEdit(
		margin: HTMLElement,
		sourceSpan: HTMLElement,
		_sidenoteIndex: number,
		clickEvent?: MouseEvent,
	) {
		if (this.spanCmView) return;

		// Read current text from source by matching content
		const marginText = margin.textContent ?? "";
		const found = this.findHtmlSidenoteInSource(marginText);
		this.spanOriginalText = found?.text ?? sourceSpan.textContent ?? "";

		margin.dataset.editing = "true";
		margin.innerHTML = "";

		const commitAndClose = (opts: { commit: boolean }) => {
			const cmInner = this.spanCmView;
			if (!cmInner) return;

			const newText = cmInner.state.doc.toString();
			const renderText = opts.commit ? newText : this.spanOriginalText;

			if (this.spanOutsidePointerDown) {
				document.removeEventListener(
					"pointerdown",
					this.spanOutsidePointerDown,
					true,
				);
				this.spanOutsidePointerDown = undefined;
			}

			this.spanCmView = null;
			cmInner.destroy();

			margin.dataset.editing = "false";

			if (opts.commit && newText !== this.spanOriginalText) {
				this.commitHtmlSpanSidenoteText(this.spanOriginalText, newText);
			}

			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(renderText)),
			);

			// Margin height changed (editor -> rendered text); restack.
			this.scheduleCollisionUpdate();
		};

		// Keymap: ESC cancels; Enter commits; Shift-Enter inserts newline (optional)
		const closeKeymap = keymap.of([
			{
				key: "Escape",
				run: () => {
					commitAndClose({ commit: false });
					return true;
				},
				preventDefault: true,
			},
			{
				key: "Enter",
				run: () => {
					commitAndClose({ commit: true });
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
			doc: this.spanOriginalText,
			extensions: [
				closeKeymap,
				sidenoteEditorTheme,
				history(),
				markdown(),
				syntaxHighlighting(sidenoteHighlightStyle, { fallback: true }),
				// Your markdown formatting hotkeys (Mod-b/i/k) if you added them:
				markdownEditHotkeys,
				// Keep standard CM key behavior (arrow keys, delete, etc.)
				keymap.of(historyKeymap),
				keymap.of(defaultKeymap),
				EditorView.lineWrapping,
			],
		});

		const cm = new EditorView({
			state,
			parent: margin,
		});

		cm.dom.addEventListener(
			"focusin",
			() => {
				setWorkspaceActiveEditor(this, cm);
			},
			true,
		);

		cm.dom.addEventListener(
			"focusout",
			() => {
				setWorkspaceActiveEditor(this, null);
			},
			true,
		);

		this.spanCmView = cm;
		cm.dom.classList.add("sidenote-cm-editor");
		const scroller = cm.dom.querySelector<HTMLElement>(".cm-scroller");
		if (scroller) {
			setCssProps(scroller, { "padding-left": "0", padding: "0" }, true);
		}

		// Click anywhere outside the margin editor => commit and close
		this.spanOutsidePointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (margin.contains(target) || cm.dom.contains(target)) return;

			commitAndClose({ commit: true });
		};
		document.addEventListener(
			"pointerdown",
			this.spanOutsidePointerDown,
			true,
		);

		window.requestAnimationFrame(() => cm.focus());
	}

	private commitHtmlSpanSidenoteText(
		originalText: string,
		newText: string,
	) {
		const view = this.getMarkdownView();
		if (!view?.editor) return;

		const editor = view.editor;

		const scroller =
			this.cmRoot?.querySelector<HTMLElement>(".cm-scroller");
		const scrollTop = scroller?.scrollTop ?? 0;

		this.isEditingMargin = true;

		const content = editor.getValue();
		const regex = SIDENOTE_SPAN_REGEX();
		let match: RegExpExecArray | null;

		while ((match = regex.exec(content)) !== null) {
			if (match[1] === originalText) {
				const from = editor.offsetToPos(match.index);
				const to = editor.offsetToPos(match.index + match[0].length);

				const originalTag = match[0].substring(
					0,
					match[0].indexOf(">") + 1,
				);
				const newSpan = `${originalTag}${newText}</span>`;

				this.isMutating = true;
				try {
					editor.replaceRange(newSpan, from, to);
				} finally {
					this.isMutating = false;
				}
				break;
			}
		}

		if (scroller) scroller.scrollTop = scrollTop;
		this.isEditingMargin = false;
	}

	private commitFootnoteSidenoteText(footnoteId: string, newText: string) {
		const view = this.getMarkdownView();
		if (!view?.editor) return;

		const editor = view.editor;
		const content = editor.getValue();

		const defRegex = new RegExp(
			`^(\\[\\^${footnoteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]:\\s*)(.*)$`,
			"m",
		);
		const match = content.match(defRegex);
		if (!match || match.index === undefined || !match[1]) return;

		const from = editor.offsetToPos(match.index + match[1].length);
		const to = editor.offsetToPos(match.index + match[0].length);

		this.isMutating = true;
		try {
			editor.replaceRange(newText, from, to);
		} finally {
			this.isMutating = false;
		}
	}

	public commitFootnoteSidenoteTextPublic(
		footnoteId: string,
		newText: string,
	) {
		this.commitFootnoteSidenoteText(footnoteId, newText);
	}

	// ==================== Collision Avoidance ====================

	/**
	 * Schedule collision resolution for whichever root(s) currently hold margins.
	 *
	 * Uses its own rAF handle: `rafId` belongs to scheduleLayout, and gating on
	 * it meant a pending layout silently dropped the collision request instead
	 * of deferring it, leaving sidenotes stacked on top of each other.
	 */
	public scheduleCollisionUpdate() {
		if (this.collisionRafId !== null) return;

		this.collisionRafId = window.requestAnimationFrame(() => {
			this.collisionRafId = null;
			this.updateAllCollisions();
		});
	}

	/**
	 * Resolve collisions in both editing and reading roots.
	 *
	 * Callers (the visibility observer, margin resize observer, inline editors)
	 * don't reliably know which mode the margins they care about live in, and
	 * running against an empty root is a cheap no-op.
	 */
	private updateAllCollisions() {
		this.updateEditingModeCollisions();
		this.updateReadingModeCollisions();
	}

	/**
	 * Update collisions in editing mode (source view).
	 */
	private updateEditingModeCollisions() {
		if (!this.cmRoot?.isConnected) return;

		const margins = Array.from(
			this.cmRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);
		if (margins.length === 0) return;

		resolveCollisionsBySide(
			margins,
			this.settings.collisionSpacing,
			this.settings.sidenotePosition,
		);
	}

	/**
	 * Update collisions in reading mode.
	 */
	private updateReadingModeCollisions() {
		const view = this.getMarkdownView();
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (!readingRoot) return;

		const margins = Array.from(
			readingRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);
		if (margins.length === 0) return;

		resolveCollisionsBySide(
			margins,
			this.settings.collisionSpacing,
			this.settings.sidenotePosition,
		);
	}

	/**
	 * Run collision avoidance specifically for reading mode sidenotes.
	 * This is called after processing sidenotes in reading mode.
	 * @param readingRoot The root element of the reading view to search for margins
	 */
	private avoidCollisionsInReadingMode(readingRoot: HTMLElement) {
		if (!readingRoot?.isConnected) return;

		const margins = Array.from(
			readingRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);

		resolveCollisionsBySide(
			margins,
			this.settings.collisionSpacing,
			this.settings.sidenotePosition,
		);
	}

	// ==================== Markdown Formatting ====================

	/**
	 * Apply markdown formatting to the current selection or cursor position in a contenteditable element.
	 * @param element The contenteditable element
	 * @param prefix The prefix to add (e.g., "**" for bold, "*" for italic)
	 * @param suffix The suffix to add (defaults to prefix)
	 * @param linkMode If true, handle as a link with [text](url) format
	 */
	private applyMarkdownFormatting(
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

		// Calculate the start offset within the full text
		let startOffset = 0;
		let endOffset = 0;

		// Walk through text nodes to find the actual offsets
		const walker = document.createTreeWalker(
			element,
			NodeFilter.SHOW_TEXT,
			null,
		);
		let currentOffset = 0;
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
		}
		if (!foundEnd && range.endContainer === element) {
			endOffset = 0;
			for (
				let i = 0;
				i < range.endOffset && i < element.childNodes.length;
				i++
			) {
				endOffset += element.childNodes[i]?.textContent?.length ?? 0;
			}
		}

		// Build the new text
		let newText: string;
		let newCursorStart: number;
		let newCursorEnd: number;

		if (linkMode) {
			const linkText = selectedText || "link text";
			const replacement = `[${linkText}](url)`;
			newText =
				fullText.slice(0, startOffset) +
				replacement +
				fullText.slice(endOffset);
			// Select "url"
			newCursorStart = startOffset + 1 + linkText.length + 2; // [linkText](
			newCursorEnd = newCursorStart + 3; // url
		} else if (selectedText) {
			// Wrap selection
			const replacement = `${prefix}${selectedText}${suffix}`;
			newText =
				fullText.slice(0, startOffset) +
				replacement +
				fullText.slice(endOffset);
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
		window.requestAnimationFrame(() => {
			element.focus();
			const sel = window.getSelection();
			if (!sel) return;

			const textNode = element.firstChild;
			if (!textNode) return;

			try {
				const newRange = document.createRange();
				newRange.setStart(
					textNode,
					Math.min(newCursorStart, newText.length),
				);
				newRange.setEnd(textNode, Math.min(newCursorEnd, newText.length));
				sel.removeAllRanges();
				sel.addRange(newRange);
			} catch (e) {
				// Fallback - place at end
				console.error("Error setting cursor position:", e);
				const fallbackRange = document.createRange();
				fallbackRange.selectNodeContents(element);
				fallbackRange.collapse(false);
				sel.removeAllRanges();
				sel.addRange(fallbackRange);
			}
		});
	}

	/**
	 * Public version for widget to use.
	 * @param element The contenteditable element
	 * @param prefix The prefix to add (e.g., "**" for bold, "*" for italic)
	 * @param suffix The suffix to add (defaults to prefix)
	 * @param linkMode If true, handle as a link with [text](url) format
	 */
	public applyMarkdownFormattingPublic(
		element: HTMLElement,
		prefix: string,
		suffix: string = prefix,
		linkMode: boolean = false,
	) {
		this.applyMarkdownFormatting(element, prefix, suffix, linkMode);
	}

	/**
	 * Insert markdown wrapper (like ** for bold, * for italic) around the
	 * current selection in a contentEditable element, or at cursor if no selection.
	 * Uses manual text manipulation to maintain plain-text editing.
	 */
	private insertMarkdownWrapper(element: HTMLElement, wrapper: string) {
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
		const offsets = this.getSelectionOffsets(element, range);
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
		window.requestAnimationFrame(() => {
			element.focus();
			const sel = window.getSelection();
			if (!sel || !element.firstChild) return;
			try {
				const newRange = document.createRange();
				newRange.setStart(
					element.firstChild,
					Math.min(cursorStart, newText.length),
				);
				newRange.setEnd(
					element.firstChild,
					Math.min(cursorEnd, newText.length),
				);
				sel.removeAllRanges();
				sel.addRange(newRange);
			} catch (e) {
				// Fallback
				console.error("Sidenotes - Error setting cursor position:", e);
			}
		});
	}

	/**
	 * Insert a markdown link at the current cursor/selection in a contentEditable element.
	 */
	private insertMarkdownLink(element: HTMLElement) {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;

		const range = selection.getRangeAt(0);
		if (
			!element.contains(range.startContainer) ||
			!element.contains(range.endContainer)
		)
			return;

		const fullText = element.textContent || "";
		const offsets = this.getSelectionOffsets(element, range);
		if (!offsets) return;

		const { start, end } = offsets;
		const selectedText = fullText.slice(start, end);

		const linkText = selectedText || "link text";
		const replacement = `[${linkText}](url)`;

		const newText =
			fullText.slice(0, start) + replacement + fullText.slice(end);

		// Position cursor to select "url"
		const urlStart = start + 1 + linkText.length + 2; // [linkText](
		const urlEnd = urlStart + 3; // url

		element.textContent = newText;

		window.requestAnimationFrame(() => {
			element.focus();
			const sel = window.getSelection();
			if (!sel || !element.firstChild) return;
			try {
				const newRange = document.createRange();
				newRange.setStart(
					element.firstChild,
					Math.min(urlStart, newText.length),
				);
				newRange.setEnd(
					element.firstChild,
					Math.min(urlEnd, newText.length),
				);
				sel.removeAllRanges();
				sel.addRange(newRange);
			} catch (e) {
				console.error("Sidenotes - Error setting cursor position:", e);
				// Fallback
			}
		});
	}

	//
	/**
	 * Render markdown-formatted text to a DocumentFragment.
	 * Supports: **bold**, *italic*, _italic_, `code`, [links](url), and [[wiki links]]
	 * @param text The markdown-formatted text to render
	 */
	private renderLinksToFragment(text: string): DocumentFragment {
		return renderLinksToFragment(text, this.app);
	}

	// ==================== Keyboard Handling for Margin Editing ====================
	/**
	 * Get the start and end character offsets of the current selection
	 * within a contentEditable element's text content.
	 * @param element The contentEditable element
	 * @param range The current selection range
	 */
	private getSelectionOffsets(
		element: HTMLElement,
		range: Range,
	): { start: number; end: number } | null {
		const walker = document.createTreeWalker(
			element,
			NodeFilter.SHOW_TEXT,
			null,
		);
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
			for (
				let i = 0;
				i < range.endOffset && i < element.childNodes.length;
				i++
			) {
				endOffset += element.childNodes[i]?.textContent?.length ?? 0;
			}
			foundEnd = true;
		}

		if (!foundStart || !foundEnd) return null;
		return { start: startOffset, end: endOffset };
	}

	/**
	 * Set up keyboard interception that prevents CM6 from seeing ANY key events
	 * while a margin is being edited.
	 *
	 * We attach a capture-phase listener on the .cm-editor element itself
	 * and call stopImmediatePropagation to prevent CM6's own handlers from firing.
	 * We also attach on document as a fallback for reading mode (where there's no CM6).
	 *
	 * Returns a cleanup function.
	 * @param margin The margin element being edited
	 */
	private setupMarginKeyboardCapture(margin: HTMLElement): () => void {
		this.setCurrentlyEditingMargin(margin);

		const handler = (e: KeyboardEvent) => {
			if (margin.contentEditable !== "true") return;
			if (
				document.activeElement !== margin &&
				!margin.contains(document.activeElement)
			)
				return;

			const isMod = e.metaKey || e.ctrlKey;

			if (e.key === "Escape") {
				e.preventDefault();
				e.stopImmediatePropagation();
				margin.dataset.cancelled = "true";
				margin.blur();
				return;
			}

			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				e.stopImmediatePropagation();
				margin.blur();
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "b" &&
				!e.shiftKey &&
				!e.altKey
			) {
				// console.warn("BOLD shortcut detected");
				e.preventDefault();
				e.stopImmediatePropagation();
				this.insertMarkdownWrapper(margin, "**");
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "i" &&
				!e.shiftKey &&
				!e.altKey
			) {
				// console.warn("ITALICS shortcut detected");
				e.preventDefault();
				e.stopImmediatePropagation();
				this.insertMarkdownWrapper(margin, "*");
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "k" &&
				!e.shiftKey &&
				!e.altKey
			) {
				e.preventDefault();
				e.stopImmediatePropagation();
				this.insertMarkdownLink(margin);
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "a" &&
				!e.shiftKey &&
				!e.altKey
			) {
				e.preventDefault();
				e.stopImmediatePropagation();
				const selection = window.getSelection();
				const range = document.createRange();
				range.selectNodeContents(margin);
				selection?.removeAllRanges();
				selection?.addRange(range);
				return;
			}

			if (isMod && e.key.toLowerCase() === "z") {
				e.stopImmediatePropagation();
				return;
			}

			if (
				["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
			) {
				e.stopImmediatePropagation();

				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) return;
				const range = selection.getRangeAt(0);

				const atStart =
					range.collapsed &&
					range.startOffset === 0 &&
					(range.startContainer === margin ||
						range.startContainer === margin.firstChild);

				let atEnd = false;
				if (range.collapsed) {
					if (range.startContainer === margin) {
						atEnd = range.startOffset === margin.childNodes.length;
					} else if (range.startContainer.nodeType === Node.TEXT_NODE) {
						const len = range.startContainer.textContent?.length ?? 0;
						atEnd =
							range.startOffset === len &&
							(range.startContainer === margin.lastChild ||
								range.startContainer.parentNode === margin);
					}
				}

				if (atStart && e.key === "ArrowLeft") {
					e.preventDefault();
					return;
				}
				if (atEnd && e.key === "ArrowRight") {
					e.preventDefault();
					return;
				}

				if (e.key === "ArrowUp" || e.key === "ArrowDown") {
					const cursorRect = range.getBoundingClientRect();
					const marginRect = margin.getBoundingClientRect();
					const lh = parseFloat(getComputedStyle(margin).lineHeight) || 20;
					if (
						e.key === "ArrowUp" &&
						cursorRect.top - marginRect.top < lh
					) {
						e.preventDefault();
						return;
					}
					if (
						e.key === "ArrowDown" &&
						marginRect.bottom - cursorRect.bottom < lh
					) {
						e.preventDefault();
						return;
					}
				}
				return;
			}

			// Block ALL other keys from reaching Obsidian/CM6
			e.stopImmediatePropagation();
		};

		// CRITICAL: Attach to window (not document, not cm-editor) in capture phase.
		// Capture flows: window → document → ... → element.
		// Obsidian's hotkey system registers on document, so window fires first.
		window.addEventListener("keydown", handler, true);

		return () => {
			window.removeEventListener("keydown", handler, true);
			this.setCurrentlyEditingMargin(null);
		};
	}

	public setupMarginKeyboardCapturePublic(
		margin: HTMLElement,
	): () => void {
		return this.setupMarginKeyboardCapture(margin);
	}

	/**
	 * Attach a context menu to a sidenote margin element with options to edit or delete the sidenote.
	 * This is currently unused
	 * @param margin The margin element to attach the context menu to
	 * @param opts Options for the context menu actions
	 */
	private attachSidenoteContextMenu(
		margin: HTMLElement,
		opts: {
			onEdit?: () => void;
			onDelete?: () => void;
		},
	) {
		margin.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();

			const menu = new Menu();

			if (opts.onEdit) {
				menu.addItem((item) =>
					item
						.setTitle("Edit sidenote")
						.setIcon("pencil")
						.onClick(() => opts.onEdit!()),
				);
			}

			if (opts.onDelete) {
				menu.addItem((item) =>
					item
						.setTitle("Delete sidenote")
						.setIcon("trash")
						.onClick(() => opts.onDelete!()),
				);
			}

			menu.showAtMouseEvent(e);
		});
	}

	/**
	 * Convert a margin note wrapper to popup mode:
	 * hide the margin, show an ⓘ icon inline, and display
	 * content in a small popup on click.
	 */
	private setupMarginNotePopup(
		wrapper: HTMLElement,
		margin: HTMLElement,
		contentText: string,
		editable: boolean = false,
		footnoteId?: string,
	) {
		wrapper.classList.add("popup-mode");
		margin.classList.add("popup-mode-margin");

		margin.innerHTML = "";
		const icon = createSpan();
		icon.className = "margin-note-icon";
		icon.setAttribute("aria-label", "Show margin note");

		const iconSetting = this.settings.popupIcon || "ⓘ";

		if (
			iconSetting.endsWith(".png") ||
			iconSetting.endsWith(".svg") ||
			iconSetting.endsWith(".jpg")
		) {
			// Image file from plugin assets folder
			const img = createEl("img");
			img.src = this.app.vault.adapter.getResourcePath(
				`${this.manifest.dir}/assets/${iconSetting}`,
			);
			img.className = "margin-note-icon-img";
			icon.appendChild(img);
		} else {
			// Unicode character
			icon.textContent = iconSetting;
		}

		margin.appendChild(icon);

		const popup = createDiv();
		popup.className = "margin-note-popup";

		const closeBtn = createSpan();
		closeBtn.className = "margin-note-popup-close";
		closeBtn.textContent = "✕";
		closeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			popup.classList.remove("is-visible");
		});
		popup.appendChild(closeBtn);

		const contentEl = createDiv();
		contentEl.className = "margin-note-popup-content";

		let currentRawText = contentText;

		if (editable) {
			let popupCmView: EditorView | null = null;
			let isEditing = false;

			const renderReadOnly = () => {
				contentEl.innerHTML = "";
				contentEl.appendChild(
					this.renderLinksToFragment(this.normalizeText(currentRawText)),
				);
				contentEl.classList.add("margin-note-popup-content--readable");
				isEditing = false;
			};

			const commitAndClosePopup = (commit: boolean) => {
				if (!popupCmView) return;
				const newText = popupCmView.state.doc.toString();
				if (commit && newText !== currentRawText) {
					if (footnoteId) {
						this.commitFootnoteSidenoteText(footnoteId, newText);
					} else {
						this.commitHtmlSpanSidenoteText(currentRawText, newText);
					}
					currentRawText = newText;
				}
				popupCmView.destroy();
				popupCmView = null;
				isEditing = false;
				contentEl.innerHTML = "";
				popup.classList.remove("is-visible");
			};

			const openEditor = () => {
				if (popupCmView) {
					popupCmView.destroy();
					popupCmView = null;
				}
				contentEl.innerHTML = "";
				isEditing = true;

				const closeKeymap = keymap.of([
					{
						key: "Escape",
						run: () => {
							commitAndClosePopup(false);
							return true;
						},
						preventDefault: true,
					},
					{
						key: "Enter",
						run: () => {
							commitAndClosePopup(true);
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
					doc: currentRawText,
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

				popupCmView = new EditorView({
					state,
					parent: contentEl,
				});

				popupCmView.dom.classList.add("sidenote-cm-editor");

				popupCmView.dom.addEventListener(
					"focusin",
					() => {
						setWorkspaceActiveEditor(this, popupCmView);
					},
					true,
				);

				popupCmView.dom.addEventListener(
					"focusout",
					() => {
						setWorkspaceActiveEditor(this, null);
					},
					true,
				);

				popupCmView.dom.addEventListener("keydown", (e) => {
					e.stopPropagation();
				});

				const scroller =
					popupCmView.dom.querySelector<HTMLElement>(".cm-scroller");
				if (scroller) {
					setCssProps(
						scroller,
						{ "padding-left": "0", padding: "0" },
						true,
					);
				}

				window.requestAnimationFrame(() => popupCmView?.focus());
			};

			// Click on content: if clicking a link, let it open; otherwise start editing
			contentEl.addEventListener("click", (e) => {
				if (isEditing) return;

				const target = e.target as HTMLElement;
				if (target.tagName === "A" || target.closest("a")) {
					// Let the link open naturally
					return;
				}

				e.preventDefault();
				e.stopPropagation();
				openEditor();
			});

			// Listen for links being clicked, close popup when that happens
			contentEl.addEventListener(
				"click",
				(e) => {
					const target = e.target as HTMLElement;
					if (target.tagName === "A" || target.closest("a")) {
						// Close popup when a link is clicked
						popup.classList.remove("is-visible");
					}
				},
				true,
			);

			contentEl.addEventListener("mousedown", (e) => {
				e.stopPropagation();
			});

			icon.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();

				const isVisible = popup.classList.contains("is-visible");

				document
					.querySelectorAll(".margin-note-popup.is-visible")
					.forEach((el) => el.classList.remove("is-visible"));

				if (!isVisible) {
					const iconRect = icon.getBoundingClientRect();
					popup.style.top = `${iconRect.bottom + window.scrollY + 4}px`;
					popup.style.left = `${iconRect.left + window.scrollX}px`;
					popup.classList.add("is-visible");
					renderReadOnly();
				} else {
					if (popupCmView) {
						commitAndClosePopup(true);
					} else {
						popup.classList.remove("is-visible");
					}
				}
			});

			icon.addEventListener("mousedown", (e) => {
				e.stopPropagation();
			});

			const onOutsideClick = (e: MouseEvent) => {
				if (
					!popup.contains(e.target as Node) &&
					!icon.contains(e.target as Node)
				) {
					if (popupCmView) {
						commitAndClosePopup(true);
					} else {
						popup.classList.remove("is-visible");
					}
				}
			};
			document.addEventListener("click", onOutsideClick, true);

			(
				wrapper as HTMLElement & { _popupCleanup?: () => void }
			)._popupCleanup = () => {
				document.removeEventListener("click", onOutsideClick, true);
				if (popupCmView) {
					popupCmView.destroy();
					popupCmView = null;
				}
				popup.remove();
			};

			popup.appendChild(contentEl);
			document.body.appendChild(popup);
			return;
		}

		// Read-only path
		contentEl.appendChild(
			this.renderLinksToFragment(this.normalizeText(contentText)),
		);

		popup.appendChild(contentEl);
		document.body.appendChild(popup);

		icon.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();

			const isVisible = popup.classList.contains("is-visible");

			document
				.querySelectorAll(".margin-note-popup.is-visible")
				.forEach((el) => el.classList.remove("is-visible"));

			if (!isVisible) {
				const iconRect = icon.getBoundingClientRect();
				popup.style.top = `${iconRect.bottom + window.scrollY + 4}px`;
				popup.style.left = `${iconRect.left + window.scrollX}px`;
				popup.classList.add("is-visible");
			}
		});

		icon.addEventListener("mousedown", (e) => {
			e.stopPropagation();
		});

		const onOutsideClick = (e: MouseEvent) => {
			if (
				!popup.contains(e.target as Node) &&
				!icon.contains(e.target as Node)
			) {
				popup.classList.remove("is-visible");
			}
		};
		document.addEventListener("click", onOutsideClick, true);

		(
			wrapper as HTMLElement & { _popupCleanup?: () => void }
		)._popupCleanup = () => {
			document.removeEventListener("click", onOutsideClick, true);
			popup.remove();
		};
	}
}
