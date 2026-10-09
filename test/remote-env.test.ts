// Paprika: RemoteExecutionEnv against its daemon (run as a local process) must behave like NodeExecutionEnv.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { daemonBundle } from "../src/server/remote/bundle.ts";
import { RemoteExecutionEnv } from "../src/server/remote/env.ts";

const ctx = BACKGROUND_CONTEXT;
let root: string;
let daemonFile: string;
let local: NodeExecutionEnv;
let remote: RemoteExecutionEnv;
let activity: string[] = [];

/** Strips what legitimately differs between two environments: ids, error instances become plain data. */
function plain(value: unknown): unknown {
    if (value instanceof Error) {
        return { error: value.constructor.name, code: (value as { code?: string }).code };
    }

    if (value instanceof Uint8Array) {
        return { bytes: Buffer.from(value).toString("hex") };
    }

    if (Array.isArray(value)) {
        return value.map(plain);
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => key !== "mtimeMs")
                .map(([key, item]) => [key, plain(item)]),
        );
    }

    return value;
}

async function same(
    name: string,
    run: (env: ExecutionEnv, dir: string) => Promise<unknown>,
): Promise<void> {
    const a = join(root, "local", name);
    const b = join(root, "remote", name);

    await local.createDir(a, { recursive: true }, ctx);
    await local.createDir(b, { recursive: true }, ctx);
    const expected = plain(await run(local, a));
    const actual = plain(await run(remote, b));

    assert.deepEqual(
        JSON.parse(JSON.stringify(actual).replaceAll(b, "<dir>")),
        JSON.parse(JSON.stringify(expected).replaceAll(a, "<dir>")),
        name,
    );
}

before(async () => {
    root = mkdtempSync(join(tmpdir(), "remote-env-"));
    const bundle = await daemonBundle();

    daemonFile = join(root, `daemon-${bundle.hash}.mjs`);
    writeFileSync(daemonFile, bundle.code);
    local = new NodeExecutionEnv({ cwd: root });
    remote = new RemoteExecutionEnv({
        id: "test-box",
        cwd: root,
        connect: async () =>
            spawn(process.execPath, [daemonFile, root], { stdio: ["pipe", "pipe", "pipe"] }),
        localReadPaths: [join(root, "server-only")],
        onActivity: (event) => activity.push(event),
        helloTimeoutMs: 10_000,
    });
});

after(async () => {
    await remote.cleanup(ctx);
    rmSync(root, { recursive: true, force: true });
});

test("text, unicode, and binary files", () =>
    same("files", async (env, dir) => {
        const file = join(dir, "a.txt");
        const bin = join(dir, "b.bin");

        return [
            await env.writeFile(file, "héllo\nwörld \u2028 line-sep\n", ctx),
            await env.readTextFile(file, ctx),
            await env.appendFile(file, "more\n", ctx),
            await env.readTextLines(file, { maxLines: 2 }, ctx),
            await env.writeFile(bin, new Uint8Array([0, 255, 10, 13, 128]), ctx),
            await env.readBinaryFile(bin, ctx),
            await env.truncateFile(bin, 2, ctx),
            await env.readBinaryFile(bin, ctx),
            await env.flushFile(file, ctx),
            (await env.fileInfo(file, ctx)).ok,
        ];
    }));

test("directories, renames, and errors", () =>
    same("dirs", async (env, dir) => {
        const sub = join(dir, "x", "y");

        return [
            await env.createDir(sub, { recursive: true }, ctx),
            await env.writeFile(join(sub, "f"), "1", ctx),
            await env.renameFile(join(sub, "f"), join(sub, "g"), ctx),
            (await env.listDir(sub, ctx)).ok && (await env.listDir(sub, ctx)),
            await env.exists(join(sub, "f"), ctx),
            await env.exists(join(sub, "g"), ctx),
            await env.readTextFile(join(dir, "missing"), ctx),
            await env.readTextFile(sub, ctx),
            await env.listDir(join(sub, "g"), ctx),
            await env.joinPath([dir, "a", "..", "b"], ctx),
            await env.absolutePath("rel/path", ctx),
            await env.remove(join(dir, "x"), { recursive: true }, ctx),
            await env.exists(join(dir, "x"), ctx),
        ];
    }));

test("line reader", () =>
    same("reader", async (env, dir) => {
        const file = join(dir, "lines.txt");

        await env.writeFile(file, "one\ntwo\nthree", ctx);
        const opened = await env.openTextLineReader(file, ctx);

        assert.ok(opened.ok);
        const lines = [];

        for (let i = 0; i < 4; i++) {
            lines.push(await opened.value.readLine(ctx));
        }

        await opened.value.close(ctx);

        return lines;
    }));

test("temp files exist", async () => {
    const dir = await remote.createTempDir("t-", ctx);
    const file = await remote.createTempFile({ prefix: "p-", suffix: ".s" }, ctx);

    assert.ok(dir.ok && file.ok);
    assert.equal((await remote.exists(dir.value, ctx)).ok, true);
    assert.match(file.value, /p-.*\.s$/);
});

test("exec: output, exit code, cwd, env", () =>
    same("exec", async (env, dir) => {
        const chunks: string[] = [];
        const result = await env.exec(
            "echo out; echo err 1>&2; printf 'ünï'; pwd; echo $FOO; exit 3",
            { cwd: dir, env: { FOO: "bar" }, onOutput: (text) => chunks.push(text) },
            ctx,
        );

        // stdout and stderr arrive on separate pipes, so their relative order can differ between runs.
        return [result, chunks.join("").split("\n").sort()];
    }));

test("exec: abort and timeout", async () => {
    const controller = new AbortController();
    const started = Date.now();

    setTimeout(() => controller.abort(), 300);
    const aborted = await remote.exec(
        "sleep 10",
        undefined,
        withAbortSignal(controller.signal, ctx),
    );

    assert.equal(aborted.ok, false);
    assert.equal(!aborted.ok && aborted.error.code, "aborted");
    const timedOut = await remote.exec("sleep 10", { timeout: 1 }, ctx);

    assert.equal(!timedOut.ok && timedOut.error.code, "timeout");
    assert.ok(Date.now() - started < 5000, "abort and timeout end the command quickly");
});

test("server-side reads for localReadPaths", async () => {
    const serverDir = join(root, "server-only");

    await local.createDir(serverDir, { recursive: true }, ctx);
    writeFileSync(join(serverDir, "SKILL.md"), "global skill");
    const read = await remote.readTextFile(join(serverDir, "SKILL.md"), ctx);

    assert.deepEqual(read, { ok: true, value: "global skill" });
});

test("activity events pair up", () => {
    assert.ok(activity.length > 0);
    assert.equal(
        activity.filter((e) => e === "start").length,
        activity.filter((e) => e === "end").length,
    );
});

test("reconnects after the daemon dies", async () => {
    const pid = await remote.exec("echo $PPID", undefined, ctx);

    assert.ok(pid.ok);
    await remote.exec("kill $PPID", undefined, ctx).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const again = await remote.readTextFile(join(root, "missing"), ctx);

    assert.equal(!again.ok && again.error.code, "not_found");
});
