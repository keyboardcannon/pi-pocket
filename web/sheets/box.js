// Paprika: the session's remote box: its project and state, and stopping or destroying it.
import { useState } from "preact/hooks";
import { actions, attempt, closeSheet, currentBox } from "../store.js";
import { html, Icon, Sheet } from "../ui.js";

const STATES = {
    none: "No box yet: it starts with the next message",
    creating: "Creating the box…",
    "setting-up": "Running the project's setup…",
    starting: "Starting…",
    running: "Running",
    stopping: "Stopping…",
    stopped: "Stopped: it starts again when Pi needs it",
};

export function BoxSheet() {
    const box = currentBox();
    const [confirm, setConfirm] = useState(false);

    if (box === undefined) {
        return html`<${Sheet} title="Box" onClose=${closeSheet}>
            <div class="muted pad">This session runs on the server, not in a box.</div>
        <//>`;
    }

    return html`<${Sheet} title="Box" onClose=${closeSheet}>
        <div class="list-item">
            <span>Project</span>
            <span class="mono">${box.project}</span>
        </div>
        ${
            box.name !== undefined &&
            html`<div class="list-item">
                <span>Box</span>
                <span class="mono">${box.name}</span>
            </div>`
        }
        <div class="list-item">
            <span>State</span>
            <span>${STATES[box.state] ?? box.state}</span>
        </div>
        ${
            box.setup?.ok === false &&
            html`<div class="list-item">
                    <span>Setup</span>
                    <span class="warn">setup.sh failed (exit ${box.setup.exitCode})</span>
                </div>
                <div class="muted pad">
                    Its log is <span class="mono">${box.setup.log}</span> in the box. Pi knows, and looks into it with
                    you before anything else.
                </div>`
        }
        ${
            box.setup?.snapshot &&
            html`<div class="list-item">
                <span>Setup</span>
                <span>from the project's snapshot</span>
            </div>`
        }
        <div class="muted pad">
            The box stops after five idle minutes and starts again when Pi needs it. Its files stay; running processes do
            not.
        </div>
        ${
            box.state === "running" &&
            html`<button class="button wide" onClick=${() => attempt(() => actions.boxAction("stop"))}>
                <${Icon} name="stop" size=${15} /> Stop now
            </button>`
        }
        ${
            box.name !== undefined &&
            html`<button
                class=${`button wide ${confirm ? "danger" : ""}`}
                onClick=${() =>
                    confirm
                        ? attempt(async () => {
                              await actions.boxAction("destroy");
                              setConfirm(false);
                          })
                        : setConfirm(true)}
            >
                <${Icon} name="close" size=${15} />
                ${confirm ? "Tap again to destroy the box and its files" : "Destroy box"}
            </button>`
        }
    <//>`;
}

/**
 * Paprika: what a panel shows instead of a stopped box's files, or undefined when it can show them (a local session,
 * or a box that is running). Panels never start a box by themselves; this button does.
 */
export function boxStoppedNotice(what) {
    const box = currentBox();

    if (box === undefined || box.state === "running") {
        return undefined;
    }

    const starting = ["creating", "setting-up", "starting"].includes(box.state);
    const startable = box.state === "none" || box.state === "stopped";
    const said =
        box.state === "none"
            ? `This session has no box yet. Start one to see ${what}.`
            : starting
              ? `The box is starting; ${what} show when it runs.`
              : box.state === "stopping"
                ? "The box is stopping."
                : `The box is stopped. Start it to see ${what}.`;

    return html`<div class="muted pad">
        <p>${said}</p>
        ${
            startable &&
            html`<button class="button" onClick=${() => attempt(() => actions.boxAction("start"))}>
                <${Icon} name="reload" size=${15} /> Start box
            </button>`
        }
    </div>`;
}
