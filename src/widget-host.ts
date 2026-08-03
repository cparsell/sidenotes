import type { App, PluginManifest } from "obsidian";
import type { SidenoteSettings } from "./settings";

/**
 * The plugin surface the CM6 widgets in `widgets.ts` are allowed to touch.
 *
 * This is deliberately an interface rather than a snapshot object like
 * `PrintExportContext`: the ViewPlugin is constructed once per editor and
 * outlives any single call, so it must read *current* values. In particular
 * it compares `settingsVersion` on every `update()` to decide whether to
 * rebuild decorations — freezing that in a snapshot would silently break the
 * settings-change refresh path.
 *
 * `SidenotePlugin implements SidenoteWidgetHost`, so TypeScript enforces that
 * this stays the whole boundary. Anything a widget needs has to be added here
 * explicitly, which is what stops the `*Public` shim layer from regrowing.
 */
export interface SidenoteWidgetHost {
	readonly app: App;
	readonly manifest: PluginManifest;
	readonly settings: SidenoteSettings;

	/** Bumped on every settings save to signal that decorations must rebuild. */
	readonly settingsVersion: number;

	/** Set when an edit in one mode invalidates the other mode's render. */
	needsReadingModeRefresh: boolean;

	/** Footnote-edit arbitration — only one inline editor may be open. */
	setActiveFootnoteEdit(footnoteId: string | null): void;
	isFootnoteBeingEdited(): boolean;

	/** Register/unregister a margin with the visibility and resize observers. */
	observeSidenoteVisibility(margin: HTMLElement): void;
	unobserveSidenoteVisibility(margin: HTMLElement): void;

	/** Re-stack margins after one changes height. */
	scheduleCollisionUpdate(): void;

	/** Re-read the source text into the cache after a write-back. */
	refreshCachedSourceContent(): void;

	/** Convert a margin note into an inline icon plus a click-to-open popup. */
	setupMarginNotePopup(
		wrapper: HTMLElement,
		margin: HTMLElement,
		contentText: string,
		editable?: boolean,
		footnoteId?: string,
	): void;
}
