/**
 * Wird ein gelöschter Anhang noch verwendet? Obsidian kennt nur Links im Fließtext. Verweise in Codeblöcken
 * (z. B. der Hintergrund eines Ink-Blocks, `bg: "[[Bild.jpg]]"`) sieht es nicht: Die Datei wirkt dann
 * ungenutzt und wird leicht gelöscht. Deshalb hier eine schlichte Textsuche nach dem Dateinamen.
 */

/** Kommt der Dateiname (auch URL-kodiert wie in `![](Mein%20Bild.png)`) im Text vor? */
export function mentions(text: string, path: string): boolean {
	const name = path.split("/").pop() ?? path;
	if (!name) return false;
	if (text.includes(name)) return true;
	const encoded = [encodeURI(name), name.replace(/ /g, "%20")];
	return encoded.some((n) => n !== name && text.includes(n));
}

export interface NoteSource {
	path: string;
	read(): Promise<string>;
}

/**
 * Notizen, die den Dateinamen noch nennen. `stillResolves(name, notePath)`: Löst der Name dort inzwischen auf eine
 * andere Datei auf (gleichnamige Datei woanders), ist der Verweis nicht kaputt und zählt nicht.
 */
export async function referencingNotes(
	path: string,
	notes: NoteSource[],
	stillResolves: (name: string, notePath: string) => boolean,
): Promise<string[]> {
	return (await referencingNotesMany([path], notes, stillResolves)).get(path) ?? [];
}

/** Wie `referencingNotes` für mehrere gelöschte Dateien – jede Notiz wird dabei nur einmal gelesen. */
export async function referencingNotesMany(
	paths: string[],
	notes: NoteSource[],
	stillResolves: (name: string, notePath: string) => boolean,
): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>(paths.map((p) => [p, []]));
	if (!paths.length) return out;
	for (const n of notes) {
		const text = await n.read();
		for (const path of paths) {
			if (n.path === path || !mentions(text, path)) continue;
			if (stillResolves(path.split("/").pop() ?? path, n.path)) continue;
			out.get(path)!.push(n.path);
		}
	}
	return out;
}
