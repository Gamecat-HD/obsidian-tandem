import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	// Obsidian liefert CodeMirror selbst – nur eine Instanz von @codemirror/state darf existieren.
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
	],
	format: "cjs",
	target: "es2022",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	// Partner-Plugins (Zellwerk, …) bringen eigene Yjs-Kopien mit und tauschen nur Bytes aus –
	// die Doppel-Import-Warnung von Yjs ist hier unbegründet.
	banner: { js: 'var __tdYjs = globalThis["__ $YJS$ __"]; delete globalThis["__ $YJS$ __"];' },
	footer: { js: 'if (__tdYjs) globalThis["__ $YJS$ __"] = true;' },
	minify: prod,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
