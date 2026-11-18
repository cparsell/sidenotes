/**
 * Citation rendering for sidenote text.
 *
 * Rendering is synchronous (it runs inside `renderLinksToFragment`) but
 * reading a bibliography file is not. So the first render that needs a file
 * shows the citation as written, starts the load, and asks the plugin to
 * re-render once it lands. After that, lookups are plain map reads.
 *
 * Display only: nothing here touches the note's source text.
 */

import { Notice, normalizePath, setTooltip } from 'obsidian'
import type { App } from 'obsidian'
import type { SidenoteSettings } from '../settings'
import { type BibEntry, parseBibliography } from './bibliography'
import { formatFullReference, formatShortCitation } from './format'
import {
	BARE_CITATION_SOURCE,
	BRACKET_CITATION_SOURCE,
	type CitationItem,
	parseBareCitation,
	parseBracketCitation
} from './parse'

export interface CitationOwner {
	readonly app: App
	readonly settings: SidenoteSettings
	/** Re-render every sidenote, e.g. after a bibliography finishes loading. */
	refreshCitations(): void
}

interface LoadedBibliography {
	mtime: number
	size: number
	entries: Map<string, BibEntry>
}

let owner: CitationOwner | null = null

/** Loaded files by resolved vault path. */
const loaded = new Map<string, LoadedBibliography>()
/** requestKey → resolved vault path, or null when no such file exists. */
const resolved = new Map<string, string | null>()
const inflight = new Map<string, Promise<void>>()
const warned = new Set<string>()

export function setCitationOwner(next: CitationOwner | null) {
	owner = next
	if (!next) {
		loaded.clear()
		resolved.clear()
		inflight.clear()
		warned.clear()
	}
}

// ==================== Locating the bibliography ====================

function parentDir(path: string): string {
	const i = path.lastIndexOf('/')
	return i === -1 ? '' : path.slice(0, i)
}

function cleanPath(raw: string): string {
	return raw
		.trim()
		.replace(/^\[\[(.*?)(?:\|.*)?\]\]$/, '$1')
		.replace(/^["']|["']$/g, '')
		.trim()
}

/** The bibliography paths for a note: its `bibliography` property, else the setting. */
function requestedPaths(app: App, sourcePath: string): string[] {
	const fm = sourcePath
		? (app.metadataCache.getCache(sourcePath)?.frontmatter as
				Record<string, unknown> | undefined)
		: undefined
	const prop = fm?.['bibliography']

	const fromNote = (Array.isArray(prop) ? prop : [prop])
		.filter((p): p is string => typeof p === 'string')
		.map(cleanPath)
		.filter(Boolean)
	if (fromNote.length) return fromNote

	const fromSettings = cleanPath(owner?.settings.bibliographyPath ?? '')
	return fromSettings ? [fromSettings] : []
}

const requestKey = (path: string, sourcePath: string) =>
	`${parentDir(sourcePath)}\u0000${path}`

async function readInto(app: App, vaultPath: string): Promise<void> {
	const stat = await app.vault.adapter.stat(vaultPath)
	const text = await app.vault.adapter.read(vaultPath)
	loaded.set(vaultPath, {
		mtime: stat?.mtime ?? 0,
		size: stat?.size ?? text.length,
		entries: parseBibliography(vaultPath, text)
	})
}

/** Resolves true when a file was found and loaded. */
async function loadOne(
	app: App,
	path: string,
	sourcePath: string
): Promise<boolean> {
	const key = requestKey(path, sourcePath)
	// Vault-relative first, then relative to the note.
	const candidates = [
		normalizePath(path),
		normalizePath(`${parentDir(sourcePath)}/${path}`)
	]
	try {
		for (const candidate of candidates) {
			if (await app.vault.adapter.exists(candidate)) {
				await readInto(app, candidate)
				resolved.set(key, candidate)
				return true
			}
		}
	} catch (error) {
		console.error(
			`Side-notes: could not read bibliography "${path}"`,
			error
		)
	}
	resolved.set(key, null)
	if (!warned.has(path)) {
		warned.add(path)
		new Notice(`Side-notes: bibliography file not found: ${path}`)
	}
	return false
}

type Lookup =
	| { state: 'off' }
	| { state: 'loading' }
	| { state: 'ready'; find: (key: string) => BibEntry | undefined }

function lookup(sourcePath: string): Lookup {
	if (!owner) return { state: 'off' }
	const app = owner.app
	const paths = requestedPaths(app, sourcePath)
	if (!paths.length) return { state: 'off' }

	const maps: Map<string, BibEntry>[] = []
	let pending = false

	for (const path of paths) {
		const key = requestKey(path, sourcePath)
		if (!resolved.has(key)) {
			pending = true
			if (!inflight.has(key)) {
				const job = loadOne(app, path, sourcePath).then(found => {
					inflight.delete(key)
					// Nothing to show differently if the file wasn't there.
					if (found) owner?.refreshCitations()
				})
				inflight.set(key, job)
			}
			continue
		}
		const file = resolved.get(key)
		const entries = file ? loaded.get(file)?.entries : undefined
		if (entries) maps.push(entries)
	}

	if (pending) return { state: 'loading' }
	if (!maps.length) return { state: 'off' }
	return {
		state: 'ready',
		find: key => {
			for (const m of maps) {
				const hit = m.get(key)
				if (hit) return hit
			}
			return undefined
		}
	}
}

/**
 * Re-read any bibliography whose file changed on disk. Cheap (a stat per
 * loaded file); called when the user switches notes.
 */
export async function checkBibliographyChanges(): Promise<void> {
	const app = owner?.app
	if (!app) return

	// Forget "not found" so a file created later is picked up on next render.
	for (const [key, file] of Array.from(resolved)) {
		if (file === null) resolved.delete(key)
	}

	let changed = false
	for (const [path, entry] of Array.from(loaded)) {
		try {
			const stat = await app.vault.adapter.stat(path)
			if (!stat) {
				loaded.delete(path)
				for (const [key, file] of Array.from(resolved)) {
					if (file === path) resolved.delete(key)
				}
				changed = true
			} else if (stat.mtime !== entry.mtime || stat.size !== entry.size) {
				await readInto(app, path)
				changed = true
			}
		} catch (error) {
			console.error(`Side-notes: could not refresh "${path}"`, error)
		}
	}
	if (changed) owner?.refreshCitations()
}

// ==================== Rendering ====================

/**
 * True when `text` holds citation syntax AND citations are switched on for
 * this note. Lets a caller that would otherwise reuse Obsidian's own rendering
 * (which leaves `[@key]` as typed) choose to render from source instead.
 */
export function containsCitation(
	text: string,
	sourcePath: string
): boolean {
	if (!text.includes('@')) return false
	if (lookup(sourcePath).state === 'off') return false
	return new RegExp(
		`${BRACKET_CITATION_SOURCE}|${BARE_CITATION_SOURCE}`
	).test(text)
}

function citationEl(
	entry: BibEntry | undefined,
	item: CitationItem,
	narrative: boolean
): HTMLElement {
	if (!entry) {
		const el = createSpan({
			cls: 'sidenote-citation is-unresolved',
			text: item.raw
		})
		setTooltip(el, `No bibliography entry for "${item.key}"`)
		return el
	}
	const el = createSpan({
		cls: 'sidenote-citation',
		text: formatShortCitation(entry, {
			prefix: item.prefix,
			locator: item.locator,
			suppressAuthor: item.suppressAuthor,
			narrative
		})
	})
	el.dataset.citationKey = item.key
	setTooltip(el, formatFullReference(entry))
	return el
}

/** `[@a, 42; @b]` → readable citations, or null to leave the text untouched. */
export function renderBracketCitation(
	content: string,
	fullMatch: string,
	sourcePath: string
): Node | null {
	const items = parseBracketCitation(content)
	if (!items) return null

	const state = lookup(sourcePath)
	if (state.state !== 'ready') return null

	const entries = items.map(item => state.find(item.key))

	// Nothing resolved: keep the whole thing as typed, flagged.
	if (entries.every(e => !e)) {
		const el = createSpan({
			cls: 'sidenote-citation is-unresolved',
			text: fullMatch
		})
		const missing = items.map(i => `"${i.key}"`).join(', ')
		setTooltip(el, `No bibliography entry for ${missing}`)
		return el
	}

	const group = createSpan({ cls: 'sidenote-citation-group' })
	items.forEach((item, i) => {
		if (i > 0) group.appendText('; ')
		group.appendChild(citationEl(entries[i], item, false))
	})
	return group
}

/** `@key` or `@key [p. 3]` in running text → "Author (Year, p. 3)". */
export function renderBareCitation(
	key: string,
	locator: string | undefined,
	fullMatch: string,
	sourcePath: string
): Node | null {
	const state = lookup(sourcePath)
	if (state.state !== 'ready') return null

	const item = parseBareCitation(key, locator, fullMatch)
	return citationEl(state.find(item.key), item, true)
}
