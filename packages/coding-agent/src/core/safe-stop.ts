/** Cooperative admission, not a detector for arbitrary JavaScript or a security boundary. */
export type SafeStopStatus = { status: "idle" | "busy" | "unsupported" | "error"; reason: string };

export interface SafeStopParticipant {
	/** Acquire synchronously BEFORE starting owned work; release only after its cleanup finishes. */
	beginWork(): () => void;
}

/** A one-way fence. Checking and closing it must happen in the same synchronous call stack. */
export class SafeStopGate implements SafeStopParticipant {
	private stopping = false;
	private pending = 0;

	get isStopping(): boolean {
		return this.stopping;
	}

	get isBusy(): boolean {
		return this.pending !== 0;
	}

	assertOpen(): void {
		if (this.stopping) throw new Error("Safe stop: ingress is fenced");
	}

	beginWork(): () => void {
		this.assertOpen();
		this.pending++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.pending--;
		};
	}

	async run<T>(work: () => T | Promise<T>): Promise<T> {
		const release = this.beginWork();
		try {
			return await work();
		} finally {
			release();
		}
	}

	/** No callbacks and no awaits between checking admission and closing the fence. */
	tryClose(): boolean {
		if (this.stopping || this.pending !== 0) return false;
		this.stopping = true;
		return true;
	}
}
