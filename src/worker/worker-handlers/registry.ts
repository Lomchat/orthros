// Registry Tool handlers (host RegistryPanel: dump state, access log, clear
// persisted data, set a value). registry_clear must also cancel the worker's
// debounced registry autosave — that timer lives in emulator.worker.ts, so it
// is injected via the context object.
import { System } from "../core/system";
import { RegistryPersistence } from "../runtime/filesystem/registry-persistence";

export interface RegistryHandlerContext {
  /** Cancels the debounced registry autosave installed by the worker entry (see installRegistryAutosave). */
  cancelRegistryAutosave(): void;
}

/** Handles registry_* host messages. Returns true if the message was consumed. */
export function handleRegistryMessage(message: any, ctx: RegistryHandlerContext): boolean {
  if (message?.type === "registry_get_state") {
    try {
      const system = System.getInstance();
      const state = system.registry.serialize();
      self.postMessage({
        type: "registry_state",
        ok: true,
        gameId: state.gameId,
        keys: state.keys,
      });
    } catch (error) {
      self.postMessage({
        type: "registry_state",
        ok: false,
        error: String(error),
      });
    }
    return true;
  }

  if (message?.type === "registry_get_log") {
    try {
      const system = System.getInstance();
      const log = system.registry.getAccessLogBuffer();
      self.postMessage({
        type: "registry_log",
        ok: true,
        log,
      });
    } catch (error) {
      self.postMessage({
        type: "registry_log",
        ok: false,
        error: String(error),
      });
    }
    return true;
  }

  if (message?.type === "registry_clear") {
    try {
      const system = System.getInstance();
      const gameId = system.registry.serialize().gameId;
      if (gameId) {
        ctx.cancelRegistryAutosave();
        RegistryPersistence.clearGameData(gameId).then(() => {
          system.registry.reset();
          self.postMessage({ type: "registry_cleared", ok: true });
        });
      } else {
        self.postMessage({
          type: "registry_cleared",
          ok: false,
          error: "No game ID set",
        });
      }
    } catch (error) {
      self.postMessage({
        type: "registry_cleared",
        ok: false,
        error: String(error),
      });
    }
    return true;
  }

  if (message?.type === "registry_set_value") {
    try {
      const system = System.getInstance();
      const { key, valueName, valueType, valueData } = message;

      const registryValue = {
        name: valueName,
        type: valueType,
        data: valueData,
      };

      system.registry.setValue(key, valueName, registryValue);

      self.postMessage({ type: "registry_value_set", ok: true });
    } catch (error) {
      self.postMessage({
        type: "registry_value_set",
        ok: false,
        error: String(error),
      });
    }
    return true;
  }

  return false;
}
