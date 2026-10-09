/**
 * Paprika: GitHub access for boxes, through this server, with nothing stored here.
 *
 * Boxes reach this proxy through a reverse SSH tunnel (127.0.0.1:BOX_GIT_PORT inside the box). Their git config
 * rewrites https://github.com/ to http://127.0.0.1:BOX_GIT_PORT/<box key>/github.com/, so plain git commands come here.
 * The proxy checks the box's project allows the repository, adds this server's GitHub token, and streams the request
 * to GitHub and the answer back. It refuses pushes that update a repository's default branch: agents push branches
 * and open pull requests.
 *
 * `gh` in a box is a small script that posts its arguments to /<box key>/gh; the real `gh` runs here, with GH_REPO
 * set to the repository, and its output goes back.
 */
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

/** The port the tunnel uses inside every box. */
export const BOX_GIT_PORT = 7777;

export interface BoxAccess {
    readonly box: string;
    /** Allowed repositories, `owner/name`, lower case. */
    readonly repos: readonly string[];
}

const GIT_PATH =
    /^\/([A-Za-z0-9_-]{16,})\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const GH_PATH = /^\/([A-Za-z0-9_-]{16,})\/gh$/;
/** gh subcommands a box may run. */
const GH_ALLOWED = new Set([
    "pr",
    "issue",
    "run",
    "workflow",
    "release",
    "label",
    "repo",
    "browse",
    "search",
    "status",
]);
const GH_REPO_ALLOWED = new Set(["view"]);
const PASS_HEADERS = [
    "content-type",
    "accept",
    "git-protocol",
    "content-encoding",
    "accept-encoding",
    "user-agent",
];

export class GitProxy {
    readonly #access: (key: string) => BoxAccess | undefined;
    readonly #log: (line: string) => void;
    #server: Server | undefined;
    #port: Promise<number> | undefined;
    #token: Promise<string> | undefined;
    readonly #defaultBranches = new Map<string, { at: number; branch: string }>();

    constructor(options: { access(key: string): BoxAccess | undefined; log(line: string): void }) {
        this.#access = options.access;
        this.#log = options.log;
    }

    /** Starts the proxy on a free local port (once) and returns the port. */
    port(): Promise<number> {
        this.#port ??= new Promise((resolve, reject) => {
            const server = createServer((request, response) => {
                void this.#handle(request, response).catch((error: unknown) => {
                    this.#log(`git proxy: ${String(error)}`);

                    if (!response.headersSent) {
                        response.writeHead(502, { "content-type": "text/plain" });
                    }

                    response.end(`pocket git proxy: ${String(error)}\n`);
                });
            });

            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
            this.#server = server;
        });

        return this.#port;
    }

    /** The git identity for commits from boxes: this server's GitHub account and its no-reply address. */
    async identity(): Promise<{ name: string; email: string }> {
        const response = await fetch("https://api.github.com/user", {
            headers: {
                authorization: `Bearer ${await this.#githubToken()}`,
                accept: "application/vnd.github+json",
            },
        });

        if (!response.ok) {
            throw new Error(`GitHub: user: HTTP ${response.status}`);
        }

        const user = (await response.json()) as { id: number; login: string; name: string | null };

        return {
            name: user.name ?? user.login,
            email: `${user.id}+${user.login}@users.noreply.github.com`,
        };
    }

    close(): void {
        this.#server?.close();
    }

    /** This server's GitHub token, from its gh login. */
    #githubToken(): Promise<string> {
        this.#token ??= new Promise<string>((resolve, reject) =>
            execFile("gh", ["auth", "token", "--hostname", "github.com"], (error, stdout) =>
                error
                    ? reject(new Error(`no GitHub login for gh on this server: ${error.message}`))
                    : resolve(stdout.trim()),
            ),
        ).catch((error: unknown) => {
            this.#token = undefined;

            throw error;
        });

        return this.#token;
    }

    async #defaultBranch(repo: string): Promise<string> {
        const cached = this.#defaultBranches.get(repo);

        if (cached !== undefined && Date.now() - cached.at < 10 * 60_000) {
            return cached.branch;
        }

        const response = await fetch(`https://api.github.com/repos/${repo}`, {
            headers: {
                authorization: `Bearer ${await this.#githubToken()}`,
                accept: "application/vnd.github+json",
            },
        });

        if (!response.ok) {
            throw new Error(`GitHub: ${repo}: HTTP ${response.status}`);
        }

        const branch = ((await response.json()) as { default_branch: string }).default_branch;

        this.#defaultBranches.set(repo, { at: Date.now(), branch });

        return branch;
    }

    async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? "/", "http://box");
        const gh = GH_PATH.exec(url.pathname);

        if (gh !== null && request.method === "POST") {
            return this.#gh(gh[1]!, request, response);
        }

        const git = GIT_PATH.exec(url.pathname);
        const access = git === null ? undefined : this.#access(git[1]!);

        if (git === null || access === undefined) {
            return refuse(response, 404, "not a pocket git URL");
        }

        const repo = `${git[2]}/${git[3]}`.toLowerCase();

        if (!access.repos.includes(repo)) {
            this.#log(`git proxy: ${access.box}: refused ${repo} (not in the project's repos)`);

            return refuse(response, 403, `${repo} is not one of this project's repositories`);
        }

        const service = git[4] === "info/refs" ? url.searchParams.get("service") : git[4];

        if (service !== "git-upload-pack" && service !== "git-receive-pack") {
            return refuse(response, 403, "unsupported git service");
        }

        let body: Readable | undefined = request.method === "POST" ? request : undefined;

        if (git[4] === "git-receive-pack") {
            // The push's ref updates come first, before the pack: check them, then send them on with the rest.
            const { head, commands } = await readCommands(request);
            const protectedRef = `refs/heads/${await this.#defaultBranch(repo)}`;
            const blocked = commands.find((command) => command.ref === protectedRef);

            if (blocked !== undefined) {
                this.#log(`git proxy: ${access.box}: refused push to ${repo} ${blocked.ref}`);

                return refuse(
                    response,
                    403,
                    `pushes to ${repo}'s default branch are refused: push a branch and open a pull request`,
                );
            }

            this.#log(
                `git proxy: ${access.box}: push ${repo} ${commands.map((command) => command.ref).join(" ")}`,
            );
            body = Readable.from(prepend(head, request));
        }

        const headers: Record<string, string> = {
            authorization: `Basic ${Buffer.from(`x-access-token:${await this.#githubToken()}`).toString("base64")}`,
        };

        for (const name of PASS_HEADERS) {
            const value = request.headers[name];

            if (typeof value === "string") {
                headers[name] = value;
            }
        }

        const upstream = await fetch(`https://github.com/${repo}.git/${git[4]}${url.search}`, {
            method: request.method ?? "GET",
            headers,
            ...(body === undefined
                ? {}
                : { body: Readable.toWeb(body) as ReadableStream, duplex: "half" }),
            redirect: "manual",
        } as RequestInit);
        const out: Record<string, string> = {};

        for (const name of ["content-type", "cache-control", "content-encoding"]) {
            const value = upstream.headers.get(name);

            if (value !== null) {
                out[name] = value;
            }
        }

        response.writeHead(upstream.status, out);

        if (upstream.body === null) {
            return void response.end();
        }

        for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
            response.write(chunk);
        }

        response.end();
    }

    async #gh(key: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
        const access = this.#access(key);

        if (access === undefined) {
            return refuse(response, 404, "unknown box");
        }

        const chunks: Buffer[] = [];

        for await (const chunk of request) {
            chunks.push(chunk as Buffer);
        }

        const { args, repo: requested } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            args: string[];
            repo?: string;
        };
        const reply = (code: number, stdout: string, stderr: string) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ code, stdout, stderr }));
        };
        // --repo/-R in the arguments names the repository too; it must be the same allowed one.
        const flagged = args.flatMap((arg, i) =>
            arg === "--repo" || arg === "-R"
                ? [args[i + 1] ?? ""]
                : arg.startsWith("--repo=")
                  ? [arg.slice(7)]
                  : [],
        );
        const repo = (flagged[0] ?? requested ?? access.repos[0] ?? "").toLowerCase();
        const sub = args[0] ?? "";

        if (flagged.some((name) => name.toLowerCase() !== repo)) {
            return reply(1, "", "gh: give one --repo at most\n");
        }

        if (!access.repos.includes(repo)) {
            return reply(
                1,
                "",
                `gh: ${repo || "(no repository)"} is not one of this project's repositories\n`,
            );
        }

        if (!GH_ALLOWED.has(sub) || (sub === "repo" && !GH_REPO_ALLOWED.has(args[1] ?? ""))) {
            return reply(1, "", `gh: '${args.slice(0, 2).join(" ")}' is not available in boxes\n`);
        }

        this.#log(`gh proxy: ${access.box}: gh ${args.slice(0, 2).join(" ")} (${repo})`);
        // An empty directory, so gh never sees a local repository on this server.
        const cwd = mkdtempSync(join(tmpdir(), "pocket-gh-"));

        execFile(
            "gh",
            args,
            {
                cwd,
                env: { ...process.env, GH_REPO: repo, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
                timeout: 120_000,
                maxBuffer: 16 << 20,
            },
            (error, stdout, stderr) =>
                reply(
                    error === null ? 0 : typeof error.code === "number" ? error.code : 1,
                    stdout,
                    stderr,
                ),
        );
    }
}

function refuse(response: ServerResponse, status: number, message: string): void {
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(`pocket: ${message}\n`);
}

type RefCommand = { old: string; new: string; ref: string };

/**
 * Reads a receive-pack request's command pkt-lines (up to the flush packet) and pauses the request there; the bytes
 * read so far come back as `head`, and the rest stays in the request for the caller to stream on.
 */
function readCommands(request: IncomingMessage): Promise<{ head: Buffer; commands: RefCommand[] }> {
    if (request.headers["content-encoding"] === "gzip") {
        return Promise.reject(new Error("compressed pushes are not supported"));
    }

    return new Promise((resolve, reject) => {
        let head = Buffer.alloc(0);
        const commands: RefCommand[] = [];
        let offset = 0;

        const done = (error?: Error): void => {
            request.off("data", onData);
            request.off("end", onEnd);
            request.off("error", done);
            request.pause();

            if (error === undefined) {
                resolve({ head, commands });
            } else {
                reject(error);
            }
        };

        const onEnd = (): void => done();

        const onData = (chunk: Buffer): void => {
            head = Buffer.concat([head, chunk]);

            while (head.length >= offset + 4) {
                const length = Number.parseInt(
                    head.subarray(offset, offset + 4).toString("ascii"),
                    16,
                );

                if (Number.isNaN(length)) {
                    return done(new Error("malformed push request"));
                }

                if (length === 0) {
                    return done();
                }

                if (head.length < offset + length) {
                    return;
                }

                const line = head
                    .subarray(offset + 4, offset + length)
                    .toString("utf8")
                    .split("\0")[0]!
                    .trim();
                const [oldId, newId, ref] = line.split(" ");

                if (oldId !== undefined && newId !== undefined && ref !== undefined) {
                    commands.push({ old: oldId, new: newId, ref });
                }

                offset += length;
            }
        };

        request.on("data", onData);
        request.on("end", onEnd);
        request.on("error", done);
    });
}

async function* prepend(head: Buffer, rest: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
    yield head;

    for await (const chunk of rest) {
        yield chunk;
    }
}
