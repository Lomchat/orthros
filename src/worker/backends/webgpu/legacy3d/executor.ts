import { Legacy3DApi } from "./types";

export abstract class Legacy3DExecutor {
    readonly api: Legacy3DApi;

    protected constructor(api: Legacy3DApi) {
        this.api = api;
    }

    abstract captureFrame(): Promise<Blob>;
    abstract destroy(): void;
}
