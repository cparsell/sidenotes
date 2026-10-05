/**
 * Embeds inside sidenotes: `![[file|size]]` and `![alt](path)`.
 *
 * Images, audio and video resolve synchronously to a media element. Notes are
 * rendered with `MarkdownRenderer`, which is async and needs a Component to
 * own whatever it mounts, so the placeholder is returned immediately and
 * filled in afterwards.
 */

import {
	Keymap,
	MarkdownRenderChild,
	MarkdownRenderer,
	resolveSubpath,
	setIcon,
} from "obsidian";
import type { App, Component, TFile } from "obsidian";

/** Media types that can be embedded synchronously via a resource URL. */
const EMBED_TAGS: Record<string, "img" | "audio" | "video"> = {
	png: "img",
	jpg: "img",
	jpeg: "img",
	gif: "img",
	webp: "img",
	svg: "img",
	avif: "img",
	bmp: "img",
	mp3: "audio",
	wav: "audio",
	ogg: "audio",
	m4a: "audio",
	flac: "audio",
	mp4: "video",
	webm: "video",
	mov: "video",
};

/** Class on a rendered note embed; the post-processor skips anything inside. */
export const NOTE_EMBED_CLASS = "sidenote-embed-note";

/**
 * Owns the render children of note embeds. Set once from the plugin's
 * `onload`, so margins that are cleared and rebuilt in many places don't each
 * have to thread a Component through to the renderer.
 */
let embedOwner: Component | null = null;

interface LiveEmbed {
	child: MarkdownRenderChild;
	el: HTMLElement;
	/** Set once the element has been attached; a detached one is garbage. */
	wasConnected: boolean;
}
const liveEmbeds = new Set<LiveEmbed>();

export function setEmbedOwner(owner: Component | null) {
	if (!owner) releaseAllEmbeds();
	embedOwner = owner;
}

/** Unload the children of embeds that were removed from the DOM. */
function sweepDetachedEmbeds() {
	for (const live of Array.from(liveEmbeds)) {
		if (live.el.isConnected) {
			live.wasConnected = true;
		} else if (live.wasConnected) {
			live.child.unload();
			liveEmbeds.delete(live);
		}
	}
}

function releaseAllEmbeds() {
	for (const live of liveEmbeds) live.child.unload();
	liveEmbeds.clear();
}

/**
 * Render an embed. Media becomes a media element, a note becomes a
 * placeholder filled by `MarkdownRenderer`, and anything else (unresolved,
 * pdf) falls back to an internal link.
 */
export function renderEmbed(
	app: App,
	target: string,
	alias: string | undefined,
	sourcePath: string,
	raw: string,
): Node {
	const [linkpath = target, subpath] = splitSubpath(target);
	const file = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
	const ext = file?.extension.toLowerCase();
	const tag = ext ? EMBED_TAGS[ext] : undefined;

	if (file && tag) {
		const el = createEl(tag);
		el.classList.add("sidenote-embed");
		el.src = app.vault.getResourcePath(file);
		if (tag !== "img") (el as HTMLMediaElement).controls = true;

		// "|300" or "|300x200" sets the size; anything else is alt text
		const size = alias?.match(/^(\d+)(?:x(\d+))?$/);
		if (size) {
			el.setAttribute("width", size[1] as string);
			if (size[2]) el.setAttribute("height", size[2]);
		} else if (alias && tag === "img") {
			el.setAttribute("alt", alias);
		}
		return el;
	}

	if (file && ext === "md" && embedOwner) {
		return renderNoteEmbed(app, file, subpath, sourcePath, embedOwner);
	}

	return renderFallbackLink(app, target, alias, sourcePath, raw);
}

function splitSubpath(target: string): [string, string | undefined] {
	const i = target.indexOf("#");
	return i === -1
		? [target, undefined]
		: [target.slice(0, i), target.slice(i)];
}

function renderNoteEmbed(
	app: App,
	file: TFile,
	subpath: string | undefined,
	sourcePath: string,
	owner: Component,
): HTMLElement {
	sweepDetachedEmbeds();

	// The wrapper doesn't scroll, so the open button stays put while the
	// content inside it does.
	const wrap = createDiv({ cls: `sidenote-embed ${NOTE_EMBED_CLASS}` });
	const content = wrap.createDiv({
		cls: "sidenote-embed-note-content markdown-rendered",
	});

	const open = wrap.createEl("a", {
		cls: "sidenote-embed-open",
		attr: { "aria-label": "Open note", role: "button" },
	});
	setIcon(open, "link");
	open.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		void app.workspace.openLinkText(
			file.path + (subpath ?? ""),
			sourcePath,
			Keymap.isModEvent(e),
		);
	});

	const child = new MarkdownRenderChild(wrap);
	const live: LiveEmbed = { child, el: wrap, wasConnected: false };
	liveEmbeds.add(live);
	owner.addChild(child);

	void (async () => {
		try {
			const markdown = sliceBySubpath(
				app,
				file,
				await app.vault.cachedRead(file),
				subpath,
			);
			await MarkdownRenderer.render(
				app,
				markdown,
				content,
				file.path,
				child,
			);
		} catch (error) {
			console.error("Sidenote plugin: failed to render note embed", error);
			content.setText(file.basename);
		}
	})();

	return wrap;
}

/** Narrow a note's text to a `#Heading` or `#^block` subpath, if given. */
function sliceBySubpath(
	app: App,
	file: TFile,
	markdown: string,
	subpath: string | undefined,
): string {
	if (!subpath) return tidyEmbedMarkdown(markdown);
	const cache = app.metadataCache.getFileCache(file);
	const hit = cache ? resolveSubpath(cache, subpath) : null;
	if (!hit) return tidyEmbedMarkdown(markdown);
	return tidyEmbedMarkdown(
		markdown.slice(hit.start.offset, hit.end?.offset ?? markdown.length),
	);
}

/**
 * Drop what would only add dead space at the top of a narrow margin:
 * frontmatter (Obsidian's own embeds don't show properties), leading blank
 * lines, and runs of blank lines, which render as empty paragraphs.
 */
function tidyEmbedMarkdown(markdown: string): string {
	return markdown
		.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
		.replace(/(\r?\n){3,}/g, "\n\n")
		.trim();
}

/** Link to the target, without the stray "!" a plain-text embed would show. */
function renderFallbackLink(
	app: App,
	target: string,
	alias: string | undefined,
	sourcePath: string,
	raw: string,
): HTMLElement {
	const a = createEl("a");
	a.textContent = alias && !/^\d+(x\d+)?$/.test(alias) ? alias : target;
	a.className = "internal-link";
	a.setAttribute("data-href", target);
	a.title = raw;
	a.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		void app.workspace.openLinkText(target, sourcePath, false);
	});
	return a;
}
