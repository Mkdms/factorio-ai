// 游戏操作编号 (move-up、mine、shoot-enemy…) → 注入客户端的程序 `input` 工具认的物理按键 / 鼠标键 (M4 清单第 3 条)。
// 原样搬自第一版 pilot/src/game/controls.ts; 键位来自挂上游戏后 `input_bindings` 工具读到的当前绑定 (不写死, 也不用任何人的键位文件)。
import { readFileSync } from "node:fs";

export interface Binding {
  slot: string;
  type: "Keyboard" | "MouseButton" | "MouseWheel";
  name: string;
  modifiers: string[];
}

export interface Control {
  id: string;
  binding_owner?: string;
  bindings?: Binding[];
  effective_bindings?: Binding[];
}

export interface ResolvedControl {
  device: "keyboard" | "mouse";
  /** Key name for keyboard, button name for mouse buttons, "wheel:up"/"wheel:down" for wheels. */
  name: string;
  /** Modifier key names expressed as separate keyboard entries. */
  modifiers: string[];
}

const modifierKeys: Record<string, string> = { shift: "LSHIFT", control: "LCTRL", alt: "LALT" };

export class Controls {
  #byId = new Map<string, Control>();

  constructor(controls: Control[]) {
    for (const control of controls) this.#byId.set(control.id, control);
  }

  static load(path: string) {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return new Controls(data.controls ?? data);
  }

  static fromToolResult(result: { controls: Control[] }) {
    return new Controls(result.controls);
  }

  has(id: string) {
    return this.#byId.has(id);
  }

  /** Primary keyboard/mouse binding for a control. Throws when the control is unbound. */
  resolve(id: string): ResolvedControl {
    const control = this.#byId.get(id);
    if (!control) throw new Error(`Unknown control ${id}`);
    const bindings = control.effective_bindings ?? control.bindings ?? [];
    const binding = bindings.find((b) => b.slot === "keyboard_mouse_primary") ?? bindings[0];
    if (!binding) throw new Error(`Control ${id} has no keyboard/mouse binding`);
    const modifiers = binding.modifiers.map((m) => modifierKeys[m] ?? m.toUpperCase());
    if (binding.type === "Keyboard") return { device: "keyboard", name: binding.name, modifiers };
    if (binding.type === "MouseButton") return { device: "mouse", name: binding.name, modifiers };
    return { device: "mouse", name: `wheel:${binding.name}`, modifiers };
  }

  /** Keyboard key name for a control that must be a plain key (no modifiers). */
  key(id: string): string {
    const resolved = this.resolve(id);
    if (resolved.device !== "keyboard") throw new Error(`Control ${id} is bound to the mouse`);
    return resolved.name;
  }

  get move() {
    return { up: this.key("move-up"), down: this.key("move-down"), left: this.key("move-left"), right: this.key("move-right") };
  }
}
