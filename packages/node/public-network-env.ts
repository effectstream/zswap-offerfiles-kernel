// Side-effect module: applies the public-network node profile to process.env,
// or exits 78 naming every missing variable. main.public.ts imports it right
// after the onchain-runtime side-effect import so that it runs BEFORE env.ts,
// config.preview.ts and midnight-env read the environment — see
// public-network-profile.ts.
import { applyPublicNodeProfileOrExit } from "./public-network-profile.ts";

applyPublicNodeProfileOrExit();
