/**
 * The ONE synthetic-data backtest implementation shared by the quant pack
 * builder (renders the appendix table) and the verifier (re-computes and
 * asserts the shipped numbers match — a mismatch exits non-zero).
 *
 * Semantics (deliberately isomorphic to the Python shown in the appendix):
 *   signal_t   = SMA20(t) > SMA60(t)                 (computed at close of t)
 *   exec_t     = signal_{t-1}                        (shift(1): act NEXT day)
 *   turnover_t = |exec_t - exec_{t-1}|
 *   netRet_t   = ret_t * exec_t - FEE * turnover_t   (linear fees, net basis)
 *   equity_t   = prod(1 + netRet)
 *
 * Every displayed metric is derived from the same netRet series — the prior
 * version mixed a same-day signal into same-day returns and charged fees to
 * equity while reporting gross daily returns. Fixed here; see START_LEARNING
 * review E13 for the history.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SYNTHETIC_PARAMS = {
  seed: 42,
  nDays: 500,
  s0: 100,
  mu: 0.08,
  sigma: 0.2,
  fee: 0.0005, // 0.05% per side, linear
  fastWindow: 20,
  slowWindow: 60,
};

export function computeSyntheticBacktest(params = {}) {
  const { seed, nDays, s0, mu, sigma, fee, fastWindow, slowWindow } = {
    ...SYNTHETIC_PARAMS,
    ...params,
  };
  const rand = mulberry32(seed);
  const gaussian = () => {
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const dt = 1 / 252;
  const prices = [s0];
  for (let i = 1; i < nDays; i++) {
    prices.push(
      prices[i - 1] *
        Math.exp((mu - (sigma * sigma) / 2) * dt + sigma * Math.sqrt(dt) * gaussian()),
    );
  }
  const sma = (window, idx) => {
    if (idx + 1 < window) return null; // window not filled yet
    let sum = 0;
    for (let j = idx - window + 1; j <= idx; j++) sum += prices[j];
    return sum / window;
  };

  const stratNet = [];
  const bhNet = [];
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let trades = 0;
  let bhEquity = 1;
  let bhPeak = 1;
  let bhMaxDd = 0;
  let prevExec = 0; // shift(1).fillna(0)

  for (let i = 1; i < nDays; i++) {
    const ret = prices[i] / prices[i - 1] - 1;
    // Execution signal uses YESTERDAY's moving averages: no lookahead.
    const fast = sma(fastWindow, i - 1);
    const slow = sma(slowWindow, i - 1);
    const exec = fast !== null && slow !== null && fast > slow ? 1 : 0;
    const turnover = Math.abs(exec - prevExec);
    trades += turnover > 0 ? 1 : 0;
    const netRet = ret * exec - fee * turnover;
    stratNet.push(netRet);
    equity *= 1 + netRet;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
    bhNet.push(ret);
    bhEquity *= 1 + ret;
    bhPeak = Math.max(bhPeak, bhEquity);
    bhMaxDd = Math.max(bhMaxDd, 1 - bhEquity / bhPeak);
    prevExec = exec;
  }

  const annualize = (rs) => {
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1));
    return {
      mean: mean * 252,
      sd: sd * Math.sqrt(252),
      sharpe: sd > 0 ? (mean * 252) / (sd * Math.sqrt(252)) : 0,
    };
  };
  const strat = annualize(stratNet);
  const bh = annualize(bhNet);
  return {
    days: nDays,
    fee,
    trades,
    strategyTotal: equity,
    strategyAnnRet: strat.mean,
    strategyAnnVol: strat.sd,
    strategySharpe: strat.sharpe,
    strategyMaxDd: maxDd,
    bhTotal: bhEquity,
    bhAnnRet: bh.mean,
    bhAnnVol: bh.sd,
    bhSharpe: bh.sharpe,
    bhMaxDd: bhMaxDd,
  };
}
