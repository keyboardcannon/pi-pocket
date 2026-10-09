/**
 * Paprika: builds daemon.ts into one self-contained ES module with this server's own pi-durable, so the daemon in a
 * box always speaks the same protocol and runs the same environment code as the server. Built once per process;
 * the hash names the uploaded file, so a box only receives a new copy when the code changed.
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export interface DaemonBundle {
    readonly code: string;
    readonly hash: string;
}

let bundled: Promise<DaemonBundle> | undefined;

export function daemonBundle(): Promise<DaemonBundle> {
    bundled ??= (async () => {
        const result = await build({
            entryPoints: [fileURLToPath(new URL("./daemon.ts", import.meta.url))],
            bundle: true,
            platform: "node",
            format: "esm",
            target: "node22",
            write: false,
            legalComments: "none",
            logLevel: "silent",
            // Some dependencies use require(); give the ES module bundle a working one.
            banner: {
                js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
            },
        });
        const code = result.outputFiles[0]!.text;

        return { code, hash: createHash("sha256").update(code).digest("hex").slice(0, 16) };
    })().catch((error: unknown) => {
        bundled = undefined;

        throw error;
    });

    return bundled;
}
