/**
 * Pandoc citation syntax found in sidenote text.
 *
 *   [@key]                     [@key, 42]            [see @key, pp. 3-5]
 *   [@a; @b]                   [-@key]  (suppress author)
 *   @key  /  @key [p. 33]      @{key with 'odd' chars}
 *
 * The two `*_SOURCE` strings are spliced into the combined inline regex in
 * content.ts, so a citation is recognised at the same left-to-right pass as
 * bold, links and the rest — which is what keeps `_` inside a key from being
 * read as italics.
 */

/** Group 1: the inside of `[...]` when it contains an `@`; not a `[..](..)` link. */
export const BRACKET_CITATION_SOURCE = String.raw`\[([^\[\]]*@[^\[\]]*)\](?!\()`

/**
 * Group 1: the key (or `{braced key}`); group 2: an optional trailing `[locator]`.
 * Not preceded by a word character, so e-mail addresses are left alone.
 */
export const BARE_CITATION_SOURCE = String.raw`(?<![\w@])@(\{[^{}]+\}|[\wÀ-￿](?:[\w:.#$%&\-+?<>~/À-￿]*[\wÀ-￿])?)(?:[ \t]\[([^\[\]]*)\](?!\())?`

const KEY = String.raw`\{[^{}]+\}|[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&\-+?<>~/]*[\p{L}\p{N}_])?`

const ITEM_RE = new RegExp(
	`^(.*?)(?<![\\p{L}\\p{N}_])(-?)@(${KEY})(.*)$`,
	'su'
)

export interface CitationItem {
	key: string
	prefix: string
	/** Locator and any suffix, e.g. `6.25–26` or `p. 33`. */
	locator: string
	suppressAuthor: boolean
	/** The item exactly as written, trimmed. */
	raw: string
}

function unbrace(key: string): string {
	return key.startsWith('{') ? key.slice(1, -1).trim() : key
}

function splitItems(content: string): string[] {
	const out: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < content.length; i++) {
		const c = content[i]
		if (c === '{') depth++
		else if (c === '}') depth = Math.max(0, depth - 1)
		else if (c === ';' && depth === 0) {
			out.push(content.slice(start, i))
			start = i + 1
		}
	}
	out.push(content.slice(start))
	return out
}

/**
 * Parse the inside of `[...]`. Returns null unless *every* `;`-separated item
 * holds a key, so prose such as `[mail me @ noon]` is never mistaken for one.
 */
export function parseBracketCitation(
	content: string
): CitationItem[] | null {
	const items: CitationItem[] = []
	for (const part of splitItems(content)) {
		const m = ITEM_RE.exec(part)
		if (!m) return null
		items.push({
			prefix: (m[1] ?? '').trim(),
			suppressAuthor: m[2] === '-',
			key: unbrace(m[3] ?? ''),
			locator: (m[4] ?? '').replace(/^[\s,]+/, '').trim(),
			raw: part.trim()
		})
	}
	return items.length ? items : null
}

/** A bare `@key`, with an optional following `[locator]`. */
export function parseBareCitation(
	rawKey: string,
	locator: string | undefined,
	raw: string
): CitationItem {
	return {
		key: unbrace(rawKey),
		prefix: '',
		locator: (locator ?? '').trim(),
		suppressAuthor: false,
		raw: raw.trim()
	}
}
