/** Paprika: files installed into a box at setup. */
import { BOX_GIT_PORT } from "./git-proxy.ts";

/** `gh` in a box: runs on the server for this project's repositories (see GitProxy). */
export function ghShim(nodePath: string): string {
    return `#!${nodePath}
// gh in a pocket box: runs on the server, for this project's GitHub repositories.
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { request } = require("node:http");
const { join } = require("node:path");

const git = (...args) => {
    try {
        return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return "";
    }
};
const key = readFileSync(join(process.env.HOME, ".pocket", "git-key"), "utf8").trim();
const origin = git("remote", "get-url", "origin");
const match = /github\\.com[:/]([^/]+\\/[^/]+?)(?:\\.git)?$/.exec(origin);
const args = process.argv.slice(2);
// There is no checkout on the server: tell pr create which branch, unless the arguments do.
if (args[0] === "pr" && args[1] === "create" && !args.some((a) => a === "--head" || a === "-H" || a.startsWith("--head="))) {
    args.push("--head", git("branch", "--show-current"));
}
const body = JSON.stringify({ args, ...(match ? { repo: match[1] } : {}) });
const req = request(
    { host: "127.0.0.1", port: ${BOX_GIT_PORT}, path: \`/\${key}/gh\`, method: "POST", headers: { "content-type": "application/json" } },
    (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
            try {
                const { code, stdout, stderr } = JSON.parse(data);
                process.stdout.write(stdout);
                process.stderr.write(stderr);
                process.exit(code);
            } catch {
                process.stderr.write(\`gh: unexpected answer from the server: \${data.slice(0, 200)}\\n\`);
                process.exit(1);
            }
        });
    },
);
req.on("error", (error) => {
    process.stderr.write(\`gh: cannot reach the server (\${error.message}); gh only works from the agent's own commands\\n\`);
    process.exit(1);
});
req.end(body);
`;
}

/** Removes the box's git URL rewrites, which hold its key (before a snapshot of the box is saved). */
export function gitForgetCommand(key: string): string {
    return `git config --global --remove-section 'url.http://127.0.0.1:${BOX_GIT_PORT}/${key}/github.com/' 2>/dev/null; true`;
}

/** The box's git setup: GitHub through the tunnel, commits as the server's GitHub account. */
export function gitSetupCommands(key: string, identity: { name: string; email: string }): string {
    const base = `http://127.0.0.1:${BOX_GIT_PORT}/${key}/github.com/`;
    const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

    return [
        `git config --global --replace-all url.${base}.insteadOf https://github.com/`,
        `git config --global --add url.${base}.insteadOf git@github.com:`,
        `git config --global --add url.${base}.insteadOf ssh://git@github.com/`,
        `git config --global user.name ${q(identity.name)}`,
        `git config --global user.email ${q(identity.email)}`,
        `git config --global init.defaultBranch main`,
    ].join(" && ");
}
