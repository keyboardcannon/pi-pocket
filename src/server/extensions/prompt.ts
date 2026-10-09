/**
 * The system prompt: who the agent is, how to behave on a phone-sized screen, where Pi Pocket's documentation is, the
 * project's AGENTS.md files, Pi's skills, and the working directory. Sections render before every request; only
 * changed sections are sent again, so everything here is stable between requests unless a file on disk changed.
 *
 * Edit freely: saving this file reloads it into the running server.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
    formatSkillsForPrompt,
    getDocsPath,
    loadProjectContextFiles,
    loadSkills,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import { APP_ROOT } from "../config.ts";
import type { BoxControls } from "../remote/env.ts";
import { readProject } from "../remote/projects.ts";
import type { PocketHost } from "../host.ts";

const PREAMBLE = `You are Pi, a coding agent running inside Pi Pocket: a durable, multiplayer web app built on Pi Durable. People talk to you from a browser, often a phone, and several people can share one conversation. When more than one person uses this server, each message starts with [from: Name].

You work in the conversation's working directory with the tools you are given. Your work is durable: if the server restarts, you continue where you left off. A tool call cut off by a restart comes back as an "interrupted" error when it was not safe to repeat; check what actually happened before you retry it.`;

const GUIDELINES = `- Keep replies short and easy to read on a small screen. Lead with the answer; use short paragraphs, lists, and small code blocks.
- Use read to look at files instead of cat or sed. Use edit for precise changes and write for new files or full rewrites.
- Show file paths clearly when you work with files.
- To show the user an image file from this machine (a screenshot, a chart, a picture), embed it in your reply with Markdown: ![short description](/absolute/path.png). Paths relative to the working directory work too. Files the user attaches are saved on the server; their paths are listed in the message.
- Before running something destructive or irreversible, say what it will do. A guard may ask a human to approve risky commands; if a call is blocked, do not try to get around the block.
- Do not commit, push, publish, or deploy unless asked.`;

/**
 * Where Pi Pocket's documentation for agents is, as Pi's prompt says where Pi's is: to read only when it is
 * needed.
 */
function docs(dataDir: string): string {
    const code = resolve(APP_ROOT);
    const folder = join(code, "docs");

    return `Pi Pocket documentation (read only when someone asks about Pi Pocket itself: how it works, changing how you behave in it, extending it, or changing its code):
- Start here: ${join(folder, "index.md")}
- Pi Pocket's code is in ${code}; its data (people, settings, sessions) in ${dataDir}. Change the data through the app, never by editing its files, except extensions/ in it, where drop-in extensions go.
- When asked about: changing how you behave without code, such as instructions, AGENTS.md, skills, or prompt templates (docs/customizing.md); a new tool, prompt section, or hook (docs/extensions.md, with working examples in docs/examples/); changing Pi Pocket's own code while it runs (docs/self-editing.md); where its code is (docs/map.md); how its parts depend on each other (docs/architecture.md); what a feature does (docs/features.md)
- Resolve docs/... under ${code}, not the working directory. Read a doc completely, and follow its links, before changing anything.
- Pi's own documentation (skills, prompt templates, models, providers, settings): ${getDocsPath()}`;
}

/**
 * Paprika: the preamble, guidelines, and box section can be replaced with Markdown files in $PI_POCKET_PROMPT_DIR
 * (preamble.md, guidelines.md, box.md). A missing file keeps the built-in text (box: no section). Files are read again
 * only when they change on disk, so the prompt stays the same, and cache-friendly, between edits.
 */
const PROMPT_DIR = process.env.PI_POCKET_PROMPT_DIR;
const promptFiles = new Map<string, { mtimeMs: number; text: string }>();

function promptFile(name: string, fallback: string | undefined): string | undefined {
    if (PROMPT_DIR === undefined || PROMPT_DIR === "") {
        return fallback;
    }

    const path = join(PROMPT_DIR, name);

    try {
        const { mtimeMs } = statSync(path);
        const cached = promptFiles.get(path);

        if (cached !== undefined && cached.mtimeMs === mtimeMs) {
            return cached.text;
        }

        const text = readFileSync(path, "utf8").trim();

        promptFiles.set(path, { mtimeMs, text });

        return text === "" ? fallback : text;
    } catch {
        return fallback;
    }
}

/** Paprika: whether the conversation's tools run in a remote box (set by the remote execution environment). */
function isRemote(input: PromptInput): boolean {
    return (input.env as { remote?: unknown } | undefined)?.remote === true;
}

const STALE_MS = 30_000;

type Resources = { at: number; context: string | undefined; skills: string | undefined };

export default function createPrompt(host: PocketHost) {
    // Context files and skills load once per directory, and again when the copy is older than STALE_MS.
    const resources = new Map<string, Resources>();

    const load = (cwd: string): Resources => {
        const cached = resources.get(cwd);

        if (cached !== undefined && Date.now() - cached.at < STALE_MS) {
            return cached;
        }

        let context: string | undefined;
        let skills: string | undefined;

        try {
            const files = loadProjectContextFiles({ cwd, agentDir: host.agentDir });

            if (files.length > 0) {
                context = files
                    .map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`)
                    .join("\n\n");
            }
        } catch (error) {
            host.notice("warning", `Could not load AGENTS.md files for ${cwd}: ${String(error)}`);
        }

        try {
            const loaded = loadSkills({
                cwd,
                agentDir: host.agentDir,
                skillPaths: host.skillPaths(),
                includeDefaults: true,
            });
            const text = formatSkillsForPrompt(loaded.skills, "read").trim();

            skills = text === "" ? undefined : text;
        } catch (error) {
            host.notice("warning", `Could not load skills for ${cwd}: ${String(error)}`);
        }

        const fresh = { at: Date.now(), context, skills };

        resources.set(cwd, fresh);

        return fresh;
    };

    const cwdOf = (input: PromptInput) => input.env?.cwd ?? input.agent.cwd ?? process.cwd();

    // Paprika: in a box session the project's AGENTS.md files are in the box. Pi's global ones (in its agent
    // directory on this server) still come first; skills are the global ones on this server.
    const remoteContext = new Map<string, { at: number; text: string | undefined }>();

    const loadRemoteContext = async (
        input: PromptInput,
        context: Context,
    ): Promise<string | undefined> => {
        const env = input.env!;
        const cached = remoteContext.get(env.id);

        if (cached !== undefined && Date.now() - cached.at < STALE_MS) {
            return cached.text;
        }

        // The box is being prepared since the message was sent; its files are readable once it is ready.
        await (env as { box?: BoxControls }).box?.ready();

        const files: string[] = [];

        try {
            for (const file of loadProjectContextFiles({
                cwd: host.agentDir,
                agentDir: host.agentDir,
            })) {
                if (file.path.startsWith(host.agentDir)) {
                    files.push(`<file path="${file.path}">\n${file.content.trim()}\n</file>`);
                }
            }
        } catch (error) {
            host.notice("warning", `Could not load global AGENTS.md files: ${String(error)}`);
        }

        // The project's own instructions, from its folder on this server.
        const projectName = (env as { project?: string }).project;

        try {
            const projectAgents =
                projectName === undefined ? undefined : readProject(projectName)?.agents;

            if (projectAgents !== undefined && projectAgents.trim() !== "") {
                files.push(
                    `<file path="projects/${projectName}/AGENTS.md">\n${projectAgents.trim()}\n</file>`,
                );
            }
        } catch (error) {
            host.notice("warning", `Could not load project ${projectName}: ${String(error)}`);
        }

        const project: string[] = [];

        for (let dir = env.cwd; ; dir = dirname(dir)) {
            for (const name of ["AGENTS.md", "CLAUDE.md"]) {
                const path = join(dir, name);
                const read = await env.readTextFile(path, context);

                if (read.ok) {
                    project.unshift(`<file path="${path}">\n${read.value.trim()}\n</file>`);
                    break;
                }
            }

            if (dir === dirname(dir)) {
                break;
            }
        }

        files.push(...project);
        const text = files.length > 0 ? files.join("\n\n") : undefined;

        remoteContext.set(env.id, { at: Date.now(), text });

        return text;
    };

    return defineExtension({
        name: "pocket-prompt",
        sections: [
            section("preamble", () => promptFile("preamble.md", PREAMBLE), { tag: false }),
            section("guidelines", () => promptFile("guidelines.md", GUIDELINES)),
            section("box", (input) =>
                isRemote(input) ? promptFile("box.md", undefined) : undefined,
            ),
            // Paprika: what the agent must know about its box now, such as a failed setup.sh.
            section("box_status", (input) =>
                isRemote(input)
                    ? (input.env as { box?: BoxControls } | undefined)?.box?.status()
                    : undefined,
            ),
            // Paprika: not in box sessions, where Pi Pocket's code and docs on this server are beside the point.
            section("pocket_docs", (input) => (isRemote(input) ? undefined : docs(host.dataDir))),
            section("project_context", (input, context) =>
                isRemote(input) ? loadRemoteContext(input, context) : load(cwdOf(input)).context,
            ),
            section(
                "skills",
                (input) => load(isRemote(input) ? host.agentDir : cwdOf(input)).skills,
                {
                    tag: false,
                },
            ),
            section("environment", (input) => {
                // The date only, so the prompt stays cache-friendly through the day.
                const today = new Date().toISOString().slice(0, 10);

                return `Working directory: ${cwdOf(input)}\nPlatform: ${process.platform}\nToday: ${today}`;
            }),
        ],
    });
}
