/**
 * Paprika: sessions whose tools run in a remote box, and the boxes' lifecycle.
 *
 * - A session's box link lives in its catalogue entry (`SessionMeta.box`): the project, and once created the box's
 *   name and provider id. Forks copy it and so share the box.
 * - A session with a project and no box gets one on first use (its first message): created from the provider's
 *   base image, then the project's secrets go to ~/.pocket/env and its setup.sh runs once. resume.sh runs at every
 *   start. A link to a box that no longer exists gets a fresh box the same way.
 * - A box stops after `idleMs` with no call running or made. Every start and bit of activity keeps a provider-side
 *   lease `leaseMs` ahead, also while a long command runs, so the provider stops the box if this server dies.
 * - `box-state.json` records each box's last activity and whether its setup finished, so a restarted server stops
 *   boxes that went idle meanwhile and retries an unfinished setup.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type BoxBackend, type BoxSpec, loadBoxBackend } from "./backend.ts";
import { daemonBundle } from "./bundle.ts";
import { RemoteExecutionEnv } from "./env.ts";
import { type Project, readProject } from "./projects.ts";

/** What a session's catalogue entry records about its box. */
export interface BoxLink {
    readonly project: string;
    readonly name?: string;
    readonly sandboxId?: string;
}

export type BoxState =
    "none" | "creating" | "setting-up" | "starting" | "running" | "stopping" | "stopped";

export interface BoxManagerOptions {
    readonly dataDir: string;
    /** The box link of a root conversation's session, if it is a box session. */
    sessionBox(rootId: string): BoxLink | undefined;
    /** Saves a session's box link (after the box was created). */
    saveBox(rootId: string, link: BoxLink): Promise<void>;
    /** Server paths a box session may read from the server, such as global skills. */
    localReadPaths(): string[];
    notice(level: "info" | "warning", text: string): void;
    /** Called when a box's state changes, for the UI. */
    onState?(rootId: string, state: BoxState): void;
    readonly idleMs?: number;
    readonly leaseMs?: number;
}

type StateFile = {
    boxes: Record<
        string,
        { lastActivity: number; running: boolean; setupDone?: boolean; sandboxId?: string }
    >;
};

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_LEASE_MS = 60 * 60_000;
/** Renew when less than this is left of the lease; also how often a long-running command renews it. */
const RENEW_MARGIN_MS = 10 * 60_000;
const SETUP_TIMEOUT_S = 30 * 60;
const RESUME_TIMEOUT_S = 5 * 60;

export class BoxManager {
    readonly #options: BoxManagerOptions;
    /** By root conversation id. Sessions sharing a box share its runtime through `#byBox`. */
    readonly #runtimes = new Map<string, BoxRuntime>();
    readonly #byBox = new Map<string, BoxRuntime>();
    #state: StateFile | undefined;

    constructor(options: BoxManagerOptions) {
        this.#options = options;
    }

    get options(): BoxManagerOptions {
        return this.#options;
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

    /** The runtime of a root conversation's box, or undefined for a local session. */
    #runtime(rootId: string): BoxRuntime | undefined {
        const link = this.#options.sessionBox(rootId);

        if (link === undefined) {
            return undefined;
        }

        const backend = loadBoxBackend();

        if (backend === undefined) {
            throw new Error(
                `Session uses project ${link.project}, but no box backend is configured`,
            );
        }

        const shared = link.name === undefined ? undefined : this.#byBox.get(link.name);
        let runtime = this.#runtimes.get(rootId);

        if (shared !== undefined && runtime !== shared) {
            runtime = shared;
            this.#runtimes.set(rootId, runtime);
        }

        if (runtime === undefined) {
            runtime = new BoxRuntime(this, rootId, link, backend);
            this.#runtimes.set(rootId, runtime);

            if (link.name !== undefined) {
                this.#byBox.set(link.name, runtime);
            }
        }

        return runtime;
    }

    /** Registers a newly created box's runtime under its name, for sessions that share it later. */
    registerBox(name: string, runtime: BoxRuntime): void {
        this.#byBox.set(name, runtime);
    }

    /** The environment for a root conversation's box, or undefined for a local session. */
    envFor(rootId: string | number): RemoteExecutionEnv | undefined {
        return this.#runtime(String(rootId))?.env;
    }

    /** A box session's state for the UI; undefined for a local session. */
    stateOf(
        rootId: string | number,
    ): { project: string; name?: string; state: BoxState } | undefined {
        const link = this.#options.sessionBox(String(rootId));

        if (link === undefined) {
            return undefined;
        }

        const runtime = this.#runtimes.get(String(rootId));

        return {
            project: link.project,
            ...(link.name === undefined ? {} : { name: link.name }),
            state:
                runtime?.state ??
                (link.sandboxId === undefined
                    ? "none"
                    : this.#record(link.name).running
                      ? "running"
                      : "stopped"),
        };
    }

    /** Stops a session's box now. */
    async stop(rootId: string | number): Promise<void> {
        await this.#runtime(String(rootId))?.stopNow();
    }

    /** Destroys a session's box. The session keeps its project; its next message gets a fresh box. */
    async destroy(rootId: string | number): Promise<void> {
        const id = String(rootId);
        const runtime = this.#runtime(id);
        const link = this.#options.sessionBox(id);

        if (runtime === undefined || link === undefined) {
            return;
        }

        await runtime.destroy();

        if (link.name !== undefined) {
            this.#byBox.delete(link.name);
        }

        this.#runtimes.delete(id);
        await this.#options.saveBox(id, { project: link.project });
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

    #record(name: string | undefined): StateFile["boxes"][string] {
        return (
            (name === undefined ? undefined : this.#loadState().boxes[name]) ?? {
                lastActivity: 0,
                running: false,
            }
        );
    }

    recordOf(name: string): StateFile["boxes"][string] {
        return this.#record(name);
    }

    record(name: string, patch: Partial<StateFile["boxes"][string]>): void {
        this.#loadState().boxes[name] = { ...this.#record(name), ...patch };
        this.#save();
    }

    forget(name: string): void {
        delete this.#loadState().boxes[name];
        this.#save();
    }

    #save(): void {
        try {
            writeFileSync(this.#statePath(), `${JSON.stringify(this.#loadState(), null, 2)}\n`, {
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

        for (const [name, entry] of Object.entries(this.#loadState().boxes)) {
            if (
                !entry.running ||
                entry.sandboxId === undefined ||
                Date.now() - entry.lastActivity < this.idleMs
            ) {
                continue;
            }

            const spec = { name, sandboxId: entry.sandboxId, cwd: "/workspace" };

            try {
                if ((await backend.status(spec)) === "running") {
                    await backend.stop(spec);
                    this.notice("info", `Stopped box ${name}: idle while the server was down`);
                }

                this.record(name, { running: false });
            } catch (error) {
                this.notice("warning", `Could not stop idle box ${name}: ${String(error)}`);
            }
        }
    }

    async dispose(): Promise<void> {
        await Promise.all([...new Set(this.#runtimes.values())].map((runtime) => runtime.detach()));
    }
}

/** One box: its environment, creation and setup, connection, idle stop, and lease. */
class BoxRuntime {
    readonly env: RemoteExecutionEnv;
    state: BoxState = "none";
    readonly #manager: BoxManager;
    readonly #rootId: string;
    readonly #project: string;
    #name: string | undefined;
    #sandboxId: string | undefined;
    readonly #backend: Promise<BoxBackend>;
    #inFlight = 0;
    #lastActivity = Date.now();
    #leaseUntil = 0;
    #idleTimer: NodeJS.Timeout | undefined;
    #renewTimer: NodeJS.Timeout | undefined;
    #stopping: Promise<void> | undefined;

    constructor(manager: BoxManager, rootId: string, link: BoxLink, backend: Promise<BoxBackend>) {
        this.#manager = manager;
        this.#rootId = rootId;
        this.#project = link.project;
        this.#name = link.name;
        this.#sandboxId = link.sandboxId;
        this.#backend = backend;
        this.env = new RemoteExecutionEnv({
            id: `box:${link.name ?? `pending-${rootId}`}`,
            cwd: "/workspace",
            project: link.project,
            connect: (context) => this.#connect(context),
            localReadPaths: manager.options.localReadPaths(),
            onActivity: (event) => this.#activity(event),
        });
    }

    #spec(): BoxSpec {
        return { name: this.#name!, sandboxId: this.#sandboxId!, cwd: "/workspace" };
    }

    #setState(state: BoxState): void {
        this.state = state;
        this.#manager.options.onState?.(this.#rootId, state);
    }

    #project_(): Project {
        const project = readProject(this.#project);

        if (project === undefined) {
            throw new Error(`project ${this.#project} does not exist`);
        }

        return project;
    }

    async #connect(_context: Context): Promise<ChildProcessWithoutNullStreams> {
        await this.#stopping;
        const backend = await this.#backend;
        let started = false;

        if (this.#sandboxId !== undefined && (await backend.status(this.#spec())) === "missing") {
            this.#manager.notice(
                "warning",
                `Box ${this.#name} no longer exists; creating a new one`,
            );
            this.#manager.forget(this.#name!);
            this.#sandboxId = undefined;
        }

        if (this.#sandboxId === undefined) {
            const project = this.#project_();

            this.#name = `pocket-${project.name}-${this.#rootId}`;
            this.#setState("creating");
            this.#manager.notice("info", `Creating box ${this.#name}…`);
            const began = Date.now();
            const { sandboxId } = await backend.create({ name: this.#name, project: project.name });

            this.#sandboxId = sandboxId;
            this.#manager.record(this.#name, {
                sandboxId,
                running: true,
                lastActivity: Date.now(),
                setupDone: false,
            });
            this.#manager.registerBox(this.#name, this);
            await this.#manager.options.saveBox(this.#rootId, {
                project: project.name,
                name: this.#name,
                sandboxId,
            });
            this.#manager.notice(
                "info",
                `Box ${this.#name} created in ${Math.round((Date.now() - began) / 1000)} s`,
            );
            started = true;
        } else if ((await backend.status(this.#spec())) !== "running") {
            this.#setState("starting");
            this.#manager.notice("info", `Starting box ${this.#name}…`);
            const began = Date.now();

            await backend.start(this.#spec());
            this.#manager.notice(
                "info",
                `Box ${this.#name} started in ${Math.round((Date.now() - began) / 1000)} s`,
            );
            this.#leaseUntil = 0;
            started = true;
        }

        await this.#renewLease(backend);
        this.#manager.record(this.#name!, {
            sandboxId: this.#sandboxId,
            lastActivity: Date.now(),
            running: true,
        });
        const ssh = await backend.sshArgs(this.#spec());

        if (this.#manager.recordOf(this.#name!).setupDone !== true) {
            this.#setState("setting-up");
            await this.#setup(ssh, backend);
            this.#manager.record(this.#name!, { setupDone: true });
        } else if (started) {
            await this.#resume(ssh, backend);
        }

        const bundle = await daemonBundle();
        const file = `/tmp/pocket-daemon-${bundle.hash}.mjs`;

        await this.#run(
            ssh,
            `test -f ${file} || { cat > ${file}.tmp && chmod 644 ${file}.tmp && mv ${file}.tmp ${file}; }`,
            {
                input: bundle.code,
                what: "upload the daemon",
            },
        );
        this.#setState("running");
        const command = `sudo -n -u ${backend.boxUser} -H ${backend.nodePath} ${file} /workspace`;

        return spawn(ssh[0]!, [...ssh.slice(1), command], { stdio: ["pipe", "pipe", "pipe"] });
    }

    /** First start of a new box: secrets, /workspace, setup.sh, then resume.sh. */
    async #setup(ssh: string[], backend: BoxBackend): Promise<void> {
        const project = this.#project_();
        const user = backend.boxUser;

        await this.#run(ssh, `sudo -n install -d -o ${user} -g ${user} /workspace`, {
            what: "create /workspace",
        });
        await this.#run(
            ssh,
            `sudo -n -u ${user} -H bash -c 'umask 077; mkdir -p ~/.pocket; cat > ~/.pocket/env'`,
            {
                input: project.secrets ?? "",
                what: "write the project's secrets",
            },
        );

        if (project.setup !== undefined) {
            this.#manager.notice("info", `Running ${project.name}/setup.sh in box ${this.#name}…`);
            const began = Date.now();

            await this.#script(ssh, backend, "setup", project.setup, SETUP_TIMEOUT_S);
            this.#manager.notice(
                "info",
                `setup.sh finished in ${Math.round((Date.now() - began) / 1000)} s`,
            );
        }

        await this.#resume(ssh, backend);
    }

    async #resume(ssh: string[], backend: BoxBackend): Promise<void> {
        const project = this.#project_();

        if (project.resume === undefined) {
            return;
        }

        try {
            await this.#script(ssh, backend, "resume", project.resume, RESUME_TIMEOUT_S);
        } catch (error) {
            this.#manager.notice(
                "warning",
                `resume.sh failed in box ${this.#name}: ${String(error)}`,
            );
        }
    }

    /** Runs a project script in /workspace as the box user, with the project's secrets; its log stays in the box. */
    async #script(
        ssh: string[],
        backend: BoxBackend,
        kind: "setup" | "resume",
        content: string,
        timeoutS: number,
    ): Promise<void> {
        const script = `/tmp/pocket-${kind}.sh`;
        const log = `/tmp/pocket-${kind}.log`;

        await this.#run(ssh, `cat > ${script} && chmod 755 ${script}`, {
            input: content,
            what: `upload ${kind}.sh`,
        });
        const run =
            `sudo -n -u ${backend.boxUser} -H bash -c 'set -a; [ -f ~/.pocket/env ] && . ~/.pocket/env; set +a; ` +
            `cd /workspace && timeout ${timeoutS} bash ${script}' > ${log} 2>&1; ` +
            `status=$?; tail -n 30 ${log}; exit $status`;

        await this.#run(ssh, run, { what: `run ${kind}.sh (log: ${log} in the box)` });
    }

    /** Runs one command in the box over SSH; rejects with its output when it fails. */
    #run(
        ssh: string[],
        command: string,
        options: { input?: string; what: string },
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(ssh[0]!, [...ssh.slice(1), command]);
            let output = "";

            child.stdout.on(
                "data",
                (chunk: Buffer) => (output = (output + chunk.toString("utf8")).slice(-8000)),
            );
            child.stderr.on(
                "data",
                (chunk: Buffer) => (output = (output + chunk.toString("utf8")).slice(-8000)),
            );
            child.stdin.on("error", () => {});
            child.stdin.end(options.input ?? "");
            child.on("error", reject);
            child.on("exit", (code) =>
                code === 0
                    ? resolve(output)
                    : reject(
                          new Error(
                              `could not ${options.what} in box ${this.#name} (exit ${String(code)}):\n${output.trim()}`,
                          ),
                      ),
            );
        });
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
        if (
            this.#sandboxId === undefined ||
            this.#leaseUntil - Date.now() > this.#manager.leaseMs - RENEW_MARGIN_MS
        ) {
            return;
        }

        try {
            await this.#renewLease(await this.#backend);
            this.#manager.record(this.#name!, { lastActivity: this.#lastActivity, running: true });
        } catch (error) {
            this.#manager.notice(
                "warning",
                `Could not renew the lease of box ${this.#name}: ${String(error)}`,
            );
        }
    }

    async #renewLease(backend: BoxBackend): Promise<void> {
        const until = Date.now() + this.#manager.leaseMs;

        await backend.renewLease(this.#spec(), until);
        this.#leaseUntil = until;
    }

    async #idleStop(): Promise<void> {
        if (this.#inFlight > 0 || Date.now() - this.#lastActivity < this.#manager.idleMs) {
            return;
        }

        this.#manager.notice("info", `Stopping idle box ${this.#name}`);
        await this.stopNow();
    }

    /** Stops the box now; the next call starts it again. */
    async stopNow(): Promise<void> {
        if (this.#sandboxId === undefined) {
            return;
        }

        clearTimeout(this.#idleTimer);
        this.#stopping ??= (async () => {
            this.#setState("stopping");
            await this.env.cleanup(BACKGROUND_CONTEXT);
            await (await this.#backend).stop(this.#spec());
            this.#manager.record(this.#name!, { lastActivity: this.#lastActivity, running: false });
            this.#setState("stopped");
        })()
            .catch((error: unknown) => {
                this.#manager.notice(
                    "warning",
                    `Could not stop box ${this.#name}: ${String(error)}`,
                );
            })
            .finally(() => {
                this.#stopping = undefined;
            });
        await this.#stopping;
    }

    /** Deletes the box at the provider. */
    async destroy(): Promise<void> {
        await this.detach();

        if (this.#sandboxId === undefined) {
            return;
        }

        await (await this.#backend).destroy(this.#spec());
        this.#manager.forget(this.#name!);
        this.#manager.notice("info", `Destroyed box ${this.#name}`);
        this.#sandboxId = undefined;
        this.#setState("none");
    }

    /** Server shutdown: close the connection, keep the box (the lease or the next start's reconcile handles it). */
    async detach(): Promise<void> {
        clearTimeout(this.#idleTimer);
        clearInterval(this.#renewTimer);
        await this.env.cleanup(BACKGROUND_CONTEXT);
    }
}
