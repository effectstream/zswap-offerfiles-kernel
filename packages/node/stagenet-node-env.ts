// Side-effect module: applies the stagenet node profile to process.env, or
// exits 78 naming every missing variable. main.stagenet.ts imports it right
// after the onchain-runtime side-effect import so that it runs BEFORE env.ts
// and config.preview.ts read the environment — see stagenet-profile.ts.
import { applyStagenetNodeProfileOrExit } from "./stagenet-profile.ts";

applyStagenetNodeProfileOrExit();
