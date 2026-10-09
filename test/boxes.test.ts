// Paprika: box sessions' lifecycle, against a fake backend whose "box" is a folder on this machine.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type BoxBackend, type BoxSpec, shellQuote } from "../src/server/remote/backend.ts";
import { type BoxLink, BoxManager } from "../src/server/remote/boxes.ts";

let root: string;
let remote: string;
const notices: string[] = [];

/** A box backend whose boxes are folders here: every box shares one "home" and one workspace per test. */
class FakeBackend implements BoxBackend {
    readonly name = "fake";
    readonly boxUser = userInfo().username;
    readonly nodePath = process.execPath;
    readonly workspace: string;
    readonly home: string;
    readonly boxes = new Map<string, "running" | "stopped" | "missing">();
    creates = 0;
    starts = 0;
    leases = 0;

    constructor(dir: string) {
        this.home = join(dir, "home");
        this.workspace = join(dir, "workspace");
        mkdirSync(this.home, { recursive: true });
    }

    asUser(command: string): string {
        return `HOME=${shellQuote(this.home)} bash -c ${shellQuote(command)}`;
    }

    asRoot(command: string): string {
        return `bash -c ${shellQuote(command)}`;
    }

    async create(): Promise<{ sandboxId: string }> {
        this.creates++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const sandboxId = `fake-${this.creates}`;

        this.boxes.set(sandboxId, "running");

        return { sandboxId };
    }

    async destroy(box: BoxSpec): Promise<void> {
        this.boxes.delete(box.sandboxId);
    }

    async status(box: BoxSpec) {
        return this.boxes.get(box.sandboxId) ?? "missing";
    }

    async start(box: BoxSpec): Promise<void> {
        this.starts++;
        this.boxes.set(box.sandboxId, "running");
    }

    async stop(box: BoxSpec): Promise<void> {
        this.boxes.set(box.sandboxId, "stopped");
    }

    async renewLease(): Promise<void> {
        this.leases++;
    }

    async sshArgs(): Promise<string[]> {
        return ["sh", "-c"];
    }
}

const gitProxy = {
    port: async () => 1,
    identity: async () => ({ name: "Test Pocket", email: "pocket@example.com" }),
    close: () => {},
};

/** A project in the configuration repository, with these scripts. */
function writeProject(name: string, files: Record<string, string>): void {
    const folder = join(root, "config", "projects", name);

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "project.json"), JSON.stringify({ name, repos: [] }));

    for (const [file, content] of Object.entries(files)) {
        writeFileSync(join(folder, file), content);
    }

    git(join(root, "config"), "add", "-A");
    git(join(root, "config"), "commit", "-q", "-m", `project ${name}`);
    git(join(root, "config"), "push", "-q", "origin", "HEAD");
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd,
        encoding: "utf8",
    });
}

/** A manager over one session (root id "7") of `project`, with its own fake backend. */
function session(project: string, options: { idleMs?: number } = {}) {
    const dir = mkdtempSync(join(root, "box-"));
    const backend = new FakeBackend(dir);
    const links = new Map<string, BoxLink>([["7", { project }]]);
    const saved: BoxLink[] = [];
    const manager = new BoxManager({
        dataDir: dir,
        sessionBox: (id) => links.get(id),
        saveBox: async (id, link) => {
            links.set(id, link);
            saved.push(link);
        },
        localReadPaths: () => [],
        notice: (_level, text) => notices.push(text),
        backend: Promise.resolve(backend),
        gitProxy,
        ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    });

    return { backend, manager, links, saved, env: () => manager.envFor("7")! };
}

before(() => {
    root = mkdtempSync(join(tmpdir(), "boxes-"));
    remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    git(root, "clone", "-q", remote, "config");
    writeFileSync(join(root, "config", "README"), "config\n");
    git(join(root, "config"), "add", "-A");
    git(join(root, "config"), "commit", "-q", "-m", "start");
    git(join(root, "config"), "push", "-q", "origin", "HEAD:main");
    process.env.PI_POCKET_PROJECTS_DIR = join(root, "config", "projects");
    writeProject("good", {
        "setup.sh": 'echo setup >> "$HOME/runs"; echo set up > marker\n',
        "resume.sh": 'echo resume >> "$HOME/runs"\n',
        "AGENTS.md": "Project rules.\n",
    });
    writeProject("broken", { "setup.sh": 'echo setup >> "$HOME/runs"; echo nope >&2; exit 3\n' });
});

after(() => {
    rmSync(root, { recursive: true, force: true });
});

test("a box is created once, when the message is sent, even when the prompt and tools race for it", async () => {
    const { backend, manager, saved, env } = session("good");

    // Sending a message prepares the box; the prompt and a tool call ask for it at the same time.
    const sent = manager.prepare("7");
    const ready = env().box!.ready();
    const command = env().exec("cat marker; pwd", undefined, ctx);

    await Promise.all([sent, ready]);
    assert.equal(backend.creates, 1, "created once");
    assert.equal(manager.stateOf("7")?.state, "running");
    assert.deepEqual(saved.at(-1), { project: "good", name: "pocket-good-7", sandboxId: "fake-1" });

    const result = await command;

    assert.ok(result.ok && result.value.exitCode === 0);
    assert.equal(readFileSync(join(backend.home, "runs"), "utf8"), "setup\nresume\n");
    assert.equal(
        readFileSync(join(backend.home, ".pocket", "AGENTS.md"), "utf8"),
        "Project rules.\n",
    );
    assert.ok(backend.leases >= 1, "the lease is set");
    await manager.dispose();
});

test("a failed setup is recorded once, told to the agent, and not run again", async () => {
    const { backend, manager, env } = session("broken");

    await manager.prepare("7");
    const state = manager.stateOf("7");

    assert.equal(state?.setup?.ok, false);
    assert.equal(state?.setup?.exitCode, 3);
    assert.equal(state?.setup?.log, "~/.pocket/setup.log");
    assert.match(readFileSync(join(backend.home, ".pocket", "setup.log"), "utf8"), /nope/);

    const status = env().box!.status() ?? "";

    assert.match(status, /setup\.sh failed .*exit 3/);
    assert.match(status, /explain it to the user, and ask what to do next/);

    // Stopped and started again: setup does not run again.
    await manager.stop("7");
    await manager.prepare("7");
    assert.equal(readFileSync(join(backend.home, "runs"), "utf8"), "setup\n");
    assert.equal(backend.starts, 1);

    env().box!.resolveSetup();
    assert.equal(env().box!.status(), undefined);
    await manager.dispose();
});

test("an idle box stops, and the next call starts it and runs resume.sh", async () => {
    const { backend, manager, env } = session("good", { idleMs: 200 });
    const first = await env().exec("true", undefined, ctx);

    assert.ok(first.ok);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(backend.boxes.get("fake-1"), "stopped");
    assert.equal(manager.stateOf("7")?.state, "stopped");

    const again = await env().exec("cat marker", undefined, ctx);

    assert.ok(again.ok && again.value.exitCode === 0);
    assert.equal(backend.starts, 1);
    assert.equal(readFileSync(join(backend.home, "runs"), "utf8"), "setup\nresume\nresume\n");
    await manager.dispose();
});

test("a box that no longer exists is replaced by a new one", async () => {
    const { backend, manager, saved } = session("good");

    await manager.prepare("7");
    backend.boxes.set("fake-1", "missing");
    await manager.prepare("7");
    assert.equal(backend.creates, 2);
    assert.equal(saved.at(-1)?.sandboxId, "fake-2");
    await manager.dispose();
});

test("the box's changed project files are saved to the project, committed and pushed", async () => {
    const { backend, manager, env } = session("good");

    await manager.prepare("7");
    writeFileSync(join(backend.home, ".pocket", "setup.sh"), "echo better setup\n");
    writeFileSync(join(backend.home, ".pocket", "AGENTS.md"), "Better rules.\n");

    const saved = await env().box!.saveProjectFiles(
        ["setup.sh", "AGENTS.md"],
        "Fix the good project's setup",
    );

    assert.match(saved, /Saved and pushed: .*Fix the good project's setup/);
    assert.equal(
        execFileSync("git", ["--git-dir", remote, "show", "main:projects/good/setup.sh"], {
            encoding: "utf8",
        }),
        "echo better setup\n",
    );
    assert.equal(
        execFileSync("git", ["--git-dir", remote, "show", "main:projects/good/AGENTS.md"], {
            encoding: "utf8",
        }),
        "Better rules.\n",
    );
    assert.match(await env().box!.saveProjectFiles(["setup.sh"], "Again"), /Nothing changed/);
    await manager.dispose();
});
