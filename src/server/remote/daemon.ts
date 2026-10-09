/**
 * Paprika: the execution-environment daemon that runs inside a remote box.
 *
 * It serves one NodeExecutionEnv over stdin/stdout (see protocol.ts) for as long as its SSH connection lives. The
 * server bundles this file with its own pi-durable and uploads it on connect, so both sides always run the same
 * pi-durable version. Usage: node daemon.mjs <cwd>
 */
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { TextLineReader } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
    decode,
    ENV_METHODS,
    encode,
    lineSplitter,
    PROTOCOL_VERSION,
    type Reply,
    type Request,
} from "./protocol.ts";

const cwd = process.argv[2] ?? process.cwd();
const env = new NodeExecutionEnv({ cwd });
const running = new Map<number, AbortController>();
const readers = new Map<number, TextLineReader>();
let nextReader = 1;

function send(reply: Reply): void {
    process.stdout.write(`${JSON.stringify(reply)}\n`);
}

async function handle(request: Extract<Request, { method: string }>): Promise<void> {
    const controller = new AbortController();

    running.set(request.id, controller);
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    const args = decode(request.args) as unknown[];

    try {
        let result: unknown;

        if (request.method === "reader.readLine" || request.method === "reader.close") {
            const reader = readers.get(args[0] as number);

            if (reader === undefined) {
                throw new Error(`unknown reader ${String(args[0])}`);
            }

            if (request.method === "reader.readLine") {
                result = await reader.readLine(context);
            } else {
                readers.delete(args[0] as number);
                await reader.close(context);
                result = null;
            }
        } else if (request.method === "exec") {
            const [command, options] = args as [string, Record<string, unknown> | undefined];

            result = await env.exec(
                command,
                { ...options, onOutput: (text: string) => send({ id: request.id, output: text }) },
                context,
            );
        } else if ((ENV_METHODS as readonly string[]).includes(request.method)) {
            const method = (
                env as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
            )[request.method]!;

            result = await method.call(env, ...args, context);

            if (request.method === "openTextLineReader") {
                const opened = result as { ok: boolean; value?: TextLineReader };

                if (opened.ok && opened.value !== undefined) {
                    const handleId = nextReader++;

                    readers.set(handleId, opened.value);
                    result = { ok: true, value: { $reader: handleId } };
                }
            }
        } else {
            send({ id: request.id, failure: `unknown method ${request.method}` });

            return;
        }

        send({ id: request.id, result: encode(result) });
    } catch (error) {
        send({ id: request.id, failure: error instanceof Error ? error.message : String(error) });
    } finally {
        running.delete(request.id);
    }
}

process.stdin.on(
    "data",
    lineSplitter((line) => {
        const request = JSON.parse(line) as Request;

        if ("abort" in request) {
            running.get(request.id)?.abort();

            return;
        }

        void handle(request);
    }),
);

// The connection closing ends the daemon: abort running commands, close readers, and exit.
process.stdin.on("end", () => {
    for (const controller of running.values()) {
        controller.abort();
    }

    void env.cleanup(BACKGROUND_CONTEXT).finally(() => process.exit(0));
});

send({ hello: { version: PROTOCOL_VERSION, cwd, pid: process.pid } });
