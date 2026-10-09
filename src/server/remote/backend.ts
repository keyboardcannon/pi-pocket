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
    /** The project's directory inside the box; default /workspace. */
    readonly workspace?: string;
    /** The box user's home directory; default /home/<boxUser>. */
    readonly home?: string;
    /** A shell command as the box user; default: `sudo -n -u <boxUser> -H bash -c '<command>'`. */
    asUser?(command: string): string;
    /** A shell command as root; default: `sudo -n bash -c '<command>'`. */
    asRoot?(command: string): string;
    /** Creates a box from the provider's base image, named `name`, and returns once commands can run in it. */
    create(request: { name: string; project: string }): Promise<{ sandboxId: string }>;
    /** Deletes a box and its disk. */
    destroy(box: BoxSpec): Promise<void>;
    status(box: BoxSpec): Promise<BoxStatus>;
    /** Starts a stopped box and returns once commands can run in it. */
    start(box: BoxSpec): Promise<void>;
    stop(box: BoxSpec): Promise<void>;
    /** Makes the provider stop the box by itself at `untilMs` unless renewed again. */
    renewLease(box: BoxSpec, untilMs: number): Promise<void>;
    /**
     * argv that runs one shell command in the box when the command is appended (an `ssh ... user@host`). With
     * `forward`, the connection also makes `127.0.0.1:boxPort` in the box reach `127.0.0.1:localPort` here.
     */
    sshArgs(
        box: BoxSpec,
        options?: { forward?: { boxPort: number; localPort: number } },
    ): Promise<string[]>;
}

/** Quotes a value for a POSIX shell. */
export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A command as the box user, through the backend's own wrapper or sudo. */
export function asBoxUser(backend: BoxBackend, command: string): string {
    return (
        backend.asUser?.(command) ??
        `sudo -n -u ${backend.boxUser} -H bash -c ${shellQuote(command)}`
    );
}

/** A command as root, through the backend's own wrapper or sudo. */
export function asBoxRoot(backend: BoxBackend, command: string): string {
    return backend.asRoot?.(command) ?? `sudo -n bash -c ${shellQuote(command)}`;
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
