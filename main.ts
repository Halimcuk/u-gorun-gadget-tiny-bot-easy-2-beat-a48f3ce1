// Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana.
//
// A small paper-trading bot for hourly SOL bars. It holds SOL only when its
// trend filter says the trend is up and confirmed, and otherwise sits in
// USDC. The strategy lives in strategy.ts: a fast/slow EMA crossover for the
// trend, an average-true-range filter and volatility sizing for the entries,
// and an RSI confirmation plus an early exit when momentum fades.
//
// The grader runs `node main.ts` on Node 22. Everything the bot needs ships
// in this repository; it reads no clock, no environment and no network, so a
// replay of the same bars always produces the same trades. The strategy
// parameters (EMA lengths, ATR and RSI thresholds) live in strategy.ts as
// DEFAULT_PARAMS and were picked on the kit's dev window for a balance of
// trade frequency and drawdown, not fitted to any single move.

import { runBars } from './vendor/makefun-bars.ts';
import { DEFAULT_PARAMS, TrendState } from './strategy.ts';

const SYMBOL = 'SOL';
const MAX_SLIPPAGE_BPS = 100;

const trend = new TrendState(DEFAULT_PARAMS);

await runBars({
  onBatch(state) {
    // Warm-up batches build history only: any order decided on one is
    // rejected, so never trade while warming up.
    if (state.warmingUp) return [];

    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];

    // Feed this bar's close into the indicators, then decide on it alone.
    trend.addBar({
      o: Number(bar.o),
      h: Number(bar.h),
      l: Number(bar.l),
      c: Number(bar.c),
    });

    const held = state.positions.get(SYMBOL);
    const inPosition = held !== undefined && held.qty > 0n;
    const signal = trend.decide(inPosition);

    if (signal === 'buy' && !inPosition) {
      const size = trend.sizeQuoteUnits(state.equity, state.cash);
      if (size < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    if (signal === 'sell' && inPosition) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    return [];
  },
});
