/**
 * In-process FIFO for seat store access (DEC-011, DEC-013).
 *
 * `backend.read` and `withLock` take the store lock SYNCHRONOUSLY, freezing the
 * event loop, while a refresh holds the same lock ASYNCHRONOUSLY across its
 * network round trip. Inside one process the two deadlock until the lock
 * timeout: the holder's response callback needs the event loop the spinning
 * reader froze. Every store access in the extension process — turn and request
 * auth, /seat commands, the usage view — runs as a task on one schedule.
 *
 * A task must never await another task on the same schedule: it would wait on
 * itself. Keep interactive waits (OAuth login, confirm dialogs) outside tasks.
 */
export type StoreSchedule = <T>(task: () => T | Promise<T>) => Promise<T>;

export function createStoreSchedule(): StoreSchedule {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(task: () => T | Promise<T>): Promise<T> => {
		const run = tail.then(task, task);
		tail = run.catch(() => undefined);
		return run;
	};
}
