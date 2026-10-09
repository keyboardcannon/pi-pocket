/**
 * Paprika: a box session's project files. The box holds working copies of its project's setup.sh, resume.sh, and
 * AGENTS.md in ~/.pocket/; this tool saves them back to the project on the server, committed there, so later
 * boxes of the project get them. It also clears the note about a failed setup.sh once that is settled.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { BoxControls } from "../remote/env.ts";
import { PROJECT_FILES } from "../remote/projects.ts";

const saveProjectFiles = defineTool({
    name: "save_project_files",
    description:
        "Box sessions only. Save this box's working copies of the project's files (~/.pocket/setup.sh, " +
        "~/.pocket/resume.sh, ~/.pocket/AGENTS.md) to the project on the server (committed there), so later boxes " +
        "of this project use them. Only when the user asked for the change. setupResolved: true clears the note " +
        "that this box's setup.sh failed.",
    parameters: Type.Object({
        files: Type.Array(Type.Union(PROJECT_FILES.map((file) => Type.Literal(file))), {
            description: "Which of the box's ~/.pocket/ files to save; may be empty",
        }),
        message: Type.String({
            description: "The commit message: what changed and why, in one line",
        }),
        setupResolved: Type.Optional(
            Type.Boolean({ description: "The failed setup.sh is settled: stop reporting it" }),
        ),
    }),
    execute: async (args, api) => {
        const box = (api.env as { box?: BoxControls } | undefined)?.box;

        if (box === undefined) {
            throw new Error("save_project_files only works in box sessions");
        }

        const lines: string[] = [];

        if (args.files.length > 0) {
            lines.push(await box.saveProjectFiles(args.files, args.message));
        }

        if (args.setupResolved === true) {
            box.resolveSetup();
            lines.push("The note about the failed setup.sh is cleared.");
        }

        return {
            content: [{ type: "text" as const, text: lines.join("\n") || "Nothing to do." }],
        };
    },
});

export default function createBox() {
    return defineExtension({ name: "pocket-box", tools: [saveProjectFiles] });
}
