import { CoinFrameEventMarketData } from "./history/coin_frame.js";

/**
 * Set of types that can be used by exec system master class.
 */
export type ExecTarget = CoinTarget | CoinTarget; // You can add more targets here

/**
 * Here are history data types that can be used by exec system.
 */
type CoinTarget = CoinFrameEventMarketData;