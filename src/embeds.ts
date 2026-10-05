/**
 * Embeds inside sidenotes: `![[file|size]]` and `![alt](path)`.
 *
 * Images, audio and video resolve synchronously to a media element. Notes are
 * rendered with `MarkdownRenderer`, which is async and needs a Component to
 * own whatever it mounts, so the placeholder is returned immediately and
 * filled in afterwards.
 */

import {
	MarkdownRenderChild,
	MarkdownRenderer,
	resolveSubpath,
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
		return renderNoteEmbed(app, file, subpath, embedOwner);
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
	owner: Component,
): HTMLElement {
	sweepDetachedEmbeds();

	const el = createDiv({
		cls: `sidenote-embed ${NOTE_EMBED_CLASS} markdown-rendered`,
	});
	const child = new MarkdownRenderChild(el);
	const live: LiveEmbed = { child, el, wasConnected: false };
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
			await MarkdownRenderer.render(app, markdown, el, file.path, child);
		} catch (error) {
			console.error("Sidenote plugin: failed to render note embed", error);
			el.setText(file.basename);
		}
	})();

	return el;
}

/** Narrow a note's text to a `#Heading` or `#^block` subpath, if given. */
function sliceBySubpath(
	app: App,
	file: TFile,
	markdown: string,
	subpath: string | undefined,
): string {
	if (!subpath) return markdown;
	const cache = app.metadataCache.getFileCache(file);
	const hit = cache ? resolveSubpath(cache, subpath) : null;
	if (!hit) return markdown;
	return markdown.slice(hit.start.offset, hit.end?.offset ?? markdown.length);
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
