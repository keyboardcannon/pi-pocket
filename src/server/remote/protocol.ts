/**
 * Paprika: the wire protocol between a RemoteExecutionEnv (on the server) and its daemon (inside a remote box).
 *
 * One JSON object per line, in both directions, over the daemon's stdin and stdout. Lines are split on "\n" only.
 * Requests call one method of the daemon's NodeExecutionEnv; replies carry its Result. Bytes travel as base64 and
 * errors as their class, code, and message, so the server side gets the same FileError and ExecutionError objects a
 * local environment returns.
 */
import { StringDecoder } from "node:string_decoder";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";

export const PROTOCOL_VERSION = 1;

/** Environment methods a request may call, with a reader handle for `openTextLineReader`. */
export const ENV_METHODS = [
    "absolutePath",
    "joinPath",
    "readTextFile",
    "openTextLineReader",
    "readTextLines",
    "readBinaryFile",
    "writeFile",
    "appendFile",
    "truncateFile",
    "flushFile",
    "renameFile",
    "fileInfo",
    "listDir",
    "canonicalPath",
    "exists",
    "createDir",
    "remove",
    "createTempDir",
    "createTempFile",
    "exec",
] as const;

export type EnvMethod = (typeof ENV_METHODS)[number];
export type ReaderMethod = "reader.readLine" | "reader.close";

export type Request =
    | { readonly id: number; readonly method: EnvMethod | ReaderMethod; readonly args: unknown[] }
    | { readonly id: number; readonly abort: true };

export type Reply =
    /** First line the daemon writes. */
    | { readonly hello: { readonly version: number; readonly cwd: string; readonly pid: number } }
    | { readonly id: number; readonly result: unknown }
    /** Streamed `exec` output for the request with this id. */
    | { readonly id: number; readonly output: string }
    /** The daemon could not run the request at all (unknown method, bad arguments). */
    | { readonly id: number; readonly failure: string };

type Encoded =
    | { $bytes: string }
    | {
          $error: {
              kind: "FileError" | "ExecutionError" | "Error";
              code?: string;
              message: string;
              path?: string;
              spillPath?: string;
          };
      }
    | { $reader: number };

/** JSON-safe form of a value: Uint8Array and Error objects become tagged objects. */
export function encode(value: unknown): unknown {
    if (value instanceof Uint8Array) {
        return { $bytes: Buffer.from(value).toString("base64") } satisfies Encoded;
    }

    if (value instanceof FileError) {
        return {
            $error: {
                kind: "FileError",
                code: value.code,
                message: value.message,
                path: value.path,
            },
        } satisfies Encoded;
    }

    if (value instanceof ExecutionError) {
        return {
            $error: {
                kind: "ExecutionError",
                code: value.code,
                message: value.message,
                spillPath: value.spillPath,
            },
        } satisfies Encoded;
    }

    if (value instanceof Error) {
        return { $error: { kind: "Error", message: value.message } } satisfies Encoded;
    }

    if (Array.isArray(value)) {
        return value.map(encode);
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
    }

    return value;
}

/** Reverse of `encode`. Reader handles are left as `{ $reader }` for the caller to wrap. */
export function decode(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(decode);
    }

    if (value === null || typeof value !== "object") {
        return value;
    }

    const tagged = value as Partial<Encoded> & Record<string, unknown>;

    if (typeof tagged.$bytes === "string") {
        return new Uint8Array(Buffer.from(tagged.$bytes, "base64"));
    }

    if (tagged.$error !== undefined && typeof tagged.$error === "object") {
        const error = tagged.$error as Extract<Encoded, { $error: unknown }>["$error"];

        if (error.kind === "FileError") {
            return new FileError(
                (error.code ?? "unknown") as FileError["code"],
                error.message,
                error.path,
            );
        }

        if (error.kind === "ExecutionError") {
            const execution = new ExecutionError(
                (error.code ?? "unknown") as ExecutionError["code"],
                error.message,
            );

            if (error.spillPath !== undefined) {
                execution.spillPath = error.spillPath;
            }

            return execution;
        }

        return new Error(error.message);
    }

    if (typeof tagged.$reader === "number") {
        return value;
    }

    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}

/** Splits a byte stream into "\n"-terminated lines; never on other Unicode line separators. */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
    let pending = "";
    // A multi-byte character can be split across chunks; the decoder keeps the partial bytes for the next one.
    const decoder = new StringDecoder("utf8");

    return (chunk) => {
        pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
        let newline = pending.indexOf("\n");

        while (newline !== -1) {
            const line = pending.slice(0, newline);

            pending = pending.slice(newline + 1);

            if (line.trim() !== "") {
                onLine(line);
            }

            newline = pending.indexOf("\n");
        }
    };
}
