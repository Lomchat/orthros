import { afterEach, describe, expect, test } from "bun:test";
import {
  canDispatchGuestProcessHandoff,
  clearGuestProcessHandoff,
  dispatchGuestProcessHandoff,
  guestExecutableToBundleEntrypoint,
  parseGuestProcessLaunch,
  queueGuestProcessHandoff,
  setGuestProcessHandoffHandler,
  splitWindowsExecutable,
  takeGuestProcessHandoff,
  type GuestProcessHandoffRequest,
} from "../../src/worker/core/guest-process-handoff";

const request: GuestProcessHandoffRequest = {
  executableToken: "game.dat",
  executablePath: "C:\\game.dat",
  arguments: "-win -xres 1024",
  applicationName: "",
  commandLine: '"game.dat" -win -xres 1024',
  currentDirectory: "C:\\",
  creationFlags: 0,
};

afterEach(() => {
  clearGuestProcessHandoff();
  setGuestProcessHandoffHandler(null);
});

describe("guest process command parsing", () => {
  test("splits a quoted executable and preserves its arguments", () => {
    expect(splitWindowsExecutable('  "C:\\Games\\game.dat"  -win -xres 1024')).toEqual({
      token: "C:\\Games\\game.dat",
      rest: "-win -xres 1024",
    });
  });

  test("derives the executable from a null lpApplicationName", () => {
    expect(parseGuestProcessLaunch("", '"game.dat" -win')).toEqual({
      executableToken: "game.dat",
      arguments: "-win",
    });
  });

  test("does not duplicate argv0 when lpApplicationName is supplied", () => {
    expect(parseGuestProcessLaunch("C:\\Games\\game.exe", 'game.exe -foo')).toEqual({
      executableToken: "C:\\Games\\game.exe",
      arguments: "-foo",
    });
  });

  test("maps a C drive child back into the bundle ROM root", () => {
    expect(guestExecutableToBundleEntrypoint("C:\\Games\\game.dat", "rom")).toBe("rom/Games/game.dat");
    expect(guestExecutableToBundleEntrypoint("D:\\game.exe", "rom")).toBeNull();
  });
});

describe("guest process handoff queue", () => {
  test("is one-shot and dispatches a defensive copy", () => {
    const received: GuestProcessHandoffRequest[] = [];
    setGuestProcessHandoffHandler((value) => received.push(value));
    expect(queueGuestProcessHandoff(request)).toBe(true);
    expect(queueGuestProcessHandoff(request)).toBe(false);
    expect(canDispatchGuestProcessHandoff()).toBe(true);
    const pending = takeGuestProcessHandoff();
    expect(pending).toEqual(request);
    expect(canDispatchGuestProcessHandoff()).toBe(false);
    expect(dispatchGuestProcessHandoff(pending!)).toBe(true);
    expect(received).toEqual([request]);
    expect(received[0]).not.toBe(request);
  });
});
