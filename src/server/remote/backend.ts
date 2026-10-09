/**
 * Paprika: what a box provider must offer. The implementation lives outside Pi Pocket (for Boat: the agentbox
 * repository) and is loaded from the module named by $PI_POCKET_BOX_BACKEND.
 */
import { pathToFileURL } from "node:url";

export interface BoxSpec {
    /** The box's name, as people and the provider's tooling know it. */
    readonly name: string;
    /** The provider's identifier for the box. */
    readonly sandboxId: string;
    /** The project's directory inside the box. */
    readonly cwd: string;
}

export type BoxStatus = "running" | "stopped" | "starting" | "missing";

export interface BoxBackend {
    readonly name: string;
    /** The user commands run as inside the box. */
    readonly boxUser: string;
    /** Absolute path of a Node.js >= 22 binary inside the box. */
    readonly nodePath: string;
    status(box: BoxSpec): Promise<BoxStatus>;
    /** Starts a stopped box and returns once commands can run in it. */
    start(box: BoxSpec): Promise<void>;
    stop(box: BoxSpec): Promise<void>;
    /** Makes the provider stop the box by itself at `untilMs` unless renewed again. */
    renewLease(box: BoxSpec, untilMs: number): Promise<void>;
    /** argv that runs one shell command in the box when the command is appended (an `ssh ... user@host`). */
    sshArgs(box: BoxSpec): Promise<string[]>;
}

let loaded: Promise<BoxBackend> | undefined;

/** The configured backend, or undefined when no box backend is configured. */
export function loadBoxBackend(): Promise<BoxBackend> | undefined {
    const path = process.env.PI_POCKET_BOX_BACKEND;

    if (path === undefined || path === "") {
        return undefined;
    }

    loaded ??= import(pathToFileURL(path).href).then(
        (module: { default: BoxBackend }) => module.default,
    );

    return loaded;
}
