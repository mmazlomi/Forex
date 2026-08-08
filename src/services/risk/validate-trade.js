'use strict';

const { computeMaxRiskAmount, computePositionSize, computeRiskRewardRatio } = require('./position-sizing');

function reject(reasonCode, message, extra = {}) {
  return { accepted: false, reasonCode, message, ...extra };
}

/**
 * Ten-step pre-trade validation pipeline (docs/phase2-requirements-architecture.md §1.5).
 * Pure function — no DB/network access — so it's fully unit-testable and reusable by both
 * demo-orders.js and real-orders.js without either owning the risk logic.
 *
 * `entryPrice` is deliberately just "the price to use for risk/sizing math," with no awareness
 * of order type — the caller decides what that means. For a Market order it's the live snapshot
 * price (as always). For a Limit order it must be the order's own limitPrice — a limit far from
 * the current price has to be sized/risk-evaluated against where it will actually fill, not
 * today's price. For Stop-Market it's the triggerPrice (the approximate fill point once
 * triggered, ignoring slippage); for Stop-Limit it's limitPrice (the more precise of the two).
 * Keeping that selection in the caller rather than teaching this function about order types at
 * all keeps its contract exactly what it's always been: a plain number in, a decision out.
 *
 * `leverage` (optional, default 1) only affects step 9 (sufficient balance): a leveraged order
 * only needs its margin (orderValue / leverage), not the full notional, on hand. Every other
 * check — max order value, exposure — stays notional-based regardless of leverage, since those
 * cap market exposure, not capital committed. Spot callers never pass this, so their behavior is
 * unchanged (orderValue / 1 === orderValue).
 */
function validateTrade({
  mode,
  emergencyStopActive,
  liveTradingEnabled,
  dataQuality,
  dataAgeMs,
  maxDataAgeMs,
  entryPrice,
  stopLossPrice,
  takeProfitPrice,
  riskSettings,
  balance,
  openPositionsCount,
  dailyLossSoFar,
  currentExposureValue,
  minOrderValue = 0,
  isDuplicate = false,
  qtyOverride,
  leverage = 1,
  marginUsed = currentExposureValue,
}) {
  // 1. Emergency stop
  if (emergencyStopActive) {
    return reject('EMERGENCY_STOP_ACTIVE', 'Trading is halted by an active emergency stop.');
  }

  // 2. Live trading gate (real mode only)
  if (mode === 'real' && !liveTradingEnabled) {
    return reject('LIVE_TRADING_DISABLED', 'ENABLE_LIVE_TRADING is not set to true; real orders are blocked.');
  }

  // 3. Data quality / freshness
  if (dataQuality === 'insufficient') {
    return reject('INSUFFICIENT_DATA', 'Market data quality is insufficient to size or validate this trade.');
  }
  if (typeof dataAgeMs === 'number' && typeof maxDataAgeMs === 'number' && dataAgeMs > maxDataAgeMs) {
    return reject('STALE_DATA', `Market data is ${dataAgeMs}ms old, exceeding the ${maxDataAgeMs}ms freshness threshold.`);
  }

  // Position sizing (needed for several subsequent checks). By default this is fully automatic
  // — sized so the trade risks exactly maxRiskAmount if the stop is hit — but a caller may
  // supply qtyOverride to trade a specific amount instead (e.g. to stay under maxOrderValue on a
  // tight stop that would otherwise auto-size into a much larger order). An override still has
  // to respect maxRiskAmount, the same ceiling automatic sizing is built to never exceed — it
  // lets a trader choose to risk *less* than their configured max, never more.
  const maxRiskAmount = computeMaxRiskAmount(balance, riskSettings.maxRiskPerTradePercent);
  const riskPerUnit = Math.abs(entryPrice - stopLossPrice);
  let positionSize;
  if (qtyOverride !== undefined && qtyOverride !== null) {
    if (!Number.isFinite(qtyOverride) || qtyOverride <= 0) {
      return reject('INVALID_QTY', 'Order amount must be a positive number.');
    }
    if (riskPerUnit === 0) {
      return reject('INVALID_STOP_LOSS', 'Stop-loss must differ from entry price.');
    }
    const impliedRiskAmount = qtyOverride * riskPerUnit;
    if (impliedRiskAmount > maxRiskAmount) {
      const maxQty = maxRiskAmount / riskPerUnit;
      return reject(
        'RISK_AMOUNT_TOO_LARGE',
        `Amount ${qtyOverride} would risk ${impliedRiskAmount.toFixed(2)} if the stop is hit, exceeding the max risk per trade of ${maxRiskAmount.toFixed(2)} (${riskSettings.maxRiskPerTradePercent}% of balance). Maximum amount at this stop distance: ${maxQty.toFixed(8)}.`,
        { maxQty }
      );
    }
    positionSize = qtyOverride;
  } else {
    positionSize = computePositionSize(maxRiskAmount, entryPrice, stopLossPrice);
    if (positionSize === null || !Number.isFinite(positionSize) || positionSize <= 0) {
      return reject('INVALID_STOP_LOSS', 'Stop-loss must differ from entry price to compute a position size.');
    }
  }
  const riskRewardRatio = computeRiskRewardRatio(entryPrice, stopLossPrice, takeProfitPrice);
  let orderValue = positionSize * entryPrice;
  let riskAmount = positionSize * riskPerUnit; // actual risk incurred — may be less than maxRiskAmount when qtyOverride is smaller than the auto-sized max, or after the order-value clamp in step 5 below

  // 4. Risk-to-reward — a tiny epsilon absorbs floating-point noise from stop/take-profit prices
  // that are themselves the result of earlier float arithmetic (e.g. an ATR-based offset): a
  // "true" 1.5 ratio can come out as 1.4999999999999791 with no meaningful difference in the
  // actual trade, and shouldn't be rejected as if it were a genuinely worse risk/reward.
  const RISK_REWARD_EPSILON = 1e-9;
  if (riskRewardRatio === null || riskRewardRatio < riskSettings.minRiskRewardRatio - RISK_REWARD_EPSILON) {
    return reject(
      'RISK_REWARD_TOO_LOW',
      `Risk-to-reward ratio ${riskRewardRatio ?? 'N/A'} is below the required minimum of ${riskSettings.minRiskRewardRatio}.`,
      { riskRewardRatio }
    );
  }

  // 5. Order size bounds. An automatically-sized position (no qtyOverride) is sized to risk
  // exactly maxRiskAmount if the stop is hit — on a very tight stop relative to price, that can
  // require far more units than maxOrderValue allows (e.g. a stop 0.4% from entry on a $1.40
  // coin needs ~18,755 units to risk $100, a ~$26,000 order against a $1,000 cap). Rather than
  // rejecting a trade the risk-per-trade % would otherwise happily allow, shrink the auto-sized
  // position down to fit maxOrderValue instead — it still executes, just risking LESS than the
  // configured max (never more), which is strictly safer than rejecting outright. An explicit
  // qtyOverride is the user's stated instruction to trade that exact amount; it is never
  // silently reduced — still rejected as before so nobody gets a smaller fill than they asked for.
  if (orderValue > riskSettings.maxOrderValue) {
    if (qtyOverride === undefined || qtyOverride === null) {
      positionSize = riskSettings.maxOrderValue / entryPrice;
      orderValue = positionSize * entryPrice;
      // fp-safety: positionSize * entryPrice can round a hair back above maxOrderValue after the
      // division above — shave it back down so the orderValue <= maxOrderValue invariant always
      // holds for callers, at a precision no human or exchange lot-size would ever notice.
      if (orderValue > riskSettings.maxOrderValue) {
        positionSize *= riskSettings.maxOrderValue / orderValue;
        orderValue = positionSize * entryPrice;
      }
      riskAmount = positionSize * riskPerUnit;
    } else {
      return reject('ORDER_VALUE_TOO_LARGE', `Order value ${orderValue.toFixed(2)} exceeds the maximum of ${riskSettings.maxOrderValue}.`, { orderValue, positionSize });
    }
  }
  if (minOrderValue > 0 && orderValue < minOrderValue) {
    return reject('ORDER_VALUE_TOO_SMALL', `Order value ${orderValue.toFixed(2)} is below the exchange minimum of ${minOrderValue}.`, { orderValue, positionSize });
  }

  // 6. Max open positions
  if (openPositionsCount >= riskSettings.maxOpenPositions) {
    return reject('MAX_OPEN_POSITIONS_REACHED', `Already at the maximum of ${riskSettings.maxOpenPositions} open positions.`);
  }

  // 7. Max daily loss
  const maxDailyLossAmount = balance * (riskSettings.maxDailyLossPercent / 100);
  if (dailyLossSoFar >= maxDailyLossAmount) {
    return reject('MAX_DAILY_LOSS_REACHED', `Daily loss of ${dailyLossSoFar.toFixed(2)} has reached the limit of ${maxDailyLossAmount.toFixed(2)}.`);
  }

  // 8. Portfolio exposure
  const exposureAfter = currentExposureValue + orderValue;
  const exposurePercentAfter = balance > 0 ? (exposureAfter / balance) * 100 : Infinity;
  if (exposurePercentAfter > riskSettings.maxPortfolioExposurePercent) {
    return reject(
      'MAX_EXPOSURE_EXCEEDED',
      `Portfolio exposure would reach ${exposurePercentAfter.toFixed(1)}%, exceeding the limit of ${riskSettings.maxPortfolioExposurePercent}%.`
    );
  }

  // 9. Sufficient balance — a leveraged order only needs its margin (orderValue / leverage) on
  // hand, not the full notional, and what's already "used" by existing open positions is their
  // committed margin too, not their notional (marginUsed defaults to currentExposureValue, which
  // for spot — leverage always 1 — is exactly the same number, so this is a no-op for every
  // existing caller). Step 8 above deliberately keeps using notional (currentExposureValue) for
  // the exposure-percent check — total notional relative to capital is the correct, standard
  // definition of leveraged exposure — only this balance check needs the margin-based number.
  const availableBalance = balance - marginUsed;
  const requiredMargin = orderValue / leverage;
  if (requiredMargin > availableBalance) {
    return reject(
      'INSUFFICIENT_BALANCE',
      leverage > 1
        ? `Required margin ${requiredMargin.toFixed(2)} (order value ${orderValue.toFixed(2)} at ${leverage}x leverage) exceeds available balance ${availableBalance.toFixed(2)}.`
        : `Order value ${orderValue.toFixed(2)} exceeds available balance ${availableBalance.toFixed(2)}.`
    );
  }

  // 10. Duplicate order
  if (isDuplicate) {
    return reject('DUPLICATE_ORDER', 'An equivalent order was already submitted recently (idempotency check).');
  }

  return {
    accepted: true,
    reasonCode: 'ACCEPTED',
    message: 'Trade passed all risk checks.',
    positionSize,
    riskAmount,
    orderValue,
    requiredMargin,
    riskRewardRatio,
  };
}

module.exports = { validateTrade };
