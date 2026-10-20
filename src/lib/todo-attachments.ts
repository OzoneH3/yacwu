/** File bytes stored with a todo, rather than transient File/blob URLs. */
export interface SavedTodoAttachment {
	name: string;
	kind: 'image' | 'file';
	type: string;
	base64: string;
}

export async function saveTodoAttachments(attachments: Array<{ file: File; name: string; kind: 'image' | 'file' }>): Promise<SavedTodoAttachment[]> {
	return Promise.all(attachments.map(async ({ file, name, kind }) => {
		const bytes = new Uint8Array(await file.arrayBuffer());
		let binary = '';
		for (let offset = 0; offset < bytes.length; offset += 8192) {
			binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
		}
		return { name, kind, type: file.type, base64: btoa(binary) };
	}));
}

export function restoreTodoAttachments(attachments: SavedTodoAttachment[]) {
	return attachments.map((attachment, index) => {
		const bytes = Uint8Array.from(atob(attachment.base64), (char) => char.charCodeAt(0));
		return {
			id: `todo-attachment-${index}`,
			name: attachment.name,
			kind: attachment.kind,
			file: new File([bytes], attachment.name, { type: attachment.type }),
			previewUrl: null
		};
	});
}

export function validTodoAttachments(value: unknown): value is SavedTodoAttachment[][] {
	return Array.isArray(value) && value.every((items) => Array.isArray(items) && items.every((item) =>
		item && typeof item.name === 'string' && typeof item.type === 'string'
		&& (item.kind === 'image' || item.kind === 'file') && typeof item.base64 === 'string'));
}
