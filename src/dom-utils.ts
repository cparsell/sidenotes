export function setCssProps(
	el: HTMLElement,
	props: Record<string, string>,
	important: boolean = false,
) {
	for (const [key, value] of Object.entries(props)) {
		el.style.setProperty(key, value, important ? "important" : "");
	}
}
