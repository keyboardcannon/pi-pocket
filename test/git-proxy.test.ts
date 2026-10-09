// Paprika: the git proxy boxes use for GitHub, against a fake GitHub on this machine.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { GitProxy } from "../src/server/remote/git-proxy.ts";

const KEY = "k".repeat(32);
let root: string;
let github: Server;
let proxy: GitProxy;
let base: string;
const seen: { method: string; url: string; authorization: string | undefined; body: Buffer }[] = [];

function pkt(line: string): Buffer {
    return Buffer.from(`${(line.length + 4).toString(16).padStart(4, "0")}${line}`);
}

async function readAll(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks);
}

/** A push's request body: ref updates, the flush packet, then pack bytes. */
function pushBody(ref: string): Buffer {
    const zero = "0".repeat(40);
    const one = "1".repeat(40);

    return Buffer.concat([
        pkt(`${zero} ${one} ${ref}\0report-status side-band-64k\n`),
        Buffer.from("0000"),
        Buffer.from("PACK-bytes-of-the-push"),
    ]);
}

before(async () => {
    root = mkdtempSync(join(tmpdir(), "git-proxy-"));
    github = createServer((request, response) => {
        void readAll(request).then((body) => {
            seen.push({
                method: request.method ?? "",
                url: request.url ?? "",
                authorization: request.headers.authorization,
                body,
            });

            if (request.url === "/repos/owner/repo") {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ default_branch: "main" }));
            } else {
                response.writeHead(200, { "content-type": "application/x-git-test" });
                response.end("from github");
            }
        });
    });
    await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
    const upstream = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    // gh prints its arguments and the repository it was given.
    const gh = join(root, "gh");

    writeFileSync(gh, '#!/bin/sh\necho "args: $* repo: $GH_REPO"\n');
    chmodSync(gh, 0o755);
    proxy = new GitProxy({
        access: (key) => (key === KEY ? { box: "test-box", repos: ["owner/repo"] } : undefined),
        log: () => {},
        github: upstream,
        api: upstream,
        token: async () => "the-token",
        gh,
    });
    base = `http://127.0.0.1:${await proxy.port()}/${KEY}/github.com`;
});

after(() => {
    proxy.close();
    github.close();
    rmSync(root, { recursive: true, force: true });
});

test("a fetch of an allowed repository reaches GitHub with the server's token", async () => {
    seen.length = 0;
    const response = await fetch(`${base}/owner/repo.git/info/refs?service=git-upload-pack`);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "from github");
    assert.equal(seen[0]?.url, "/owner/repo.git/info/refs?service=git-upload-pack");
    assert.equal(
        seen[0]?.authorization,
        `Basic ${Buffer.from("x-access-token:the-token").toString("base64")}`,
    );
});

test("another repository, or an unknown key, is refused without asking GitHub", async () => {
    seen.length = 0;
    const other = await fetch(`${base}/owner/other.git/info/refs?service=git-upload-pack`);

    assert.equal(other.status, 403);
    assert.match(await other.text(), /not one of this project's repositories/);

    const stranger = await fetch(
        `http://127.0.0.1:${await proxy.port()}/${"x".repeat(32)}/github.com/owner/repo.git/info/refs?service=git-upload-pack`,
    );

    assert.equal(stranger.status, 404);
    assert.equal(seen.length, 0);
});

test("a push to the default branch is rejected the way git servers do, and GitHub never sees it", async () => {
    seen.length = 0;
    const response = await fetch(`${base}/owner/repo.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": "application/x-git-receive-pack-request" },
        body: new Uint8Array(pushBody("refs/heads/main")),
    });
    const body = Buffer.from(await response.arrayBuffer()).toString("utf8");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-git-receive-pack-result");
    assert.match(body, /unpack ok/);
    assert.match(body, /ng refs\/heads\/main pushes to the default branch are refused/);
    assert.ok(seen.every((request) => !request.url.includes("git-receive-pack")));
});

test("a push to a branch goes to GitHub whole", async () => {
    seen.length = 0;
    const sent = pushBody("refs/heads/feature");
    const response = await fetch(`${base}/owner/repo.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": "application/x-git-receive-pack-request" },
        body: new Uint8Array(sent),
    });

    assert.equal(response.status, 200);
    const push = seen.find((request) => request.url === "/owner/repo.git/git-receive-pack");

    assert.ok(push !== undefined);
    assert.deepEqual(push.body, sent);
});

test("gh runs here for the project's repository, for allowed commands only", async () => {
    const run = async (args: string[], repo?: string) => {
        const response = await fetch(`${base.replace(/\/github\.com$/, "")}/gh`, {
            method: "POST",
            body: JSON.stringify({ args, ...(repo === undefined ? {} : { repo }) }),
        });

        return (await response.json()) as { code: number; stdout: string; stderr: string };
    };

    const list = await run(["pr", "list"], "owner/repo");

    assert.equal(list.code, 0);
    assert.match(list.stdout, /args: pr list repo: owner\/repo/);

    const api = await run(["api", "user"], "owner/repo");

    assert.equal(api.code, 1);
    assert.match(api.stderr, /not available in boxes/);

    const elsewhere = await run(["pr", "list", "--repo", "owner/other"], "owner/repo");

    assert.equal(elsewhere.code, 1);
});
