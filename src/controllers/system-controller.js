'use strict';

const logsRepository = require('../database/repositories/logs-repository');
const emergencyStopRepository = require('../database/repositories/emergency-stop-repository');
const config = require('../../config/config');
const exchangeClientFactory = require('../services/exchanges/exchange-client-factory');
const { resolveRealCredentials } = require('../services/exchanges/real-credentials-resolver');
const autoTrader = require('../services/scheduler/auto-trader');
const positionRiskWatcher = require('../services/scheduler/position-risk-watcher');
const { sendSuccess } = require('../utils/http-response');

async function getLogs(req, res) {
  const { level, mode } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  sendSuccess(res, logsRepository.listLogs({ level, mode, limit, offset }));
}

async function getSystemStatus(req, res) {
  const demoSandbox = config.demoExchange.name
    ? safeProbe(config.demoExchange.name)
    : { hasSandbox: false, note: 'DEMO_EXCHANGE_NAME not configured' };

  const realCredentials = resolveRealCredentials(req.user.id);

  sendSuccess(res, {
    nodeEnv: config.nodeEnv,
    tradingMode: config.tradingMode,
    liveTradingEnabled: config.enableLiveTrading,
    demoExchangeConfigured: !!config.demoExchange.name,
    realExchangeConfigured: !!(realCredentials.name && realCredentials.apiKey && realCredentials.apiSecret),
    realExchangeCredentialsSource: realCredentials.name ? realCredentials.source : 'none',
    demoSandbox,
    emergencyStop: {
      global: emergencyStopRepository.getGlobalState(),
      demo: emergencyStopRepository.getUserState('demo', req.user.id),
      real: emergencyStopRepository.getUserState('real', req.user.id),
    },
    autoTrader: autoTrader.getStatus(),
    positionRiskWatcher: positionRiskWatcher.getStatus(),
  });
}

function safeProbe(exchangeName) {
  try {
    return exchangeClientFactory.probeSandboxSupport(exchangeName);
  } catch (err) {
    return { hasSandbox: false, error: err.message };
  }
}

module.exports = { getLogs, getSystemStatus };
