/**
 * Paprika: projects that sessions can run in a box. One folder per project in $PI_POCKET_PROJECTS_DIR:
 *
 *   <name>/project.json   { "name": "<name>", "title"?: "..." }
 *   <name>/setup.sh       optional: run once in a new box, in /workspace, to build the project's environment
 *   <name>/resume.sh      optional: run every time the box starts, before the agent's calls go through
 *   <name>/AGENTS.md      optional: added to the system prompt of the project's sessions
 *
 * Secrets: $PI_POCKET_PROJECT_SECRETS_DIR/<name>.env (KEY=value lines), only on this server. The box gets them at
 * ~/.pocket/env, which the scripts and every command the agent runs see as environment variables.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Project {
    readonly name: string;
    readonly title: string;
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

    const parsed = JSON.parse(spec) as { name?: string; title?: string };

    if (parsed.name !== undefined && parsed.name !== name) {
        throw new Error(`project ${name}: project.json names it ${parsed.name}`);
    }

    const secretsDir = process.env.PI_POCKET_PROJECT_SECRETS_DIR;

    return {
        name,
        title: parsed.title ?? name,
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
