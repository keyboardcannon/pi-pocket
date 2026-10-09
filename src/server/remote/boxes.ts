/**
 * Paprika: sessions whose tools run in a remote box, and the boxes' lifecycle.
 *
 * - Which session uses which box: `boxes.json` in the data folder (`conversations`: root conversation id -> box
 *   name; `boxes`: name -> provider id and directory). Read again when it changes.
 * - A box starts when one of its calls needs it, and stops after `idleMs` with no call running or made.
 * - Every start and every bit of activity keeps a provider-side lease `leaseMs` ahead, also while a long command
 *   runs. If this server dies, the provider stops the box when the lease runs out.
 * - `box-state.json` records the last activity, so a restarted server stops boxes that went idle while it was down.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type BoxBackend, type BoxSpec, loadBoxBackend } from "./backend.ts";
import { daemonBundle } from "./bundle.ts";
import { RemoteExecutionEnv } from "./env.ts";

export interface BoxManagerOptions {
    readonly dataDir: string;
    /** Server paths a box session may read from the server, such as global skills. */
    localReadPaths(): string[];
    notice(level: "info" | "warning", text: string): void;
    readonly idleMs?: number;
    readonly leaseMs?: number;
}

type BindingsFile = {
    conversations?: Record<string, string>;
    boxes?: Record<string, { sandboxId: string; cwd?: string }>;
};

type StateFile = { boxes: Record<string, { lastActivity: number; running: boolean }> };

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_LEASE_MS = 60 * 60_000;
/** Renew when less than this is left of the lease; also how often a long-running command renews it. */
const RENEW_MARGIN_MS = 10 * 60_000;

export class BoxManager {
    readonly #options: BoxManagerOptions;
    readonly #runtimes = new Map<string, BoxRuntime>();
    #bindings: { mtimeMs: number; file: BindingsFile } | undefined;
    #state: StateFile | undefined;

    constructor(options: BoxManagerOptions) {
        this.#options = options;
    }

    get idleMs(): number {
        return this.#options.idleMs ?? DEFAULT_IDLE_MS;
    }

    get leaseMs(): number {
        return this.#options.leaseMs ?? DEFAULT_LEASE_MS;
    }

    notice(level: "info" | "warning", text: string): void {
        this.#options.notice(level, text);
    }

    localReadPaths(): string[] {
        return this.#options.localReadPaths();
    }

    #readBindings(): BindingsFile {
        const path = join(this.#options.dataDir, "boxes.json");

        try {
            const { mtimeMs } = statSync(path);

            if (this.#bindings?.mtimeMs !== mtimeMs) {
                this.#bindings = {
                    mtimeMs,
                    file: JSON.parse(readFileSync(path, "utf8")) as BindingsFile,
                };
            }

            return this.#bindings.file;
        } catch {
            return {};
        }
    }

    /** The box a root conversation's tools run in, if it has one. */
    boxFor(rootId: string | number): BoxSpec | undefined {
        const bindings = this.#readBindings();
        const name = bindings.conversations?.[String(rootId)];
        const box = name === undefined ? undefined : bindings.boxes?.[name];

        if (name === undefined || box === undefined) {
            return undefined;
        }

        return { name, sandboxId: box.sandboxId, cwd: box.cwd ?? "/workspace" };
    }

    /** The environment for a root conversation's box, or undefined for a local session. */
    envFor(rootId: string | number): RemoteExecutionEnv | undefined {
        const spec = this.boxFor(rootId);
        const backend = loadBoxBackend();

        if (spec === undefined) {
            return undefined;
        }

        if (backend === undefined) {
            throw new Error(`Session uses box ${spec.name}, but no box backend is configured`);
        }

        let runtime = this.#runtimes.get(spec.name);

        if (runtime === undefined || runtime.spec.sandboxId !== spec.sandboxId) {
            runtime = new BoxRuntime(this, spec, backend);
            this.#runtimes.set(spec.name, runtime);
        }

        return runtime.env;
    }

    // --- state that survives restarts ----------------------------------------------------------------------------

    #statePath(): string {
        return join(this.#options.dataDir, "box-state.json");
    }

    #loadState(): StateFile {
        if (this.#state === undefined) {
            try {
                this.#state = JSON.parse(readFileSync(this.#statePath(), "utf8")) as StateFile;
            } catch {
                this.#state = { boxes: {} };
            }
        }

        return this.#state;
    }

    record(name: string, entry: { lastActivity: number; running: boolean }): void {
        const state = this.#loadState();

        state.boxes[name] = entry;

        try {
            writeFileSync(this.#statePath(), `${JSON.stringify(state, null, 2)}\n`, {
                mode: 0o600,
            });
        } catch (error) {
            this.notice("warning", `Could not save box state: ${String(error)}`);
        }
    }

    /** At startup: stop boxes that were left running and have been idle longer than `idleMs`. */
    async reconcile(): Promise<void> {
        const backendLoad = loadBoxBackend();

        if (backendLoad === undefined) {
            return;
        }

        const backend = await backendLoad;
        const bindings = this.#readBindings();

        for (const [name, entry] of Object.entries(this.#loadState().boxes)) {
            const box = bindings.boxes?.[name];

            if (
                !entry.running ||
                box === undefined ||
                Date.now() - entry.lastActivity < this.idleMs
            ) {
                continue;
            }

            const spec = { name, sandboxId: box.sandboxId, cwd: box.cwd ?? "/workspace" };

            try {
                if ((await backend.status(spec)) === "running") {
                    await backend.stop(spec);
                    this.notice("info", `Stopped box ${name}: idle while the server was down`);
                }

                this.record(name, { lastActivity: entry.lastActivity, running: false });
            } catch (error) {
                this.notice("warning", `Could not stop idle box ${name}: ${String(error)}`);
            }
        }
    }

    async dispose(): Promise<void> {
        await Promise.all([...this.#runtimes.values()].map((runtime) => runtime.detach()));
    }
}

/** One box: its environment, connection, idle stop, and lease. */
class BoxRuntime {
    readonly spec: BoxSpec;
    readonly env: RemoteExecutionEnv;
    readonly #manager: BoxManager;
    readonly #backend: Promise<BoxBackend>;
    #inFlight = 0;
    #lastActivity = Date.now();
    #leaseUntil = 0;
    #idleTimer: NodeJS.Timeout | undefined;
    #renewTimer: NodeJS.Timeout | undefined;
    #stopping: Promise<void> | undefined;

    constructor(manager: BoxManager, spec: BoxSpec, backend: Promise<BoxBackend>) {
        this.#manager = manager;
        this.spec = spec;
        this.#backend = backend;
        this.env = new RemoteExecutionEnv({
            id: `box:${spec.name}`,
            cwd: spec.cwd,
            connect: (context) => this.#connect(context),
            localReadPaths: manager.localReadPaths(),
            onActivity: (event) => this.#activity(event),
        });
    }

    async #connect(_context: Context): Promise<ChildProcessWithoutNullStreams> {
        await this.#stopping;
        const backend = await this.#backend;
        const status = await backend.status(this.spec);

        if (status === "missing") {
            throw new Error(`box ${this.spec.name} (${this.spec.sandboxId}) no longer exists`);
        }

        if (status !== "running") {
            this.#manager.notice("info", `Starting box ${this.spec.name}…`);
            const started = Date.now();

            await backend.start(this.spec);
            this.#manager.notice(
                "info",
                `Box ${this.spec.name} started in ${Math.round((Date.now() - started) / 1000)} s`,
            );
            this.#leaseUntil = 0;
        }

        await this.#renewLease(backend);
        this.#manager.record(this.spec.name, { lastActivity: Date.now(), running: true });

        const bundle = await daemonBundle();
        const file = `/tmp/pocket-daemon-${bundle.hash}.mjs`;
        const ssh = await backend.sshArgs(this.spec);
        // Upload the daemon unless this box already has this exact version.
        const upload = spawn(ssh[0]!, [
            ...ssh.slice(1),
            `test -f ${file} || { cat > ${file}.tmp && chmod 644 ${file}.tmp && mv ${file}.tmp ${file}; }`,
        ]);

        upload.stdin.end(bundle.code);
        const uploaded = await new Promise<number | null>((done) => upload.on("exit", done));

        if (uploaded !== 0) {
            throw new Error(
                `could not upload the daemon to box ${this.spec.name} (exit ${String(uploaded)})`,
            );
        }

        const command = `sudo -n -u ${backend.boxUser} -H ${backend.nodePath} ${file} ${this.spec.cwd}`;

        return spawn(ssh[0]!, [...ssh.slice(1), command], { stdio: ["pipe", "pipe", "pipe"] });
    }

    #activity(event: "start" | "end"): void {
        this.#lastActivity = Date.now();

        if (event === "start") {
            this.#inFlight++;
            clearTimeout(this.#idleTimer);
            this.#idleTimer = undefined;
            this.#renewTimer ??= setInterval(() => void this.#maybeRenew(), RENEW_MARGIN_MS);
        } else {
            this.#inFlight = Math.max(0, this.#inFlight - 1);

            if (this.#inFlight === 0) {
                clearInterval(this.#renewTimer);
                this.#renewTimer = undefined;
                this.#idleTimer = setTimeout(() => void this.#idleStop(), this.#manager.idleMs);
            }
        }

        void this.#maybeRenew();
    }

    async #maybeRenew(): Promise<void> {
        if (this.#leaseUntil - Date.now() > this.#manager.leaseMs - RENEW_MARGIN_MS) {
            return;
        }

        try {
            await this.#renewLease(await this.#backend);
            this.#manager.record(this.spec.name, {
                lastActivity: this.#lastActivity,
                running: true,
            });
        } catch (error) {
            this.#manager.notice(
                "warning",
                `Could not renew the lease of box ${this.spec.name}: ${String(error)}`,
            );
        }
    }

    async #renewLease(backend: BoxBackend): Promise<void> {
        const until = Date.now() + this.#manager.leaseMs;

        await backend.renewLease(this.spec, until);
        this.#leaseUntil = until;
    }

    async #idleStop(): Promise<void> {
        if (this.#inFlight > 0 || Date.now() - this.#lastActivity < this.#manager.idleMs) {
            return;
        }

        this.#stopping = (async () => {
            await this.env.cleanup(BACKGROUND_CONTEXT);
            const backend = await this.#backend;

            await backend.stop(this.spec);
            this.#manager.record(this.spec.name, {
                lastActivity: this.#lastActivity,
                running: false,
            });
            this.#manager.notice("info", `Stopped idle box ${this.spec.name}`);
        })()
            .catch((error: unknown) => {
                this.#manager.notice(
                    "warning",
                    `Could not stop idle box ${this.spec.name}: ${String(error)}`,
                );
            })
            .finally(() => {
                this.#stopping = undefined;
            });
        await this.#stopping;
    }

    /** Server shutdown: close the connection, keep the box (the lease or the next start's reconcile handles it). */
    async detach(): Promise<void> {
        clearTimeout(this.#idleTimer);
        clearInterval(this.#renewTimer);
        await this.env.cleanup(BACKGROUND_CONTEXT);
    }
}
