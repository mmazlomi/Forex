'use strict';

const express = require('express');

const assetsRoutes = require('./assets-routes');
const watchlistRoutes = require('./watchlist-routes');
const exchangesRoutes = require('./exchanges-routes');
const marketRoutes = require('./market-routes');
const { signalsRouter, strategiesRouter } = require('./signals-routes');
const portfolioRoutes = require('./portfolio-routes');
const ordersRoutes = require('./orders-routes');
const futuresRoutes = require('./futures-routes');
const backtestRoutes = require('./backtest-routes');
const reversalRoutes = require('./reversal-routes');
const realCredentialsRoutes = require('./real-credentials-routes');
const { riskSettingsRouter, emergencyStopRouter } = require('./risk-routes');
const { logsRouter, systemStatusRouter } = require('./system-routes');

const router = express.Router();

router.use('/assets', assetsRoutes);
router.use('/watchlist', watchlistRoutes);
router.use('/exchanges', exchangesRoutes);
router.use('/', marketRoutes); // /market-data, /indicators, /fundamentals
router.use('/signals', signalsRouter);
router.use('/strategies', strategiesRouter);
router.use('/portfolio', portfolioRoutes);
router.use('/orders', ordersRoutes);
router.use('/futures', futuresRoutes);
router.use('/backtest', backtestRoutes);
router.use('/reversal', reversalRoutes);
router.use('/real-exchange-credentials', realCredentialsRoutes);
router.use('/risk-settings', riskSettingsRouter);
router.use('/emergency-stop', emergencyStopRouter);
router.use('/logs', logsRouter);
router.use('/system-status', systemStatusRouter);

module.exports = router;
