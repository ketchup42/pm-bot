type TickHandler = () => void;

/**
 * Wrapper for a timer that executes a handler periodically.
 * - If tickMs > 0: handler runs every `tickMs` milliseconds (setInterval).
 * - If tickMs === 0 or undefined: timer mode is disabled – handler runs only when explicitly triggered (event‑driven).
 */
export class TickTimer {
    private _tickMs: number | undefined;
    private _handler: TickHandler;
    private _intervalId: NodeJS.Timeout | undefined = undefined;
    private _isRunning = false;
    private _disposed = false;

    /**
     * @param tickMs - Interval in milliseconds. If falsy or <= 0, timer mode is disabled.
     * @param handler - Function to execute on each tick or event trigger.
     */
    constructor(tickMs: number | undefined, handler: TickHandler) {
        this._tickMs = (tickMs && tickMs > 0) ? tickMs : undefined;
        this._handler = handler;
    }

    /** Starts the timer if tickMs is defined. Does nothing in event‑driven mode. */
    public start(): void {
        if (this._tickMs === undefined) return;
        if (this._intervalId !== undefined) return; // already running

        this._intervalId = setInterval(() => {
            if (this._isRunning) {
                this._handler();
            }
        }, this._tickMs);
        this._isRunning = true;
    }

    /** Stops the timer if running. Safe to call multiple times. */
    public stop(): void {
        if (this._intervalId !== undefined) {
            clearInterval(this._intervalId);
            this._intervalId = undefined;
        }
        this._isRunning = false;
    }

    /**
     * Triggers the handler immediately.
     */
    public trigger(): void {
        if (this._isRunning) {
            this._handler();
        }
    }

    /** Enables the timer (or event‑driven mode) so that triggers are honoured. */
    public enable(): void {
        if (this._disposed) return;
        if (this._isRunning) return;
        this._isRunning = true;
        if (this._tickMs !== undefined && this._intervalId === undefined) {
            this.start();
        }
    }

    /** Disables the timer – no further triggers will execute the handler until enabled again. */
    public disable(): void {
        this.stop();
        this._isRunning = false;
    }

    /** Returns true if the timer is enabled and (in timer mode) the interval is active. */
    public isRunning(): boolean {
        return this._isRunning;
    }

    /** Performs full cleanup. After disposal, the timer cannot be restarted. */
    public dispose(): void {
        if (this._disposed) return;
        this.stop();
        this._handler = () => {};
        this._isRunning = false;
        this._disposed = true;
    }
}