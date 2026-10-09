/**
 * Paprika: how the app itself reads a session's files and runs git there (Files, Changes, branches, mentions), not
 * how Pi does. A local session works on this machine with Node's file system and git, as the app always has; a session
 * whose files are elsewhere, such as in a remote box, works through its execution environment. The panels are written
 * against this interface, so they behave the same either way.
 */
import { randomBytes } from "node:crypto";
import { lstat, open, opendir, rm, stat } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type GitOptions, GitError, git as localGit } from "./git.ts";

export type EntryKind = "file" | "directory" | "symlink" | "other";

/** What a path is, how big, and when it last changed. */
export type FileFacts = { kind: EntryKind; size: number; mtimeMs: number };

export interface SessionFiles {
    /** Whether the files are on this machine (paths can be checked against its own folders). */
    readonly local: boolean;
    /** Runs git in `cwd`; resolves with what it printed, rejects with a GitError. */
    git(cwd: string, args: string[], options?: GitOptions): Promise<string>;
    /** What `path` is, without following a last symbolic link; undefined when it is not there. */
    info(path: string): Promise<FileFacts | undefined>;
    /** What `path` is after following links; undefined when it is not there. */
    target(path: string): Promise<FileFacts | undefined>;
    /** At most `limit` entries of a folder; `more` says some were left. Stops early past `deadline`. */
    readSome(
        path: string,
        limit: number,
        deadline?: number,
    ): Promise<{ entries: { name: string; kind: EntryKind }[]; more: boolean }>;
    /** The first `bytes` bytes of a file. */
    readHead(path: string, bytes: number): Promise<Buffer>;
    /** Removes a file or folder; a missing one is fine. */
    remove(path: string, options?: { recursive?: boolean }): Promise<void>;
}

const kindOf = (entry: {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
}): EntryKind =>
    entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other";

/** This machine: Node's file system and the app's own git (see git.ts). */
export const localFiles: SessionFiles = {
    local: true,
    git: localGit,
    async info(path) {
        try {
            const found = await lstat(path);

            return { kind: kindOf(found), size: found.size, mtimeMs: found.mtimeMs };
        } catch {
            return undefined;
        }
    },
    async target(path) {
        try {
            const found = await stat(path);

            return { kind: kindOf(found), size: found.size, mtimeMs: found.mtimeMs };
        } catch {
            return undefined;
        }
    },
    async readSome(path, limit, deadline = Number.POSITIVE_INFINITY) {
        const entries: { name: string; kind: EntryKind }[] = [];
        const dir = await opendir(path, { bufferSize: 256 });

        for await (const entry of dir) {
            if (
                entries.length >= limit ||
                ((entries.length & 1023) === 1023 && Date.now() > deadline)
            ) {
                return { entries, more: true };
            }

            entries.push({ name: entry.name, kind: kindOf(entry) });
        }

        return { entries, more: false };
    },
    async readHead(path, bytes) {
        const handle = await open(path, "r");

        try {
            const buffer = Buffer.alloc(bytes);
            const { bytesRead } = await handle.read(buffer, 0, bytes, 0);

            return buffer.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    },
    async remove(path, options) {
        await rm(path, { force: true, recursive: options?.recursive === true });
    },
};

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * A session's files through its execution environment. Commands run in the environment's shell, which joins stdout
 * and stderr; so each command writes them to files there and prints them base64-encoded, keeping NUL bytes intact.
 * Uses GNU coreutils and findutils there (base64 -w0, head -z, find -printf, stat -c).
 */
export function envFiles(env: ExecutionEnv, context: Context = BACKGROUND_CONTEXT): SessionFiles {
    /** Runs a command; its exit code, stdout, and stderr, whole. */
    const run = async (
        command: string,
        cwd: string | undefined,
        timeoutS: number,
    ): Promise<{ code: number; stdout: Buffer; stderr: string }> => {
        const tag = `/tmp/pocket-run-${randomBytes(6).toString("hex")}`;
        let printed = "";
        const result = await env.exec(
            `{ ${command} ; } > ${tag}.out 2> ${tag}.err; code=$?; ` +
                `printf '@@'; base64 -w0 ${tag}.out; printf '@@'; base64 -w0 ${tag}.err; printf '@@%s@@' "$code"; ` +
                `rm -f ${tag}.out ${tag}.err`,
            {
                ...(cwd === undefined ? {} : { cwd }),
                timeout: timeoutS,
                onOutput: (text) => {
                    printed += text;
                },
            },
            context,
        );

        if (!result.ok) {
            throw new GitError(result.error.message, undefined);
        }

        const match = /@@([A-Za-z0-9+/=]*)@@([A-Za-z0-9+/=]*)@@(\d+)@@\s*$/.exec(printed);

        if (match === null) {
            throw new GitError(`unexpected output: ${printed.slice(-300)}`, undefined);
        }

        return {
            code: Number(match[3]),
            stdout: Buffer.from(match[1]!, "base64"),
            stderr: Buffer.from(match[2]!, "base64").toString("utf8"),
        };
    };

    const describe = async (path: string, follow: boolean) => {
        const result = await run(
            `LC_ALL=C stat ${follow ? "-L " : ""}-c '%F|%s|%.3Y' -- ${quote(path)}`,
            undefined,
            30,
        );

        if (result.code !== 0) {
            return undefined;
        }

        const [type = "", size = "0", mtime = "0"] = result.stdout
            .toString("utf8")
            .trim()
            .split("|");
        const kind: EntryKind =
            type === "directory"
                ? "directory"
                : type === "symbolic link"
                  ? "symlink"
                  : type.startsWith("regular")
                    ? "file"
                    : "other";

        return { kind, size: Number(size), mtimeMs: Math.round(Number(mtime) * 1000) };
    };

    return {
        local: false,
        async git(cwd, args, options = {}) {
            const { allowExit = [], timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024 } = options;
            const result = await run(
                `GIT_LITERAL_PATHSPECS=1 GIT_OPTIONAL_LOCKS=0 LC_ALL=C git -c core.fsmonitor=false ${args.map(quote).join(" ")}`,
                cwd,
                Math.ceil(timeoutMs / 1000),
            );

            if (result.stdout.length > maxBuffer) {
                throw new GitError("git printed more than the app reads", undefined);
            }

            if (result.code === 0 || allowExit.includes(result.code)) {
                return result.stdout.toString("utf8");
            }

            throw new GitError(
                result.stderr.trim() || `git exited with ${result.code}`,
                result.code,
            );
        },
        info: (path) => describe(path, false),
        target: (path) => describe(path, true),
        async readSome(path, limit) {
            // One line per entry: its type letter, a tab, and its name (NUL-terminated, so any name works).
            const result = await run(
                `find ${quote(path)} -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\0' | head -z -n ${limit + 1}`,
                undefined,
                60,
            );

            if (result.code !== 0) {
                throw new Error(result.stderr.trim() || `cannot read ${path}`);
            }

            const entries = result.stdout
                .toString("utf8")
                .split("\0")
                .filter((line) => line !== "")
                .map((line) => {
                    const type = line[0];
                    const kind: EntryKind =
                        type === "d"
                            ? "directory"
                            : type === "l"
                              ? "symlink"
                              : type === "f"
                                ? "file"
                                : "other";

                    return { name: line.slice(2), kind };
                });

            return { entries: entries.slice(0, limit), more: entries.length > limit };
        },
        async readHead(path, bytes) {
            const result = await run(`head -c ${bytes} -- ${quote(path)}`, undefined, 60);

            if (result.code !== 0) {
                throw new Error(result.stderr.trim() || `cannot read ${path}`);
            }

            return result.stdout;
        },
        async remove(path, options) {
            await run(
                `rm -f${options?.recursive === true ? "r" : ""} -- ${quote(path)}`,
                undefined,
                60,
            );
        },
    };
}
