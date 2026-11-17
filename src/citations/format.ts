/**
 * Formatting of a bibliography entry as a short author–year citation and as a
 * one-line reference for the hover tooltip.
 */

import type { BibEntry, BibName } from './bibliography'

function surname(n: BibName): string {
	return n.literal ?? n.family ?? n.given ?? ''
}

function fullName(n: BibName): string {
	if (n.literal) return n.literal
	return [n.given, n.family].filter(Boolean).join(' ')
}

/** "Smith", "Smith and Jones", "Smith et al." — or the title/key as fallback. */
export function authorLabel(entry: BibEntry): string {
	const names = entry.authors.length ? entry.authors : entry.editors
	if (names.length === 1) return surname(names[0]!)
	if (names.length === 2) {
		return `${surname(names[0]!)} and ${surname(names[1]!)}`
	}
	if (names.length > 2) return `${surname(names[0]!)} et al.`

	if (entry.title) {
		return entry.title.length > 32
			? `${entry.title.slice(0, 31).trimEnd()}…`
			: entry.title
	}
	return entry.id
}

/** A locator as Pandoc would show it: hyphenated page ranges become en dashes. */
export function formatLocator(locator: string): string {
	return locator.replace(/(\d)-(\d)/g, '$1–$2').trim()
}

export interface CitationDisplay {
	prefix: string
	locator: string
	suppressAuthor: boolean
	/** `@key` in running text: "Author (Year)" rather than "Author Year". */
	narrative: boolean
}

export function formatShortCitation(
	entry: BibEntry,
	opts: CitationDisplay
): string {
	const year = entry.year || 'n.d.'
	const locator = opts.locator ? formatLocator(opts.locator) : ''
	let body: string

	if (opts.narrative && !opts.suppressAuthor) {
		body = `${authorLabel(entry)} (${[year, locator].filter(Boolean).join(', ')})`
	} else {
		const head = opts.suppressAuthor
			? year
			: `${authorLabel(entry)} ${year}`
		body = [head, locator].filter(Boolean).join(', ')
	}
	return opts.prefix ? `${opts.prefix.trim()} ${body}` : body
}

/** A readable one-line reference for the hover tooltip. */
export function formatFullReference(entry: BibEntry): string {
	const names = entry.authors.length ? entry.authors : entry.editors
	const who = names.map(fullName).join(', ')
	const suffix =
		!entry.authors.length && entry.editors.length ? ' (ed.)' : ''

	const parts: string[] = []
	if (who) parts.push(`${who}${suffix}`)
	parts.push(`(${entry.year || 'n.d.'})`)

	let line = parts.join(' ')
	if (entry.title) line += `. ${entry.title}`

	const where = [
		entry.container,
		[entry.volume, entry.pages].filter(Boolean).join(': ')
	]
		.filter(Boolean)
		.join(', ')
	if (where) line += `. ${where}`
	if (entry.publisher) line += `. ${entry.publisher}`
	line += '.'

	const link = entry.doi ? `https://doi.org/${entry.doi}` : entry.url
	return link ? `${line} ${link}` : line
}
