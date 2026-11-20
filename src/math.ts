/**
 * LaTeX in sidenotes: `$inline$` and `$$display$$`.
 *
 * Rendering is delegated to Obsidian's own MathJax (`renderMath`), so the
 * user's math settings and macros apply and nothing extra is bundled.
 * MathJax loads lazily; until it has, math is left as typed, and the owner
 * is asked to re-render once it is ready.
 */

import { finishRenderMath, loadMathJax, renderMath } from 'obsidian'

let enabled = true
let ready = false
let loading: Promise<void> | null = null

export function setMathEnabled(value: boolean): void {
	enabled = value
}

export function isMathEnabled(): boolean {
	return enabled
}

/**
 * Start loading MathJax (once). `onReady` runs after the first successful
 * load so callers can re-render notes that were drawn before it was ready.
 */
export function ensureMathLoaded(onReady?: () => void): void {
	if (!enabled || ready) return
	if (!loading) {
		loading = loadMathJax().then(
			() => {
				ready = true
				onReady?.()
			},
			error => {
				loading = null
				console.error('Sidenote plugin: failed to load MathJax', error)
			}
		)
	}
}

/**
 * Display math: `$$ ... $$`, may span lines. Inline math follows Obsidian's
 * rules so prices ("$5 and $10") stay text: the opening `$` is not followed
 * by whitespace, the closing `$` is not preceded by whitespace or followed by
 * a digit, and `\$` is an escape.
 *
 * Two capture groups each: display (1), inline (2). When math is off they
 * still exist but can never match, so the group numbering in content.ts does
 * not depend on the setting.
 */
const MATH_SOURCE = String.raw`(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?![\d$])`
const NO_MATH_SOURCE = String.raw`(?!)()|(?!)()`

export function mathSource(): string {
	return enabled ? MATH_SOURCE : NO_MATH_SOURCE
}

/** True when the text contains LaTeX the renderer would pick up. */
export function containsMath(text: string): boolean {
	return enabled && new RegExp(MATH_SOURCE).test(text)
}

/**
 * Render LaTeX to a node, or null when MathJax is not ready or rejects the
 * source (the caller then shows the text as typed).
 */
export function renderMathNode(
	source: string,
	display: boolean
): HTMLElement | null {
	if (!enabled || !ready) return null
	try {
		// renderMath returns a bare mjx-container; Obsidian's own math wrapper
		// (`.math`, plus `.math-block` for display) is added by its callers,
		// so do the same to give the CSS something to hang on.
		const wrap = createEl(display ? 'div' : 'span', {
			cls: display ? 'math math-block is-loaded' : 'math is-loaded'
		})
		wrap.appendChild(renderMath(source.trim(), display))
		void finishRenderMath()
		return wrap
	} catch (error) {
		console.error('Sidenote plugin: failed to render math', error)
		return null
	}
}
