/**
 * Paprika: sessions whose tools run in a remote box, and the boxes' lifecycle.
 *
 * - A session's box link lives in its catalogue entry (`SessionMeta.box`): the project, and once created the box's
 *   name and provider id. Forks copy it and so share the box.
 * - Sending a message in a box session prepares its box (`prepare`): a session with no box gets one, created from the
 *   provider's base image, with the project's secrets in ~/.pocket/env and its setup.sh run once; a stopped box is
 *   started and its resume.sh run. The prompt and tool calls wait for the same preparation. A link to a box that no
 *   longer exists gets a fresh box the same way.
 * - setup.sh runs once and is never retried: its result, log tail, and log path (~/.pocket/setup.log in the box) are
 *   recorded, shown in the app, and told to the agent when it failed. resume.sh's latest result is kept the same way.
 * - A box stops after `idleMs` with no call running or made. Every start and bit of activity keeps a provider-side
 *   lease `leaseMs` ahead, also while a long command runs, so the provider stops the box if this server dies.
 * - `box-state.json` records each box's last activity and script results, so a restarted server stops boxes that
 *   went idle meanwhile.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    asBoxRoot,
    asBoxUser,
    type BoxBackend,
    type BoxSpec,
    loadBoxBackend,
    shellQuote,
} from "./backend.ts";
import { ghShim, gitForgetCommand, gitSetupCommands } from "./box-files.ts";
import { daemonBundle } from "./bundle.ts";
import { RemoteExecutionEnv } from "./env.ts";
import { BOX_GIT_PORT, GitProxy } from "./git-proxy.ts";
import {
    PROJECT_FILES,
    type Project,
    type ProjectFile,
    readProject,
    saveProjectFiles,
} from "./projects.ts";

/** What a session's catalogue entry records about its box. */
export interface BoxLink {
    readonly project: string;
    readonly name?: string;
    readonly sandboxId?: string;
}

export type BoxState =
    "none" | "creating" | "setting-up" | "starting" | "running" | "stopping" | "stopped";

/** How a project script (setup.sh, resume.sh) ended. */
export interface ScriptResult {
    readonly ok: boolean;
    readonly exitCode: number;
    readonly at: number;
    /** Its log, in the box (logs stay there). */
    readonly log: string;
    /** The box started from this project snapshot, so setup.sh did not run in it (its log is the snapshot's). */
    readonly snapshot?: string;
}

/** A project's snapshot: its boxes start from it while `fingerprint` (base image and setup.sh) still matches. */
type ProjectSnapshot = { name: string; fingerprint: string; at: number };

/** The parts of the git proxy the boxes use (a fake one in tests). */
export interface BoxGitProxy {
    port(): Promise<number>;
    identity(): Promise<{ name: string; email: string }>;
    close(): void;
}

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
    /** The box backend; default: the module named by $PI_POCKET_BOX_BACKEND. */
    readonly backend?: Promise<BoxBackend>;
    /** The git proxy; default: one on this server for GitHub. */
    readonly gitProxy?: BoxGitProxy;
}

type BoxRecord = {
    lastActivity: number;
    running: boolean;
    sandboxId?: string;
    project?: string;
    /** The box's key for the git proxy; secret, also in the box's git config. */
    gitKey?: string;
    setup?: ScriptResult;
    resume?: ScriptResult;
    /** Older records: setup finished (before results were kept). */
    setupDone?: boolean;
    /** The project snapshot the box was created from. */
    fromSnapshot?: string;
};

type StateFile = {
    boxes: Record<string, BoxRecord>;
    projectSnapshots?: Record<string, ProjectSnapshot>;
};

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_LEASE_MS = 60 * 60_000;
/** Renew when less than this is left of the lease; also how often a long-running command renews it. */
const RENEW_MARGIN_MS = 10 * 60_000;
const SETUP_TIMEOUT_S = 30 * 60;
const RESUME_TIMEOUT_S = 5 * 60;
/** The largest file a box session's transcript shows from the box. */
const MAX_CACHED_FILE = 25 * 1024 * 1024;

export class BoxManager {
    readonly #options: BoxManagerOptions;
    /** By root conversation id. Sessions sharing a box share its runtime through `#byBox`. */
    readonly #runtimes = new Map<string, BoxRuntime>();
    readonly #byBox = new Map<string, BoxRuntime>();
    #state: StateFile | undefined;
    readonly gitProxy: BoxGitProxy;

    constructor(options: BoxManagerOptions) {
        this.#options = options;
        this.gitProxy =
            options.gitProxy ??
            new GitProxy({
                access: (key) => this.#access(key),
                log: (line) => this.notice("info", line),
            });
    }

    /** Which box a git proxy key belongs to, and the repositories its project allows. */
    #access(key: string): { box: string; repos: readonly string[] } | undefined {
        for (const [box, entry] of Object.entries(this.#loadState().boxes)) {
            if (entry.gitKey === key && entry.project !== undefined) {
                return { box, repos: readProject(entry.project)?.repos ?? [] };
            }
        }

        return undefined;
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

    #backend(project: string): Promise<BoxBackend> {
        const backend = this.#options.backend ?? loadBoxBackend();

        if (backend === undefined) {
            throw new Error(`Session uses project ${project}, but no box backend is configured`);
        }

        return backend;
    }

    /** The runtime of a root conversation's box, or undefined for a local session. */
    #runtime(rootId: string): BoxRuntime | undefined {
        const link = this.#options.sessionBox(rootId);

        if (link === undefined) {
            return undefined;
        }

        const shared = link.name === undefined ? undefined : this.#byBox.get(link.name);
        let runtime = this.#runtimes.get(rootId);

        if (shared !== undefined && runtime !== shared) {
            runtime = shared;
            this.#runtimes.set(rootId, runtime);
        }

        if (runtime === undefined) {
            runtime = new BoxRuntime(this, rootId, link, this.#backend(link.project));
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

    /**
     * A message was sent in this session: create or start its box now, so it is ready when the prompt and tools
     * need it. Failures are reported as notices; the next use tries again.
     */
    prepare(rootId: string | number): Promise<void> | undefined {
        const runtime = this.#runtime(String(rootId));

        return runtime === undefined
            ? undefined
            : runtime.ensure().then(
                  () => undefined,
                  (error: unknown) =>
                      this.notice("warning", `Could not prepare the box: ${describe(error)}`),
              );
    }

    /**
     * Files sent with a message in a box session: where they will be in the box. They are copied in once the box is
     * ready, and the prompt waits for that. Undefined for a local session.
     */
    async uploads(
        rootId: string | number,
        conversationId: string | number,
        files: readonly { path: string }[],
    ): Promise<Map<string, string> | undefined> {
        const runtime = this.#runtime(String(rootId));

        if (runtime === undefined || files.length === 0) {
            return undefined;
        }

        const backend = await this.#backend(this.#options.sessionBox(String(rootId))!.project);
        const home = backend.home ?? `/home/${backend.boxUser}`;
        const paths = new Map(
            files.map((file) => [
                file.path,
                `${home}/.pocket/uploads/${String(conversationId)}/${basename(file.path)}`,
            ]),
        );

        runtime.queueUploads([...paths].map(([localPath, boxPath]) => ({ localPath, boxPath })));

        return paths;
    }

    /**
     * An image (or other file) the agent named in a box session, as a file on this server: copied from the box into
     * `box-files/<session>/` the first time, while the box runs, and served from there after that, so showing a
     * transcript never needs the box. Undefined when it is not cached and the box is not running: reading never
     * starts a box. `path` is absolute, `~/…`, or relative to the workspace.
     */
    async cachedFile(rootId: string | number, path: string): Promise<string | undefined> {
        const id = String(rootId);
        const runtime = this.#runtime(id);
        const link = this.#options.sessionBox(id);

        if (runtime === undefined || link === undefined) {
            throw new Error("not a box session");
        }

        const backend = await this.#backend(link.project);
        const workspace = backend.workspace ?? "/workspace";
        const boxPath = await this.boxPath(id, path);
        const local = join(
            this.#options.dataDir,
            "box-files",
            id,
            `${createHash("sha256").update(boxPath).digest("hex").slice(0, 32)}${extname(boxPath).toLowerCase()}`,
        );

        if (existsSync(local)) {
            return local;
        }

        // Only a box that is running right now, by its provider's word: a stale "running" must not start it.
        if (
            link.sandboxId === undefined ||
            link.name === undefined ||
            (await backend.status({
                name: link.name,
                sandboxId: link.sandboxId,
                cwd: workspace,
            })) !== "running"
        ) {
            return undefined;
        }

        const read = await runtime.env.readBinaryFile(boxPath, BACKGROUND_CONTEXT);

        if (!read.ok) {
            throw read.error;
        }

        if (read.value.byteLength > MAX_CACHED_FILE) {
            throw new Error(`${path} is too large to show`);
        }

        mkdirSync(dirname(local), { recursive: true, mode: 0o700 });
        writeFileSync(local, read.value, { mode: 0o600 });

        return local;
    }

    /** A path as a box session means it, in the box: absolute, `~/\u2026` (the box user's home), or in the workspace. */
    async boxPath(rootId: string | number, path: string): Promise<string> {
        const link = this.#options.sessionBox(String(rootId));

        if (link === undefined) {
            throw new Error("not a box session");
        }

        const backend = await this.#backend(link.project);
        const trimmed = path.trim();

        return trimmed === "~" || trimmed.startsWith("~/")
            ? `${backend.home ?? `/home/${backend.boxUser}`}${trimmed.slice(1)}`
            : isAbsolute(trimmed)
              ? trimmed
              : join(backend.workspace ?? "/workspace", trimmed);
    }

    /**
     * The environment of a box session whose box is running now, for the app's own panels; undefined when the box is
     * stopped (or was not used since this server started). Never starts a box.
     */
    runningEnv(rootId: string | number): RemoteExecutionEnv | undefined {
        // Made when missing: after a restart, a box can be running before anything here used it.
        const runtime = this.#runtime(String(rootId));

        return runtime?.state === "running" ? runtime.env : undefined;
    }

    /** A box session's state for the UI; undefined for a local session. */
    stateOf(
        rootId: string | number,
    ): { project: string; name?: string; state: BoxState; setup?: ScriptResult } | undefined {
        const link = this.#options.sessionBox(String(rootId));

        if (link === undefined) {
            return undefined;
        }

        const runtime = this.#runtimes.get(String(rootId));
        const record = link.name === undefined ? undefined : this.#loadState().boxes[link.name];

        return {
            project: link.project,
            ...(link.name === undefined ? {} : { name: link.name }),
            state:
                runtime?.state ??
                (link.sandboxId === undefined
                    ? "none"
                    : record?.running === true
                      ? "running"
                      : "stopped"),
            ...(record?.setup === undefined ? {} : { setup: record.setup }),
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

    recordOf(name: string): BoxRecord {
        return this.#loadState().boxes[name] ?? { lastActivity: 0, running: false };
    }

    record(name: string, patch: Partial<BoxRecord>): void {
        this.#loadState().boxes[name] = { ...this.recordOf(name), ...patch };
        this.#save();
    }

    forget(name: string): void {
        delete this.#loadState().boxes[name];
        this.#save();
    }

    /**
     * What a project's snapshot would be made from now: the backend's base image and the project's setup.sh.
     * Undefined when the backend cannot snapshot or the project has no setup.sh (nothing to save time on).
     */
    async snapshotFingerprint(backend: BoxBackend, project: Project): Promise<string | undefined> {
        if (backend.snapshot === undefined || project.setup === undefined) {
            return undefined;
        }

        return createHash("sha256")
            .update(`${(await backend.baseImage?.()) ?? ""}\0${project.setup}`)
            .digest("hex")
            .slice(0, 12);
    }

    /** The project's snapshot, when it was made from what the project's boxes would be made from now. */
    async usableSnapshot(
        backend: BoxBackend,
        project: Project,
    ): Promise<ProjectSnapshot | undefined> {
        const saved = this.#loadState().projectSnapshots?.[project.name];
        const fingerprint = await this.snapshotFingerprint(backend, project);

        return saved !== undefined && fingerprint !== undefined && saved.fingerprint === fingerprint
            ? saved
            : undefined;
    }

    projectSnapshot(project: string): ProjectSnapshot | undefined {
        return this.#loadState().projectSnapshots?.[project];
    }

    setProjectSnapshot(project: string, snapshot: ProjectSnapshot): void {
        const state = this.#loadState();

        state.projectSnapshots = { ...state.projectSnapshots, [project]: snapshot };
        this.#save();
    }

    readonly #snapshotting = new Map<string, Promise<void>>();

    /** Runs `save` unless a snapshot of the project is being saved already (by another box). */
    snapshotOnce(project: string, save: () => Promise<void>): Promise<void> {
        if (this.#snapshotting.has(project)) {
            return Promise.resolve();
        }

        const saving = save().finally(() => this.#snapshotting.delete(project));

        this.#snapshotting.set(project, saving);

        return saving;
    }

    #save(): void {
        try {
            writeFileSync(this.#statePath(), `${JSON.stringify(this.#loadState(), null, 2)}\n`, {
                mode: 0o600,
            });
        } catch (error) {
            this.notice("warning", `Could not save box state: ${describe(error)}`);
        }
    }

    /** At startup: stop boxes that were left running and have been idle longer than `idleMs`. */
    async reconcile(): Promise<void> {
        const backendLoad = this.#options.backend ?? loadBoxBackend();

        if (backendLoad === undefined) {
            return;
        }

        const backend = await backendLoad;

        for (const [name, entry] of Object.entries(this.#loadState().boxes)) {
            if (!entry.running || entry.sandboxId === undefined) {
                continue;
            }

            if (Date.now() - entry.lastActivity < this.idleMs) {
                // Running and not idle long yet: its session's runtime takes over, and stops it once it is.
                const prefix = `pocket-${entry.project ?? ""}-`;
                const rootId = name.startsWith(prefix) ? name.slice(prefix.length) : undefined;

                if (rootId !== undefined && this.#options.sessionBox(rootId)?.name === name) {
                    this.#runtime(rootId);
                }

                continue;
            }

            const spec = {
                name,
                sandboxId: entry.sandboxId,
                cwd: backend.workspace ?? "/workspace",
            };

            try {
                if ((await backend.status(spec)) === "running") {
                    await backend.stop(spec);
                    this.notice("info", `Stopped box ${name}: idle while the server was down`);
                }

                this.record(name, { running: false });
            } catch (error) {
                this.notice("warning", `Could not stop idle box ${name}: ${describe(error)}`);
            }
        }
    }

    async dispose(): Promise<void> {
        await Promise.all([...new Set(this.#runtimes.values())].map((runtime) => runtime.detach()));
        this.gitProxy.close();
    }
}

/** One box: readiness (creation, start, scripts), the daemon connection, idle stop, and lease. */
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
    /** The preparation in progress; everyone who needs the box waits for the same one. */
    #ensuring: Promise<{ ssh: string[]; backend: BoxBackend }> | undefined;
    /** Copies of sent files still on their way into the box. */
    #uploads: Promise<void>[] = [];

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
            box: {
                ready: async () => {
                    await this.ensure();
                    // Files sent with a message are in the box before the model hears of them.
                    await Promise.all(this.#uploads);
                },
                status: () => this.#statusText(),
                saveProjectFiles: (files, message) => this.#saveProjectFiles(files, message),
                resolveSetup: () => {
                    if (this.#name !== undefined) {
                        this.#manager.record(this.#name, {
                            setup: {
                                ok: true,
                                exitCode: 0,
                                at: Date.now(),
                                log: "~/.pocket/setup.log",
                            },
                        });
                    }
                },
            },
            localReadPaths: manager.options.localReadPaths(),
            onActivity: (event) => this.#activity(event),
        });

        // What the box was when this server last knew (before a restart, say): a running one is stopped once idle.
        if (link.name !== undefined && link.sandboxId !== undefined) {
            const record = manager.recordOf(link.name);

            this.state = record.running ? "running" : "stopped";

            if (record.running) {
                this.#lastActivity = record.lastActivity;
                this.#idleTimer = setTimeout(
                    () => void this.#idleStop(),
                    Math.max(0, record.lastActivity + manager.idleMs - Date.now()) + 1000,
                );
            }
        }

        void backend.then((resolved) => {
            this.env.cwd = resolved.workspace ?? "/workspace";
        });
    }

    #spec(backend: BoxBackend): BoxSpec {
        return {
            name: this.#name!,
            sandboxId: this.#sandboxId!,
            cwd: backend.workspace ?? "/workspace",
        };
    }

    #setState(state: BoxState): void {
        this.state = state;
        this.#manager.options.onState?.(this.#rootId, state);
    }

    #readProject(): Project {
        const project = readProject(this.#project);

        if (project === undefined) {
            throw new Error(`project ${this.#project} does not exist`);
        }

        return project;
    }

    /** What the agent should know about the box's scripts: failures of setup.sh or of the latest resume.sh. */
    #statusText(): string | undefined {
        let project: Project | undefined;

        try {
            project = readProject(this.#project);
        } catch {
            // Unreadable project.json: the name will do.
        }

        const day = (at: number) => new Date(at).toISOString().slice(0, 10);
        const record = this.#name === undefined ? undefined : this.#manager.recordOf(this.#name);
        const snapshot = this.#manager.projectSnapshot(this.#project);
        const lines = [
            `Project: ${project?.title ?? this.#project} (${this.#project}). It may write to: ${project === undefined || project.repos.length === 0 ? "no repositories" : project.repos.join(", ")}.`,
        ];

        if (project !== undefined && project.setup === undefined) {
            lines.push(
                "The project has no setup.sh yet: its boxes start from the base image with an empty /workspace.",
            );
        } else if (record?.setup?.snapshot !== undefined) {
            lines.push(
                `This box was created from the project's snapshot${snapshot?.name === record.setup.snapshot ? ` of ${day(snapshot.at)}` : ""}, so setup.sh did not run in it; ~/.pocket/setup.log is from the run the snapshot was saved after.`,
            );
        } else if (record?.setup?.ok === true) {
            lines.push(`setup.sh ran in this box when it was created, on ${day(record.setup.at)}.`);
        }

        const notes: string[] = [lines.join("\n")];

        if (record === undefined) {
            return notes.join("\n\n");
        }

        if (record.setup !== undefined && !record.setup.ok) {
            notes.push(
                `This box's setup.sh failed when the box was created (exit ${record.setup.exitCode}); the box may be ` +
                    `missing what the project needs. The script is ~/.pocket/setup.sh and its log ${record.setup.log}. ` +
                    `Before anything else: find out why it failed, explain it to the user, and ask what to do next. ` +
                    `Do not fix or rerun it unless they ask. When it is settled, save_project_files with ` +
                    `setupResolved: true removes this note.`,
            );
        }

        if (record.resume !== undefined && !record.resume.ok) {
            notes.push(
                `This box's resume.sh failed when the box last started (exit ${record.resume.exitCode}); its log is ` +
                    `${record.resume.log}. Tell the user, and look into it if they ask.`,
            );
        }

        return notes.join("\n\n");
    }

    /** Creates or starts the box and runs its scripts, once for everyone who needs it now. */
    ensure(): Promise<{ ssh: string[]; backend: BoxBackend }> {
        this.#ensuring ??= this.#ensure().finally(() => {
            this.#ensuring = undefined;
        });

        return this.#ensuring;
    }

    async #ensure(): Promise<{ ssh: string[]; backend: BoxBackend }> {
        await this.#stopping;
        const backend = await this.#backend;
        let started = false;

        try {
            if (
                this.#sandboxId !== undefined &&
                (await backend.status(this.#spec(backend))) === "missing"
            ) {
                this.#manager.notice(
                    "warning",
                    `Box ${this.#name} no longer exists; creating a new one`,
                );
                this.#manager.forget(this.#name!);
                this.#sandboxId = undefined;
            }

            if (this.#sandboxId === undefined) {
                await this.#create(backend);
                started = true;
            } else if ((await backend.status(this.#spec(backend))) !== "running") {
                this.#setState("starting");
                this.#manager.notice("info", `Starting box ${this.#name}…`);
                const began = Date.now();

                await backend.start(this.#spec(backend));
                this.#manager.notice("info", `Box ${this.#name} started in ${seconds(began)}`);
                this.#leaseUntil = 0;
                started = true;
            }

            await this.#renewLease(backend);
            this.#manager.record(this.#name!, {
                sandboxId: this.#sandboxId,
                lastActivity: Date.now(),
                running: true,
            });
            // Every connection carries the git tunnel: 127.0.0.1:BOX_GIT_PORT in the box reaches the git proxy here.
            const ssh = await backend.sshArgs(this.#spec(backend), {
                forward: { boxPort: BOX_GIT_PORT, localPort: await this.#manager.gitProxy.port() },
            });
            const record = this.#manager.recordOf(this.#name!);

            if (record.setup === undefined && record.setupDone !== true) {
                this.#setState("setting-up");
                await this.#setup(ssh, backend);
            } else if (started) {
                await this.#resume(ssh, backend);
            }

            this.#setState("running");

            return { ssh, backend };
        } catch (error) {
            this.#setState(this.#sandboxId === undefined ? "none" : "stopped");

            throw error;
        }
    }

    async #create(backend: BoxBackend): Promise<void> {
        const project = this.#readProject();

        this.#name = `pocket-${project.name}-${this.#rootId}`;
        this.#setState("creating");
        this.#manager.notice("info", `Creating box ${this.#name}…`);
        const began = Date.now();
        const from = await this.#manager.usableSnapshot(backend, project);
        const { sandboxId } = await backend.create({
            name: this.#name,
            project: project.name,
            ...(from === undefined ? {} : { from: from.name }),
        });

        this.#sandboxId = sandboxId;
        this.#manager.record(this.#name, {
            sandboxId,
            project: project.name,
            gitKey: randomBytes(24).toString("base64url"),
            running: true,
            lastActivity: Date.now(),
            ...(from === undefined ? {} : { fromSnapshot: from.name }),
        });
        this.#manager.registerBox(this.#name, this);
        await this.#manager.options.saveBox(this.#rootId, {
            project: project.name,
            name: this.#name,
            sandboxId,
        });
        this.#manager.notice(
            "info",
            `Box ${this.#name} created in ${seconds(began)}${from === undefined ? "" : ` from ${from.name}`}`,
        );
    }

    async #connect(_context: Context): Promise<ChildProcessWithoutNullStreams> {
        const { ssh, backend } = await this.ensure();
        const bundle = await daemonBundle();
        const file = `/tmp/pocket-daemon-${bundle.hash}.mjs`;
        const upload = await this.#run(
            ssh,
            `test -f ${file} || { cat > ${file}.tmp && chmod 644 ${file}.tmp && mv ${file}.tmp ${file}; }`,
            bundle.code,
        );

        if (upload.code !== 0) {
            throw new Error(
                `could not upload the daemon to box ${this.#name}: ${upload.output.trim()}`,
            );
        }

        const workspace = backend.workspace ?? "/workspace";

        return spawn(
            ssh[0]!,
            [...ssh.slice(1), asBoxUser(backend, `${backend.nodePath} ${file} ${workspace}`)],
            {
                stdio: ["pipe", "pipe", "pipe"],
            },
        );
    }

    /**
     * First start of a new box: /workspace, the project's secrets, git, then setup.sh (once: its result is recorded,
     * and a failure is reported but not retried) and resume.sh. Failing to reach the box is an error instead.
     */
    async #setup(ssh: string[], backend: BoxBackend): Promise<void> {
        const project = this.#readProject();
        const workspace = backend.workspace ?? "/workspace";

        await this.#must(
            ssh,
            asBoxRoot(
                backend,
                `install -d -o ${backend.boxUser} -g ${backend.boxUser} ${workspace}`,
            ),
            "create the workspace",
        );
        await this.#writeSecrets(ssh, backend, project);
        await this.#setupGit(ssh, backend, project);

        // The project's files, as working copies in the box: the scripts run from there, and the agent may change
        // them and save them back to the project (save_project_files).
        for (const [file, content] of [
            ["setup.sh", project.setup],
            ["resume.sh", project.resume],
            ["AGENTS.md", project.agents],
        ] as const) {
            if (content !== undefined) {
                await this.#must(
                    ssh,
                    asBoxUser(
                        backend,
                        `cat > ~/.pocket/${file}${file.endsWith(".sh") ? ` && chmod 755 ~/.pocket/${file}` : ""}`,
                    ),
                    `copy ${file} into the box`,
                    content,
                );
            }
        }

        const fromSnapshot = this.#manager.recordOf(this.#name!).fromSnapshot;

        if (fromSnapshot !== undefined) {
            // Made from the project's snapshot: setup.sh ran when the snapshot was saved.
            this.#manager.record(this.#name!, {
                setup: {
                    ok: true,
                    exitCode: 0,
                    at: Date.now(),
                    log: "~/.pocket/setup.log",
                    snapshot: fromSnapshot,
                },
            });
        } else if (project.setup !== undefined) {
            this.#manager.notice("info", `Running ${project.name}/setup.sh in box ${this.#name}…`);
            const result = await this.#script(ssh, backend, "setup", SETUP_TIMEOUT_S);

            this.#manager.record(this.#name!, { setup: result });
            this.#manager.notice(
                result.ok ? "info" : "warning",
                result.ok
                    ? `setup.sh finished in box ${this.#name}`
                    : `setup.sh failed in box ${this.#name} (exit ${result.exitCode}); log: ${result.log} in the box`,
            );

            if (result.ok) {
                await this.#saveSnapshot(ssh, backend, project);
            }
        } else {
            this.#manager.record(this.#name!, {
                setup: { ok: true, exitCode: 0, at: Date.now(), log: "" },
            });
        }

        await this.#resume(ssh, backend);
    }

    /** The project's secrets, to ~/.pocket/env (which also makes ~/.pocket/). */
    async #writeSecrets(ssh: string[], backend: BoxBackend, project: Project): Promise<void> {
        await this.#must(
            ssh,
            asBoxUser(backend, "umask 077; mkdir -p ~/.pocket/bin; cat > ~/.pocket/env"),
            "write the project's secrets",
            project.secrets ?? "",
        );
    }

    /**
     * After a successful setup.sh: saves the box as its project's snapshot, so the project's next boxes start from it
     * instead of running setup.sh, and deletes the project's older snapshot. The box's own secrets (the project's
     * secrets, its git key and the git URL rewrites holding it) are out of the box while the snapshot is saved, and
     * back after. A failure is reported, and the box goes on.
     */
    async #saveSnapshot(ssh: string[], backend: BoxBackend, project: Project): Promise<void> {
        const fingerprint = await this.#manager.snapshotFingerprint(backend, project);
        const previous = this.#manager.projectSnapshot(project.name);

        if (
            fingerprint === undefined ||
            backend.snapshot === undefined ||
            previous?.fingerprint === fingerprint
        ) {
            return;
        }

        const name = `pocket-${project.name}-${fingerprint}`;
        const gitKey = this.#manager.recordOf(this.#name!).gitKey ?? "";

        await this.#manager.snapshotOnce(project.name, async () => {
            this.#manager.notice(
                "info",
                `Saving ${project.name}'s snapshot ${name}, for its next boxes…`,
            );
            const began = Date.now();

            try {
                await this.#must(
                    ssh,
                    asBoxUser(
                        backend,
                        `rm -f ~/.pocket/env ~/.pocket/git-key; ${gitForgetCommand(gitKey)}; sync`,
                    ),
                    "take the box's secrets out for the snapshot",
                );

                try {
                    await backend.snapshot!(this.#spec(backend), name);
                } finally {
                    await this.#writeSecrets(ssh, backend, project);
                    await this.#setupGit(ssh, backend, project);
                }
            } catch (error) {
                this.#manager.notice(
                    "warning",
                    `Could not save ${project.name}'s snapshot: ${describe(error)}`,
                );

                return;
            }

            this.#manager.setProjectSnapshot(project.name, { name, fingerprint, at: Date.now() });
            this.#manager.notice(
                "info",
                `Saved ${project.name}'s snapshot ${name} in ${seconds(began)}: its next boxes start from it`,
            );

            if (previous !== undefined && previous.name !== name) {
                await backend
                    .deleteSnapshot?.(previous.name)
                    .catch((error: unknown) =>
                        this.#manager.notice(
                            "warning",
                            `Could not delete ${project.name}'s older snapshot ${previous.name}: ${describe(error)}`,
                        ),
                    );
            }
        });
    }

    /** GitHub through the git proxy on this server: the box's key, git's URL rewrites and identity, and `gh`. */
    async #setupGit(ssh: string[], backend: BoxBackend, project: Project): Promise<void> {
        let gitKey = this.#manager.recordOf(this.#name!).gitKey;

        if (gitKey === undefined) {
            gitKey = randomBytes(24).toString("base64url");
            this.#manager.record(this.#name!, { gitKey, project: project.name });
        }

        const pathLine = `grep -q pocket/bin ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.pocket/bin:$PATH"' >> ~/.bashrc`;

        await this.#must(
            ssh,
            asBoxUser(backend, "umask 077; cat > ~/.pocket/git-key"),
            "write the git key",
            gitKey,
        );
        await this.#must(
            ssh,
            asBoxUser(backend, "cat > ~/.pocket/bin/gh && chmod 755 ~/.pocket/bin/gh"),
            "install gh",
            ghShim(backend.nodePath),
        );
        await this.#must(
            ssh,
            asBoxUser(backend, gitSetupCommands(gitKey, await this.#manager.gitProxy.identity())),
            "configure git",
        );
        await this.#must(ssh, asBoxUser(backend, pathLine), "put ~/.pocket/bin on PATH");
    }

    /** Runs the box's ~/.pocket/resume.sh, if any, and records how it went; the box stays usable either way. */
    async #resume(ssh: string[], backend: BoxBackend): Promise<void> {
        const present = await this.#run(ssh, asBoxUser(backend, "test -f ~/.pocket/resume.sh"));

        if (present.code !== 0) {
            return;
        }

        const result = await this.#script(ssh, backend, "resume", RESUME_TIMEOUT_S);

        this.#manager.record(this.#name!, { resume: result });

        if (!result.ok) {
            this.#manager.notice(
                "warning",
                `resume.sh failed in box ${this.#name} (exit ${result.exitCode})`,
            );
        }
    }

    /**
     * Runs the box's copy of a project script (~/.pocket/<kind>.sh) in the workspace as the box user, with the
     * project's secrets. Its output goes to ~/.pocket/<kind>.log and stays in the box.
     */
    async #script(
        ssh: string[],
        backend: BoxBackend,
        kind: "setup" | "resume",
        timeoutS: number,
    ): Promise<ScriptResult> {
        const log = `~/.pocket/${kind}.log`;
        const workspace = backend.workspace ?? "/workspace";
        const run = await this.#run(
            ssh,
            asBoxUser(
                backend,
                `set -a; [ -f ~/.pocket/env ] && . ~/.pocket/env; set +a; export PATH="$HOME/.pocket/bin:$PATH"; ` +
                    `cd ${workspace} && timeout ${timeoutS} bash -l ~/.pocket/${kind}.sh > ${log} 2>&1`,
            ),
        );

        return { ok: run.code === 0, exitCode: run.code, at: Date.now(), log };
    }

    /** Copies the box's working copies of project files back to the project on this server, committed and pushed. */
    async #saveProjectFiles(files: readonly string[], message: string): Promise<string> {
        const { ssh, backend } = await this.ensure();
        const contents: Partial<Record<ProjectFile, string>> = {};

        for (const file of files) {
            if (!(PROJECT_FILES as readonly string[]).includes(file)) {
                throw new Error(`${file} is not a project file (${PROJECT_FILES.join(", ")})`);
            }

            contents[file as ProjectFile] = await this.#readFile(
                ssh,
                asBoxUser(backend, `cat ~/.pocket/${file}`),
                file,
            );
        }

        return saveProjectFiles(
            this.#project,
            contents,
            message,
            await this.#manager.gitProxy.identity(),
        );
    }

    /** Runs one command in the box; rejects with its output when it fails. */
    async #must(ssh: string[], command: string, what: string, input?: string): Promise<string> {
        const result = await this.#run(ssh, command, input);

        if (result.code !== 0) {
            throw new Error(
                `could not ${what} in box ${this.#name} (exit ${result.code}): ${result.output.trim()}`,
            );
        }

        return result.output;
    }

    /** A file's whole content, from a command that prints it to stdout. */
    #readFile(ssh: string[], command: string, file: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(ssh[0]!, [...ssh.slice(1), command]);
            const chunks: Buffer[] = [];
            let stderr = "";

            child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
            child.stderr.on("data", (chunk: Buffer) => {
                stderr = (stderr + chunk.toString("utf8")).slice(-2000);
            });
            child.stdin.end();
            child.on("error", reject);
            child.on("exit", (code) =>
                code === 0
                    ? resolve(Buffer.concat(chunks).toString("utf8"))
                    : reject(
                          new Error(
                              `could not read ~/.pocket/${file} in the box: ${stderr.trim()}`,
                          ),
                      ),
            );
        });
    }

    /**
     * Copies files sent with a message into the box once it is ready; `ready()` waits for them. Returns at once.
     * A failed copy is reported; the message still goes out.
     */
    queueUploads(files: readonly { localPath: string; boxPath: string }[]): void {
        const copying = (async () => {
            const { ssh, backend } = await this.ensure();

            for (const file of files) {
                const directory = file.boxPath.slice(0, file.boxPath.lastIndexOf("/"));
                const result = await this.#run(
                    ssh,
                    asBoxUser(
                        backend,
                        `mkdir -p ${shellQuote(directory)} && cat > ${shellQuote(file.boxPath)}`,
                    ),
                    readFileSync(file.localPath),
                );

                if (result.code !== 0) {
                    this.#manager.notice(
                        "warning",
                        `Could not copy ${file.boxPath} into box ${this.#name}: ${result.output.trim()}`,
                    );
                }
            }
        })().catch((error: unknown) =>
            this.#manager.notice(
                "warning",
                `Could not copy files into the box: ${describe(error)}`,
            ),
        );

        this.#uploads.push(copying);
        void copying.finally(() => {
            this.#uploads = this.#uploads.filter((each) => each !== copying);
        });
    }

    /** Runs one command in the box over SSH: its exit code and the end of its output. */
    #run(
        ssh: string[],
        command: string,
        input?: string | Buffer,
    ): Promise<{ code: number; output: string }> {
        return new Promise((resolve, reject) => {
            const child = spawn(ssh[0]!, [...ssh.slice(1), command]);
            let output = "";

            const collect = (chunk: Buffer): void => {
                output = (output + chunk.toString("utf8")).slice(-8000);
            };

            child.stdout.on("data", collect);
            child.stderr.on("data", collect);
            child.stdin.on("error", () => {});
            child.stdin.end(input ?? "");
            child.on("error", reject);
            child.on("exit", (code) => resolve({ code: code ?? 1, output }));
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
                `Could not renew the lease of box ${this.#name}: ${describe(error)}`,
            );
        }
    }

    async #renewLease(backend: BoxBackend): Promise<void> {
        const until = Date.now() + this.#manager.leaseMs;

        await backend.renewLease(this.#spec(backend), until);
        this.#leaseUntil = until;
    }

    async #idleStop(): Promise<void> {
        if (this.#inFlight > 0 || Date.now() - this.#lastActivity < this.#manager.idleMs) {
            return;
        }

        this.#manager.notice("info", `Stopping idle box ${this.#name}`);
        await this.stopNow();
    }

    /** Stops the box now; the next use starts it again. */
    async stopNow(): Promise<void> {
        if (this.#sandboxId === undefined) {
            return;
        }

        clearTimeout(this.#idleTimer);
        this.#stopping ??= (async () => {
            await this.#ensuring?.catch(() => {});
            this.#setState("stopping");
            await this.env.cleanup(BACKGROUND_CONTEXT);
            const backend = await this.#backend;

            await backend.stop(this.#spec(backend));
            this.#manager.record(this.#name!, { lastActivity: this.#lastActivity, running: false });
            this.#setState("stopped");
        })()
            .catch((error: unknown) => {
                this.#manager.notice(
                    "warning",
                    `Could not stop box ${this.#name}: ${describe(error)}`,
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

        const backend = await this.#backend;

        await backend.destroy(this.#spec(backend));
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

function seconds(since: number): string {
    return `${Math.round((Date.now() - since) / 1000)} s`;
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
