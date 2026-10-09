/**
 * Paprika: an ExecutionEnv whose files and commands are in a remote box.
 *
 * Every call is forwarded to the box's daemon (daemon.ts) over one long-lived connection, which `connect` opens
 * (in production an SSH session into the box; in tests a local process). The connection opens on first use and
 * again after it drops; calls in flight when it drops fail with an error result. Reads of `localReadPaths` (such as
 * Pi's global skills on the server) are answered from the server instead.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
    type ExecutionEnv,
    ExecutionError,
    FileError,
    type FileInfo,
    type Result,
    type ShellExecOptions,
    type ShellExecResult,
    type TextLine,
    type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { decode, encode, lineSplitter, PROTOCOL_VERSION, type Reply } from "./protocol.ts";

export interface RemoteEnvOptions {
    /** Stable identity of the box: edits to one file are serialized per environment id. */
    readonly id: string;
    /** Working directory inside the box. */
    readonly cwd: string;
    /** The project the box runs, for its prompt instructions. */
    readonly project?: string;
    /** Opens a connection whose stdin/stdout speak the daemon protocol. Called again after a connection drops. */
    connect(context: Context): Promise<ChildProcessWithoutNullStreams>;
    /** Absolute server paths whose reads are served from the server (read-only), e.g. global skills. */
    readonly localReadPaths?: readonly string[];
    /** Called when a call starts and when it settles; drives idle stop and lease renewal. */
    onActivity?(event: "start" | "end"): void;
    /** How long to wait for the daemon's hello. */
    readonly helloTimeoutMs?: number;
}

/** The longest a command in a box may run, in seconds. */
const MAX_COMMAND_SECONDS = 600;

type Pending = {
    resolve(value: unknown): void;
    reject(error: Error): void;
    onOutput?: (text: string) => void;
};

type Connection = { process: ChildProcessWithoutNullStreams; pending: Map<number, Pending> };

export class RemoteExecutionEnv implements ExecutionEnv {
    /** Marks a remote environment, for the system prompt's box section. */
    readonly remote = true;
    readonly id: string;
    readonly project: string | undefined;
    cwd: string;
    readonly #options: RemoteEnvOptions;
    readonly #local: NodeExecutionEnv | undefined;
    #connection: Promise<Connection> | undefined;
    #nextId = 1;

    constructor(options: RemoteEnvOptions) {
        this.#options = options;
        this.id = options.id;
        this.cwd = options.cwd;
        this.project = options.project;
        this.#local =
            options.localReadPaths !== undefined && options.localReadPaths.length > 0
                ? new NodeExecutionEnv({ cwd: "/" })
                : undefined;
    }

    // --- connection -------------------------------------------------------------------------------------------

    #connect(context: Context): Promise<Connection> {
        this.#connection ??= this.#open(context).catch((error: unknown) => {
            this.#connection = undefined;

            throw error;
        });

        return this.#connection;
    }

    async #open(context: Context): Promise<Connection> {
        const child = await this.#options.connect(context);
        const pending = new Map<number, Pending>();
        const connection: Connection = { process: child, pending };
        let stderr = "";

        // Writes after the connection dropped fail with EPIPE; the exit handler reports the drop.
        child.stdin.on("error", () => {});
        child.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString("utf8")).slice(-4000);
        });

        return await new Promise<Connection>((resolveHello, rejectHello) => {
            let greeted = false;
            const timer = setTimeout(
                () =>
                    fail(
                        new Error(
                            `remote env: no hello from daemon after ${this.#helloTimeoutMs()} ms`,
                        ),
                    ),
                this.#helloTimeoutMs(),
            );

            const fail = (error: Error): void => {
                clearTimeout(timer);

                for (const call of pending.values()) {
                    call.reject(error);
                }

                pending.clear();

                if (this.#connection !== undefined && greeted) {
                    this.#connection = undefined;
                }

                if (!greeted) {
                    rejectHello(error);
                }

                child.kill();
            };

            child.on("error", (error) => fail(error));
            child.on("exit", (code, signal) => {
                const detail =
                    stderr.trim() === ""
                        ? ""
                        : `: ${stderr.trim().split("\n").slice(-3).join(" | ")}`;

                fail(
                    new Error(
                        `remote env connection closed (${signal ?? `exit ${String(code)}`})${detail}`,
                    ),
                );
            });
            child.stdout.on(
                "data",
                lineSplitter((line) => {
                    const reply = JSON.parse(line) as Reply;

                    if ("hello" in reply) {
                        if (reply.hello.version !== PROTOCOL_VERSION) {
                            fail(
                                new Error(
                                    `remote env: daemon protocol ${reply.hello.version}, expected ${PROTOCOL_VERSION}`,
                                ),
                            );

                            return;
                        }

                        greeted = true;
                        clearTimeout(timer);
                        resolveHello(connection);

                        return;
                    }

                    const call = pending.get(reply.id);

                    if (call === undefined) {
                        return;
                    }

                    if ("output" in reply) {
                        call.onOutput?.(reply.output);
                    } else if ("failure" in reply) {
                        pending.delete(reply.id);
                        call.reject(new Error(`remote env: ${reply.failure}`));
                    } else {
                        pending.delete(reply.id);
                        call.resolve(decode(reply.result));
                    }
                }),
            );
        });
    }

    #helloTimeoutMs(): number {
        return this.#options.helloTimeoutMs ?? 120_000;
    }

    /** Sends one request; resolves with the daemon's decoded result. */
    async #call(
        method: string,
        args: unknown[],
        context: Context,
        onOutput?: (text: string) => void,
    ): Promise<unknown> {
        this.#options.onActivity?.("start");

        try {
            const connection = await this.#connect(context);
            const id = this.#nextId++;

            const abort = (): void => {
                connection.process.stdin.write(`${JSON.stringify({ id, abort: true })}\n`);
            };

            context.abortSignal?.addEventListener("abort", abort, { once: true });

            try {
                return await new Promise<unknown>((resolveCall, rejectCall) => {
                    connection.pending.set(id, {
                        resolve: resolveCall,
                        reject: rejectCall,
                        onOutput,
                    });
                    connection.process.stdin.write(
                        `${JSON.stringify({ id, method, args: encode(args) })}\n`,
                    );
                });
            } finally {
                context.abortSignal?.removeEventListener("abort", abort);
            }
        } finally {
            this.#options.onActivity?.("end");
        }
    }

    /** A file-system call: a transport failure becomes an `unknown` FileError result. */
    async #fs<T>(
        method: string,
        args: unknown[],
        context: Context,
        path?: string,
    ): Promise<Result<T, FileError>> {
        try {
            return (await this.#call(method, args, context)) as Result<T, FileError>;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            return {
                ok: false,
                error: new FileError(
                    context.abortSignal?.aborted ? "aborted" : "unknown",
                    message,
                    path,
                ),
            };
        }
    }

    /** Whether a path is served from the server instead of the box. */
    #isLocal(path: string): boolean {
        const roots = this.#options.localReadPaths;

        if (this.#local === undefined || roots === undefined || !isAbsolute(path)) {
            return false;
        }

        const full = resolve(path);

        return roots.some(
            (root) => full === root || full.startsWith(`${root.replace(/\/+$/, "")}/`),
        );
    }

    // --- FileSystem ---------------------------------------------------------------------------------------------

    absolutePath(path: string, context: Context) {
        return this.#fs<string>("absolutePath", [path], context, path);
    }
    joinPath(parts: string[], context: Context) {
        return this.#fs<string>("joinPath", [parts], context);
    }
    readTextFile(path: string, context: Context) {
        if (this.#isLocal(path)) {
            return this.#local!.readTextFile(path, context);
        }

        return this.#fs<string>("readTextFile", [path], context, path);
    }
    async openTextLineReader(
        path: string,
        context: Context,
    ): Promise<Result<TextLineReader, FileError>> {
        if (this.#isLocal(path)) {
            return this.#local!.openTextLineReader(path, context);
        }

        const opened = await this.#fs<{ $reader: number }>(
            "openTextLineReader",
            [path],
            context,
            path,
        );

        if (!opened.ok) {
            return opened;
        }

        const handle = opened.value.$reader;
        const reader: TextLineReader = {
            readLine: (readContext: Context) =>
                this.#fs<TextLine | undefined>("reader.readLine", [handle], readContext, path),
            close: async (closeContext: Context) => {
                await this.#fs<null>("reader.close", [handle], closeContext, path);
            },
        };

        return { ok: true, value: reader };
    }
    readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
        if (this.#isLocal(path)) {
            return this.#local!.readTextLines(path, options, context);
        }

        return this.#fs<string[]>("readTextLines", [path, options], context, path);
    }
    readBinaryFile(path: string, context: Context) {
        if (this.#isLocal(path)) {
            return this.#local!.readBinaryFile(path, context);
        }

        return this.#fs<Uint8Array>("readBinaryFile", [path], context, path);
    }
    writeFile(path: string, content: string | Uint8Array, context: Context) {
        return this.#fs<void>("writeFile", [path, content], context, path);
    }
    appendFile(path: string, content: string | Uint8Array, context: Context) {
        return this.#fs<void>("appendFile", [path, content], context, path);
    }
    truncateFile(path: string, size: number, context: Context) {
        return this.#fs<void>("truncateFile", [path, size], context, path);
    }
    flushFile(path: string, context: Context) {
        return this.#fs<void>("flushFile", [path], context, path);
    }
    renameFile(sourcePath: string, destinationPath: string, context: Context) {
        return this.#fs<void>("renameFile", [sourcePath, destinationPath], context, sourcePath);
    }
    fileInfo(path: string, context: Context) {
        if (this.#isLocal(path)) {
            return this.#local!.fileInfo(path, context);
        }

        return this.#fs<FileInfo>("fileInfo", [path], context, path);
    }
    listDir(path: string, context: Context) {
        if (this.#isLocal(path)) {
            return this.#local!.listDir(path, context);
        }

        return this.#fs<FileInfo[]>("listDir", [path], context, path);
    }
    canonicalPath(path: string, context: Context) {
        if (this.#isLocal(path)) {
            return this.#local!.canonicalPath(path, context);
        }

        return this.#fs<string>("canonicalPath", [path], context, path);
    }
    exists(path: string, context: Context) {
        if (this.#isLocal(path)) {
            return this.#local!.exists(path, context);
        }

        return this.#fs<boolean>("exists", [path], context, path);
    }
    createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
        return this.#fs<void>("createDir", [path, options], context, path);
    }
    remove(
        path: string,
        options: { recursive?: boolean; force?: boolean } | undefined,
        context: Context,
    ) {
        return this.#fs<void>("remove", [path, options], context, path);
    }
    createTempDir(prefix: string | undefined, context: Context) {
        return this.#fs<string>("createTempDir", [prefix], context);
    }
    createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) {
        return this.#fs<string>("createTempFile", [options], context);
    }

    // --- Shell --------------------------------------------------------------------------------------------------

    async exec(
        command: string,
        options: ShellExecOptions | undefined,
        context: Context,
    ): Promise<Result<ShellExecResult, ExecutionError>> {
        const { onOutput, ...rest } = options ?? {};

        // Commands in a box run for 10 minutes at most; longer work belongs in the background.
        rest.timeout = Math.min(rest.timeout ?? MAX_COMMAND_SECONDS, MAX_COMMAND_SECONDS);

        try {
            return (await this.#call("exec", [command, rest], context, (text) =>
                onOutput?.(text, context),
            )) as Result<ShellExecResult, ExecutionError>;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            return {
                ok: false,
                error: new ExecutionError(
                    context.abortSignal?.aborted ? "aborted" : "unknown",
                    message,
                ),
            };
        }
    }

    /** Closes the connection; the daemon aborts what is running and exits. The next call reconnects. */
    async cleanup(_context: Context): Promise<void> {
        const connection = this.#connection;

        this.#connection = undefined;

        if (connection === undefined) {
            return;
        }

        try {
            const { process } = await connection;

            process.stdin.end();
        } catch {
            // never connected
        }
    }
}
