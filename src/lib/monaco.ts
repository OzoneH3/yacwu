/** Monaco is bundled locally, but loaded only when the diff viewer is opened. */

// Monaco's types are not installed (nothing is vendored), so the handle is
// deliberately untyped.
export type Monaco = any;

let monacoPromise: Promise<Monaco> | null = null;

export function loadMonaco(): Promise<Monaco> {
	if (!monacoPromise) {
		monacoPromise = load().catch((error) => {
			monacoPromise = null;
			throw error;
		});
	}
	return monacoPromise;
}

async function load(): Promise<Monaco> {
	const { monaco } = await import('$lib/monaco-bundle');
	defineThemes(monaco);
	// Grammars Monaco lacks (TOML, Gleam) live in their own lazy chunk.
	const { registerExtraLanguages } = await import('$lib/monaco-grammars');
	registerExtraLanguages(monaco);
	return monaco;
}

/** Editor themes matching the app's light and dark paper palettes. */
function defineThemes(monaco: Monaco) {
	monaco.editor.defineTheme('yacwu-paper', {
		base: 'vs',
		inherit: true,
		rules: [
			{ token: 'comment', foreground: '8a8071', fontStyle: 'italic' },
			{ token: 'keyword', foreground: '9a3d1d' },
			{ token: 'string', foreground: '5c6e3c' },
			{ token: 'number', foreground: '7a4a9e' },
			{ token: 'type', foreground: '2f5d8a' },
			{ token: 'key', foreground: '2f5d8a' },
			{ token: 'constant', foreground: '7a4a9e' },
			{ token: 'annotation', foreground: '8a8071' }
		],
		colors: {
			'editor.background': '#faf8f1',
			'editor.foreground': '#2e2a24',
			'editor.lineHighlightBackground': '#f3efe3',
			'editorLineNumber.foreground': '#a89d8a',
			'editorLineNumber.activeForeground': '#5c5546',
			'editor.selectionBackground': '#efd9c4',
			'diffEditor.insertedLineBackground': '#edf6e9',
			'diffEditor.removedLineBackground': '#fae9e5',
			'diffEditor.insertedTextBackground': '#cfe8c788',
			'diffEditor.removedTextBackground': '#f0c7bf88',
			'diffEditor.diagonalFill': '#ded5c266',
			'editorWidget.background': '#f6f2e7',
			'editorWidget.border': '#ded5c2',
			'scrollbarSlider.background': '#ded5c266',
			'scrollbarSlider.hoverBackground': '#ded5c2aa',
			'scrollbarSlider.activeBackground': '#ded5c2dd'
		}
	});
	monaco.editor.defineTheme('yacwu-dark', {
		base: 'vs-dark',
		inherit: true,
		rules: [
			{ token: 'comment', foreground: '9F968B', fontStyle: 'italic' },
			{ token: 'keyword', foreground: 'E89170' },
			{ token: 'string', foreground: 'A9C07A' },
			{ token: 'number', foreground: 'C4A0DF' },
			{ token: 'type', foreground: '82AFD6' },
			{ token: 'key', foreground: '82AFD6' },
			{ token: 'constant', foreground: 'C4A0DF' },
			{ token: 'annotation', foreground: 'AAA096' }
		],
		colors: {
			'editor.background': '#25221f',
			'editor.foreground': '#eeeae4',
			'editor.lineHighlightBackground': '#302c28',
			'editorLineNumber.foreground': '#766e65',
			'editorLineNumber.activeForeground': '#c8c0b7',
			'editor.selectionBackground': '#71442f',
			'diffEditor.insertedLineBackground': '#26392a',
			'diffEditor.removedLineBackground': '#422926',
			'diffEditor.insertedTextBackground': '#3e684688',
			'diffEditor.removedTextBackground': '#76453e88',
			'diffEditor.diagonalFill': '#4b454066',
			'editorWidget.background': '#2d2926',
			'editorWidget.border': '#514a44',
			'scrollbarSlider.background': '#6b625866',
			'scrollbarSlider.hoverBackground': '#81766aaa',
			'scrollbarSlider.activeBackground': '#978a7ddd'
		}
	});
}

export function monacoTheme(theme: 'light' | 'dark'): string {
	return theme === 'dark' ? 'yacwu-dark' : 'yacwu-paper';
}
