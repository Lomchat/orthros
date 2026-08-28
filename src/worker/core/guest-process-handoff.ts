export interface GuestProcessLaunch {
    executableToken: string;
    arguments: string;
}

export interface GuestProcessHandoffRequest extends GuestProcessLaunch {
    executablePath: string;
    applicationName: string;
    commandLine: string;
    currentDirectory: string;
    creationFlags: number;
}

type GuestProcessHandoffHandler = (request: GuestProcessHandoffRequest) => void;

let pendingHandoff: GuestProcessHandoffRequest | null = null;
let handoffHandler: GuestProcessHandoffHandler | null = null;

/** Split only argv[0] from a Windows command line, preserving the remainder verbatim. */
export function splitWindowsExecutable(commandLine: string): { token: string; rest: string } {
    const input = commandLine.trimStart();
    if (!input) return { token: "", rest: "" };

    if (input[0] === '"') {
        const end = input.indexOf('"', 1);
        if (end < 0) return { token: input.slice(1), rest: "" };
        return { token: input.slice(1, end), rest: input.slice(end + 1).trimStart() };
    }

    const match = input.match(/\s/);
    if (!match || match.index === undefined) return { token: input, rest: "" };
    return { token: input.slice(0, match.index), rest: input.slice(match.index).trimStart() };
}

const comparableWindowsPath = (path: string): string =>
    path.trim().replace(/^"|"$/g, "").replace(/\//g, "\\").toLowerCase();

const basename = (path: string): string => {
    const normalized = comparableWindowsPath(path);
    const slash = normalized.lastIndexOf("\\");
    return slash >= 0 ? normalized.slice(slash + 1) : normalized;
};

/** Apply CreateProcess' two legal executable forms and return args without argv[0]. */
export function parseGuestProcessLaunch(applicationName: string, commandLine: string): GuestProcessLaunch | null {
    const app = applicationName.trim().replace(/^"|"$/g, "");
    const parsed = splitWindowsExecutable(commandLine);

    if (!app) {
        if (!parsed.token) return null;
        return { executableToken: parsed.token, arguments: parsed.rest };
    }

    let args = commandLine.trim();
    if (parsed.token) {
        const appPath = comparableWindowsPath(app);
        const commandPath = comparableWindowsPath(parsed.token);
        if (commandPath === appPath || basename(commandPath) === basename(appPath)) {
            args = parsed.rest;
        }
    }
    return { executableToken: app, arguments: args };
}

/** Convert an already-resolved C: guest path back to its entry in the mounted WGB. */
export function guestExecutableToBundleEntrypoint(executablePath: string, romRoot: string): string | null {
    const normalized = executablePath.trim().replace(/\//g, "\\");
    const match = normalized.match(/^C:\\(.+)$/i);
    if (!match) return null;
    const root = romRoot.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const relative = match[1]!.replace(/\\/g, "/").replace(/^\/+/, "");
    return root ? `${root}/${relative}` : relative;
}

export function setGuestProcessHandoffHandler(handler: GuestProcessHandoffHandler | null): void {
    handoffHandler = handler;
}

export function queueGuestProcessHandoff(request: GuestProcessHandoffRequest): boolean {
    if (pendingHandoff) return false;
    pendingHandoff = { ...request };
    return true;
}

export function canDispatchGuestProcessHandoff(): boolean {
    return pendingHandoff !== null && handoffHandler !== null;
}

export function takeGuestProcessHandoff(): GuestProcessHandoffRequest | null {
    const request = pendingHandoff;
    pendingHandoff = null;
    return request;
}

export function dispatchGuestProcessHandoff(request: GuestProcessHandoffRequest): boolean {
    if (!handoffHandler) return false;
    handoffHandler({ ...request });
    return true;
}

export function clearGuestProcessHandoff(): void {
    pendingHandoff = null;
}
