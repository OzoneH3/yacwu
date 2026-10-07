/** Create/configure the replacement before archiving the recoverable original. */
export async function replaceSessionWithEmptyThread<T extends { thread?: { id?: string } }>(operations: {
	assertIdle: () => Promise<void>;
	create: () => Promise<T>;
	configure: (id: string) => Promise<void>;
	archive: () => Promise<void>;
}): Promise<T> {
	await operations.assertIdle();
	const created = await operations.create();
	const id = created.thread?.id;
	if (!id) throw new Error('Could not create an empty session: no thread ID returned.');
	await operations.configure(id);
	// Check again in case work started while the replacement was being prepared.
	await operations.assertIdle();
	await operations.archive();
	return created;
}
