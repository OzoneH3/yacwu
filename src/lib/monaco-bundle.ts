import * as monaco from 'monaco-editor/editor/editor.api';
// The contribution module intentionally registers its functionality for side effects.
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker';

(self as typeof globalThis & { MonacoEnvironment?: unknown }).MonacoEnvironment = {
	getWorker(_moduleId: string, label: string) {
		switch (label) {
			case 'json':
				return new JsonWorker();
			case 'css':
			case 'scss':
			case 'less':
				return new CssWorker();
			case 'html':
			case 'handlebars':
			case 'razor':
				return new HtmlWorker();
			case 'typescript':
			case 'javascript':
				return new TypeScriptWorker();
			default:
				return new EditorWorker();
		}
	}
};

export { monaco };
