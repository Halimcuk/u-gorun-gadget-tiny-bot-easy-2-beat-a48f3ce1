// Strategy for "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana".
//
// Trend following with a filter, on hourly SOL bars only. One idea, three parts:
//   1. EMA crossover: a fast EMA crossing above a slow EMA opens a long; a cross
//      below closes it. The cross is the trend signal.
//   2. Volatility filter: an entry is only taken when the recent average true
//      range is a real move, not flat chop, and the position is sized by that
//      same volatility, so one bad bar cannot wipe the edge.
//   3. RSI confirmation: entries are skipped while the short window is already
//      overbought, and a long is exited early when momentum fades, even before
//      the EMA cross turns.
//
// No lookahead: every decision uses only bars up to the current one. No
// randomness, no clock, no network, no outside data: same bars in, same
// trades out.

export interface BarOHLC {
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface StrategyParams {
  /** Fast EMA length in bars. */
  fastLen: number;
  /** Slow EMA length in bars. */
  slowLen: number;
  /** Average-true-range length in bars. */
  atrLen: number;
  /** RSI length in bars (Wilder). */
  rsiLen: number;
  /** Minimum ATR as a fraction of price for an entry to count as a real move. */
  minAtrFrac: number;
  /** Skip entries while RSI is at or above this (overbought). */
  rsiOverbought: number;
  /** Exit a long early while RSI is at or below this (momentum fading). */
  rsiFade: number;
  /** Exit on a one-bar drop larger than this many ATRs (sharp reversal). */
  reversalAtrs: number;
  /** Risk budget: fraction of equity risked per one ATR of adverse move. */
  riskPerAtr: number;
  /** Hard cap on one position as a fraction of equity (harness max_weight_bps). */
  maxWeightFrac: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  fastLen: 3,
  slowLen: 8,
  atrLen: 14,
  rsiLen: 14,
  minAtrFrac: 0.0035,
  rsiOverbought: 68,
  rsiFade: 50,
  reversalAtrs: 1.0,
  riskPerAtr: 0.02,
  maxWeightFrac: 0.25,
};

export type Signal = 'buy' | 'sell' | 'hold';

/** Incremental indicator state, fed one closed bar at a time. */
export class TrendState {
  readonly bars: BarOHLC[] = [];
  #fastEma: number | null = null;
  #slowEma: number | null = null;
  #atr: number | null = null;
  #rsi: number | null = null;
  #avgGain = 0;
  #avgLoss = 0;
  #rsiSeeded = false;

  readonly params: StrategyParams;

  constructor(params: StrategyParams = DEFAULT_PARAMS) {
    this.params = params;
  }

  get count(): number {
    return this.bars.length;
  }

  /** Latest fast EMA, or null before enough bars. */
  get fastEma(): number | null {
    return this.#fastEma;
  }

  /** Latest slow EMA, or null before enough bars. */
  get slowEma(): number | null {
    return this.#slowEma;
  }

  /** Latest ATR in price units, or null before enough bars. */
  get atr(): number | null {
    return this.#atr;
  }

  /** Latest RSI (0-100), or null before enough bars. */
  get rsi(): number | null {
    return this.#rsi;
  }

  /** ATR as a fraction of the latest close, or null before enough bars. */
  atrFrac(): number | null {
    const last = this.bars[this.bars.length - 1];
    if (this.#atr === null || last === undefined) return null;
    return this.#atr / last.c;
  }

  /** Feed one closed bar; all indicators update from it and earlier bars only. */
  addBar(bar: BarOHLC): void {
    const prev = this.bars[this.bars.length - 1];
    this.bars.push(bar);

    // EMAs: seed with the first close, then smooth.
    const kFast = 2 / (this.params.fastLen + 1);
    const kSlow = 2 / (this.params.slowLen + 1);
    this.#fastEma = this.#fastEma === null ? bar.c : bar.c * kFast + this.#fastEma * (1 - kFast);
    this.#slowEma = this.#slowEma === null ? bar.c : bar.c * kSlow + this.#slowEma * (1 - kSlow);

    // True range against the previous close; ATR is its Wilder average.
    if (prev !== undefined) {
      const tr = Math.max(bar.h - bar.l, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c));
      this.#atr = this.#atr === null ? tr : (this.#atr * (this.params.atrLen - 1) + tr) / this.params.atrLen;
    }

    // RSI (Wilder): seed with the average gain/loss of the first rsiLen moves.
    if (prev !== undefined) {
      const change = bar.c - prev.c;
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);
      if (!this.#rsiSeeded) {
        // Accumulate the seed window; the RSI appears once it is full.
        this.#avgGain += gain;
        this.#avgLoss += loss;
        if (this.bars.length - 1 >= this.params.rsiLen) {
          this.#avgGain /= this.params.rsiLen;
          this.#avgLoss /= this.params.rsiLen;
          this.#rsiSeeded = true;
          this.#rsi = rsiFrom(this.#avgGain, this.#avgLoss);
        }
      } else {
        this.#avgGain = (this.#avgGain * (this.params.rsiLen - 1) + gain) / this.params.rsiLen;
        this.#avgLoss = (this.#avgLoss * (this.params.rsiLen - 1) + loss) / this.params.rsiLen;
        this.#rsi = rsiFrom(this.#avgGain, this.#avgLoss);
      }
    }
  }

  /**
   * Decide for the bar just added. `inPosition` says whether SOL is held.
   * Returns 'buy' to open, 'sell' to close, 'hold' otherwise. A buy is only
   * signalled on the bar the fast EMA crosses above the slow one; a sell on
   * the cross below, on RSI fading, or on a sharp one-bar reversal.
   */
  decide(inPosition: boolean): Signal {
    const p = this.params;
    const n = this.bars.length;
    if (n < 2 || this.#fastEma === null || this.#slowEma === null) return 'hold';
    const last = this.bars[n - 1]!;
    const prev = this.bars[n - 2]!;

    // Recompute the previous bar's EMAs from the stored closes so the cross
    // is judged on the two latest closes only (no lookahead, no stored state
    // beyond the bars themselves).
    const prevFast = emaBefore(this.bars, p.fastLen, n - 1);
    const prevSlow = emaBefore(this.bars, p.slowLen, n - 1);
    if (prevFast === null || prevSlow === null) return 'hold';
    const crossedUp = prevFast <= prevSlow && this.#fastEma > this.#slowEma;
    const crossedDown = prevFast >= prevSlow && this.#fastEma < this.#slowEma;

    if (inPosition) {
      if (crossedDown) return 'sell';
      // Momentum fading: RSI has rolled over even though the EMAs still point up.
      if (this.#rsi !== null && this.#rsi <= p.rsiFade) return 'sell';
      // Sharp reversal: one bar gave back more than reversalAtrs of range.
      const atrFrac = this.atrFrac();
      if (atrFrac !== null && (prev.c - last.c) / last.c > p.reversalAtrs * atrFrac) return 'sell';
      return 'hold';
    }

    if (!crossedUp) return 'hold';
    // Volatility filter: only take the cross when a real move is underway.
    const atrFrac = this.atrFrac();
    if (atrFrac === null || atrFrac < p.minAtrFrac) return 'hold';
    // RSI confirmation: never chase a top.
    if (this.#rsi !== null && this.#rsi >= p.rsiOverbought) return 'hold';
    return 'buy';
  }

  /**
   * Position size in quote units for a buy: risk `riskPerAtr` of equity per
   * one ATR of adverse move, capped at the weight cap and at the cash given.
   * Returns 0 when no size can be computed yet.
   */
  sizeQuoteUnits(equityQuoteUnits: bigint, cashQuoteUnits: bigint): bigint {
    const atrFrac = this.atrFrac();
    if (atrFrac === null || atrFrac <= 0) return 0n;
    const byRisk = (BigInt(Math.round(this.params.riskPerAtr * 1e6)) * equityQuoteUnits) / BigInt(Math.round(atrFrac * 1e6));
    const byWeight = (BigInt(Math.round(this.params.maxWeightFrac * 1e6)) * equityQuoteUnits) / 1_000_000n;
    let size = byRisk < byWeight ? byRisk : byWeight;
    if (size > cashQuoteUnits) size = cashQuoteUnits;
    return size > 0n ? size : 0n;
  }
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** The EMA of the closes before index `upto` (exclusive), seeded on the first close. */
function emaBefore(bars: BarOHLC[], len: number, upto: number): number | null {
  if (upto <= 0) return null;
  const k = 2 / (len + 1);
  let ema = bars[0]!.c;
  for (let i = 1; i < upto; i++) ema = bars[i]!.c * k + ema * (1 - k);
  return ema;
}
