import { harness } from "../harness";

const result = await harness()
    .pause()
    .shot({ save: "bfme-menu-viewport-fixed" })
    .resume()
    .run();

console.log(JSON.stringify(result, null, 2));
