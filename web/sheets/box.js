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
