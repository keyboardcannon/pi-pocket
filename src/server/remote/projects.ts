/**
 * Paprika: projects that sessions can run in a box. One folder per project in $PI_POCKET_PROJECTS_DIR:
 *
 *   <name>/project.json   { "name": "<name>", "title"?: "...", "repos": ["owner/name", ...] }
 *                         repos: the GitHub repositories the project's boxes may read and push (see git-proxy.ts)
 *   <name>/setup.sh       optional: run once in a new box, in /workspace, to build the project's environment
 *   <name>/resume.sh      optional: run every time the box starts, before the agent's calls go through
 *   <name>/AGENTS.md      optional: added to the system prompt of the project's sessions
 *
 * Secrets: $PI_POCKET_PROJECT_SECRETS_DIR/<name>.env (KEY=value lines), only on this server. The box gets them at
 * ~/.pocket/env, which the scripts and every command the agent runs see as environment variables.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Project {
    readonly name: string;
    readonly title: string;
    /** GitHub repositories, `owner/name`, lower case. */
    readonly repos: readonly string[];
    readonly setup: string | undefined;
    readonly resume: string | undefined;
    readonly agents: string | undefined;
    readonly secrets: string | undefined;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

function projectsDir(): string | undefined {
    const dir = process.env.PI_POCKET_PROJECTS_DIR;

    return dir === undefined || dir === "" ? undefined : dir;
}

function optionalFile(path: string): string | undefined {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** A project by name, read fresh from disk; undefined when there is no such project. */
export function readProject(name: string): Project | undefined {
    const dir = projectsDir();

    if (dir === undefined || !NAME.test(name)) {
        return undefined;
    }

    const folder = join(dir, name);
    const spec = optionalFile(join(folder, "project.json"));

    if (spec === undefined) {
        return undefined;
    }

    const parsed = JSON.parse(spec) as { name?: string; title?: string; repos?: unknown };

    if (parsed.name !== undefined && parsed.name !== name) {
        throw new Error(`project ${name}: project.json names it ${parsed.name}`);
    }

    const secretsDir = process.env.PI_POCKET_PROJECT_SECRETS_DIR;

    return {
        name,
        title: parsed.title ?? name,
        repos: Array.isArray(parsed.repos)
            ? parsed.repos
                  .filter((repo): repo is string => typeof repo === "string")
                  .map((repo) => repo.toLowerCase())
            : [],
        setup: optionalFile(join(folder, "setup.sh")),
        resume: optionalFile(join(folder, "resume.sh")),
        agents: optionalFile(join(folder, "AGENTS.md")),
        secrets:
            secretsDir === undefined || secretsDir === ""
                ? undefined
                : optionalFile(join(secretsDir, `${name}.env`)),
    };
}

/** Every project, by name. */
export function listProjects(): { name: string; title: string }[] {
    const dir = projectsDir();

    if (dir === undefined || !existsSync(dir)) {
        return [];
    }

    return readdirSync(dir, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isDirectory() &&
                NAME.test(entry.name) &&
                existsSync(join(dir, entry.name, "project.json")),
        )
        .map((entry) => {
            try {
                const project = readProject(entry.name);

                return project === undefined
                    ? undefined
                    : { name: project.name, title: project.title };
            } catch {
                return undefined;
            }
        })
        .filter((project): project is { name: string; title: string } => project !== undefined)
        .sort((a, b) => a.title.localeCompare(b.title));
}

/** Project files a box may save back: its scripts and its instructions. */
export const PROJECT_FILES = ["setup.sh", "resume.sh", "AGENTS.md"] as const;
export type ProjectFile = (typeof PROJECT_FILES)[number];

function runGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) =>
        execFile("git", args, { cwd, timeout: 120_000 }, (error, stdout, stderr) =>
            error
                ? reject(new Error(`git ${args[0]}: ${(stderr || error.message).trim()}`))
                : resolve(stdout.trim()),
        ),
    );
}

/**
 * Writes files into a project's folder, commits them as `identity`, and pushes the configuration repository's
 * current branch. Pulls first, so the commit sits on top of what is on GitHub. Returns what was committed.
 */
export async function saveProjectFiles(
    name: string,
    files: Partial<Record<ProjectFile, string>>,
    message: string,
    identity: { name: string; email: string },
): Promise<string> {
    const dir = projectsDir();

    if (dir === undefined || readProject(name) === undefined) {
        throw new Error(`no project named ${name}`);
    }

    const folder = join(dir, name);
    const root = await runGit(folder, ["rev-parse", "--show-toplevel"]);

    await runGit(root, ["pull", "--ff-only", "--quiet"]);

    const paths: string[] = [];

    for (const [file, content] of Object.entries(files) as [ProjectFile, string][]) {
        const path = join(folder, file);

        writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);

        if (file.endsWith(".sh")) {
            chmodSync(path, 0o755);
        }

        paths.push(path);
    }

    await runGit(root, ["add", "--", ...paths]);

    if ((await runGit(root, ["diff", "--cached", "--name-only"])) === "") {
        return "Nothing changed: the project already has these files as they are.";
    }

    await runGit(root, [
        "-c",
        `user.name=${identity.name}`,
        "-c",
        `user.email=${identity.email}`,
        "commit",
        "--quiet",
        "-m",
        message,
    ]);
    await runGit(root, ["push", "--quiet", "origin", "HEAD"]);

    return `Saved and pushed: ${await runGit(root, ["log", "-1", "--stat", "--format=%h %s"])}`;
}
