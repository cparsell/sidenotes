/**
 * Bibliography parsing: BibTeX/BibLaTeX (`.bib`) and CSL JSON (`.json`) into
 * one small normalised shape.
 *
 * Only what a short author–year citation and a hover reference need is kept.
 * This is deliberately not a CSL processor — Pandoc does the real formatting
 * on export.
 */

export interface BibName {
	family?: string
	given?: string
	/** A name that must not be split, e.g. `{Zhu Qianzhi}` or an institution. */
	literal?: string
}

export interface BibEntry {
	id: string
	authors: BibName[]
	editors: BibName[]
	/** Four-digit year, or '' when the entry has none. */
	year: string
	title: string
	container: string
	publisher: string
	volume: string
	pages: string
	doi: string
	url: string
}

// ==================== LaTeX clean-up ====================

const COMBINING: Record<string, string> = {
	"'": '́',
	'`': '̀',
	'^': '̂',
	'"': '̈',
	'~': '̃',
	'=': '̄',
	'.': '̇',
	c: '̧',
	v: '̌',
	u: '̆',
	H: '̋',
	k: '̨'
}

const SPECIAL_LETTERS: Record<string, string> = {
	ss: 'ß',
	o: 'ø',
	O: 'Ø',
	ae: 'æ',
	AE: 'Æ',
	oe: 'œ',
	OE: 'Œ',
	aa: 'å',
	AA: 'Å',
	l: 'ł',
	L: 'Ł'
}

/** Turn the LaTeX commonly found in .bib fields into plain text. */
export function cleanLatex(input: string): string {
	let s = input
	// \i and \j are dotless letters used under accents: \'{\i}
	s = s.replace(/\\([ij])(?![A-Za-z])/g, '$1')
	// Symbol accents: \'e  \'{e}  {\"o}  \~n
	s = s.replace(
		/\\(['`^"~=.])\s*\{?([A-Za-z])\}?/g,
		(_m, accent: string, letter: string) =>
			letter + (COMBINING[accent] ?? '')
	)
	// Letter accents: \c{c}  \v{s}  \c c
	s = s.replace(
		/\\([cvuHk])(?:\s*\{([A-Za-z])\}|\s+([A-Za-z]))/g,
		(_m, accent: string, a?: string, b?: string) =>
			(a ?? b ?? '') + (COMBINING[accent] ?? '')
	)
	s = s.replace(
		/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L)(?![A-Za-z])\s*/g,
		(_m, name: string) => SPECIAL_LETTERS[name] ?? name
	)
	s = s.replace(/\\([&%_$#{}])/g, '$1')
	s = s.replace(/---/g, '—').replace(/--/g, '–')
	s = s.replace(/~/g, ' ')
	s = s.replace(/[{}]/g, '')
	return s.normalize('NFC').replace(/\s+/g, ' ').trim()
}

// ==================== Names ====================

/** Split on a delimiter that sits outside any braces. */
function splitTopLevel(s: string, re: RegExp): string[] {
	const parts: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < s.length; i++) {
		const c = s[i]
		if (c === '{') depth++
		else if (c === '}') depth = Math.max(0, depth - 1)
		else if (depth === 0) {
			re.lastIndex = 0
			const m = re.exec(s.slice(i))
			if (m && m.index === 0 && m[0].length > 0) {
				parts.push(s.slice(start, i))
				i += m[0].length - 1
				start = i + 1
			}
		}
	}
	parts.push(s.slice(start))
	return parts.map(p => p.trim()).filter(p => p.length > 0)
}

function parseBibtexName(raw: string): BibName | null {
	const name = raw.trim()
	if (!name) return null

	// Wholly braced: a literal that must not be split.
	if (/^\{[^{}]*\}$/.test(name)) {
		return { literal: cleanLatex(name) }
	}

	const commaParts = splitTopLevel(name, /^,/)
	if (commaParts.length >= 2) {
		// "Family, Given" or "Family, Jr, Given"
		return {
			family: cleanLatex(commaParts[0] ?? ''),
			given: cleanLatex(commaParts[commaParts.length - 1] ?? '')
		}
	}

	const words = splitTopLevel(name, /^\s+/)
	if (words.length === 1) return { literal: cleanLatex(name) }

	// "Given von Family": family starts at the first lowercase word that is
	// not the last one; otherwise it is the last word.
	let familyStart = words.length - 1
	for (let i = 0; i < words.length - 1; i++) {
		if (/^[a-z]/.test(words[i] ?? '')) {
			familyStart = i
			break
		}
	}
	return {
		given: cleanLatex(words.slice(0, familyStart).join(' ')),
		family: cleanLatex(words.slice(familyStart).join(' '))
	}
}

function parseBibtexNames(raw: string | undefined): BibName[] {
	if (!raw) return []
	return splitTopLevel(raw, /^\s+and\s+/i)
		.map(parseBibtexName)
		.filter((n): n is BibName => n !== null)
}

// ==================== BibTeX ====================

const MONTH_MACROS = new Set([
	'jan',
	'feb',
	'mar',
	'apr',
	'may',
	'jun',
	'jul',
	'aug',
	'sep',
	'oct',
	'nov',
	'dec'
])

/** Index just past the `}` / `)` closing a body that starts at `from`. */
function findBodyEnd(
	text: string,
	from: number,
	closer: '}' | ')'
): number {
	let depth = 0
	for (let i = from; i < text.length; i++) {
		const c = text[i]
		if (c === '\\') {
			i++
		} else if (c === '{') {
			depth++
		} else if (c === '}') {
			if (depth === 0 && closer === '}') return i
			depth = Math.max(0, depth - 1)
		} else if (c === ')' && depth === 0 && closer === ')') {
			return i
		}
	}
	return text.length
}

/** Read a balanced `{...}` or `"..."` starting at `i`; returns [value, next]. */
function readDelimited(text: string, i: number): [string, number] {
	const open = text[i]
	if (open === '{') {
		let depth = 0
		for (let j = i; j < text.length; j++) {
			const c = text[j]
			if (c === '\\') j++
			else if (c === '{') depth++
			else if (c === '}') {
				depth--
				if (depth === 0) return [text.slice(i + 1, j), j + 1]
			}
		}
		return [text.slice(i + 1), text.length]
	}
	// quoted: ends at the first quote outside braces
	let depth = 0
	for (let j = i + 1; j < text.length; j++) {
		const c = text[j]
		if (c === '\\') j++
		else if (c === '{') depth++
		else if (c === '}') depth = Math.max(0, depth - 1)
		else if (c === '"' && depth === 0) return [text.slice(i + 1, j), j + 1]
	}
	return [text.slice(i + 1), text.length]
}

/** Parse `name = value # value, ...` pairs, expanding @string macros. */
function parseFields(
	body: string,
	macros: Map<string, string>
): Map<string, string> {
	const fields = new Map<string, string>()
	let i = 0
	const n = body.length
	while (i < n) {
		while (i < n && /[\s,]/.test(body[i] ?? '')) i++
		const nameMatch = /^[^\s=,{}"]+/.exec(body.slice(i))
		if (!nameMatch) break
		const name = nameMatch[0].toLowerCase()
		i += nameMatch[0].length
		while (i < n && /\s/.test(body[i] ?? '')) i++
		if (body[i] !== '=') continue
		i++

		let value = ''
		for (;;) {
			while (i < n && /\s/.test(body[i] ?? '')) i++
			const c = body[i]
			if (c === '{' || c === '"') {
				const [v, next] = readDelimited(body, i)
				value += v
				i = next
			} else {
				const bare = /^[^\s,#{}"]+/.exec(body.slice(i))
				if (!bare) break
				const token = bare[0]
				value += macros.get(token.toLowerCase()) ?? token
				i += token.length
			}
			while (i < n && /\s/.test(body[i] ?? '')) i++
			if (body[i] === '#') {
				i++
				continue
			}
			break
		}
		fields.set(name, value)
	}
	return fields
}

function yearFrom(value: string | undefined): string {
	return /\b(\d{4})\b/.exec(value ?? '')?.[1] ?? ''
}

export function parseBibtex(text: string): BibEntry[] {
	const entries: BibEntry[] = []
	const macros = new Map<string, string>()
	for (const m of MONTH_MACROS) macros.set(m, m)

	let i = 0
	for (;;) {
		i = text.indexOf('@', i)
		if (i === -1) break
		const head = /^@\s*([A-Za-z]+)\s*([{(])/.exec(text.slice(i, i + 64))
		if (!head) {
			i++
			continue
		}
		const type = (head[1] ?? '').toLowerCase()
		const closer = head[2] === '(' ? ')' : '}'
		const bodyStart = i + head[0].length
		const bodyEnd = findBodyEnd(text, bodyStart, closer)
		const body = text.slice(bodyStart, bodyEnd)
		i = bodyEnd + 1

		if (type === 'comment' || type === 'preamble') continue
		if (type === 'string') {
			const f = parseFields(body, macros)
			for (const [k, v] of f) macros.set(k, v)
			continue
		}

		const comma = body.indexOf(',')
		if (comma === -1) continue
		const id = body.slice(0, comma).trim()
		if (!id) continue

		const f = parseFields(body.slice(comma + 1), macros)
		const get = (...names: string[]): string => {
			for (const name of names) {
				const v = f.get(name)
				if (v) return cleanLatex(v)
			}
			return ''
		}

		entries.push({
			id,
			authors: parseBibtexNames(f.get('author')),
			editors: parseBibtexNames(f.get('editor')),
			year: yearFrom(f.get('year')) || yearFrom(f.get('date')),
			title: get('title'),
			container: get('journaltitle', 'journal', 'booktitle'),
			publisher: get('publisher', 'institution', 'school'),
			volume: get('volume'),
			pages: get('pages'),
			doi: get('doi'),
			url: get('url')
		})
	}
	return entries
}

// ==================== CSL JSON ====================

type Json = Record<string, unknown>

function cslNames(value: unknown): BibName[] {
	if (!Array.isArray(value)) return []
	const out: BibName[] = []
	for (const raw of value as unknown[]) {
		if (!raw || typeof raw !== 'object') continue
		const n = raw as Json
		const str = (k: string) =>
			typeof n[k] === 'string' ? n[k].trim() : undefined
		const literal = str('literal')
		const family = str('family')
		const given = str('given')
		if (literal) out.push({ literal })
		else if (family || given) out.push({ family, given })
	}
	return out
}

function cslYear(issued: unknown): string {
	if (!issued || typeof issued !== 'object') return ''
	const i = issued as Json
	const parts = i['date-parts']
	if (Array.isArray(parts) && Array.isArray(parts[0])) {
		const y = (parts[0] as unknown[])[0]
		if (typeof y === 'number' || typeof y === 'string') {
			return yearFrom(String(y))
		}
	}
	const raw = i['raw'] ?? i['literal']
	return typeof raw === 'string' ? yearFrom(raw) : ''
}

export function parseCslJson(text: string): BibEntry[] {
	let data: unknown
	try {
		data = JSON.parse(text)
	} catch {
		return []
	}
	const list = Array.isArray(data)
		? data
		: data &&
			  typeof data === 'object' &&
			  Array.isArray((data as Json).items)
			? ((data as Json).items as unknown[])
			: []

	const entries: BibEntry[] = []
	for (const raw of list) {
		if (!raw || typeof raw !== 'object') continue
		const e = raw as Json
		const id = e['id']
		if (typeof id !== 'string' && typeof id !== 'number') continue
		const str = (k: string) => {
			const v = e[k]
			return typeof v === 'string' || typeof v === 'number'
				? String(v).trim()
				: ''
		}
		entries.push({
			id: String(id),
			authors: cslNames(e['author']),
			editors: cslNames(e['editor']),
			year: cslYear(e['issued']),
			title: str('title'),
			container: str('container-title'),
			publisher: str('publisher'),
			volume: str('volume'),
			pages: str('page'),
			doi: str('DOI'),
			url: str('URL')
		})
	}
	return entries
}

// ==================== Entry point ====================

/** Parse a bibliography file, choosing the format by extension, then content. */
export function parseBibliography(
	path: string,
	text: string
): Map<string, BibEntry> {
	const lower = path.toLowerCase()
	const isJson =
		lower.endsWith('.json') ||
		lower.endsWith('.csl') ||
		(!/\.(bib|bibtex|biblatex)$/.test(lower) && /^\s*[[{]/.test(text))
	const list = isJson ? parseCslJson(text) : parseBibtex(text)
	const map = new Map<string, BibEntry>()
	for (const entry of list) {
		if (!map.has(entry.id)) map.set(entry.id, entry)
	}
	return map
}
