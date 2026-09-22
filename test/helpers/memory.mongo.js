// Starts a real, in-memory mongod for tests that need genuine database semantics
// (atomic updates, unique indexes, transactions) which mocks cannot prove.
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const PortfolioModel = require('../../models/portfolio.model');
const HoldingModel = require('../../models/holding.model');
const TransactionModel = require('../../models/transaction.model');
const NotificationModel = require('../../models/notification.model');
const PriceAlertModel = require('../../models/price.alert.model');

let server = null;

// replSet: true starts a single-node replica set, which enables multi-document
// transactions. The default standalone server does not, which is exactly the
// situation the service's fallback path exists for.
//
// The replica set is initiated with the project's own mongodb driver (via mongoose)
// instead of MongoMemoryReplSet, whose bundled driver can be too old to handshake with
// the mongod version it downloads.
async function startMemoryMongo({ replSet = false } = {}) {
  if (replSet) {
    server = await MongoMemoryServer.create({ instance: { replSet: 'rs0' } });
    const host = `127.0.0.1:${server.instanceInfo.port}`;

    await mongoose.connect(`mongodb://${host}/`, { directConnection: true });
    await mongoose.connection.db.admin().command({
      replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host }] },
    });
    await waitForPrimary();
    await mongoose.disconnect();
    await mongoose.connect(`mongodb://${host}/?replicaSet=rs0`, { dbName: 'trade-tests' });
  } else {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri(), { dbName: 'trade-tests' });
  }

  // Build indexes up front so unique-index behaviour is present from the first test.
  await Promise.all([
    PortfolioModel.init(),
    HoldingModel.init(),
    TransactionModel.init(),
    NotificationModel.init(),
    PriceAlertModel.init(),
  ]);
}

async function waitForPrimary(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (hello.isWritablePrimary) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('In-memory replica set did not elect a primary in time');
}

async function stopMemoryMongo() {
  await mongoose.disconnect();
  if (server) {
    await server.stop();
    server = null;
  }
}

async function resetCollections() {
  await Promise.all([
    PortfolioModel.deleteMany({}),
    HoldingModel.deleteMany({}),
    TransactionModel.deleteMany({}),
    NotificationModel.deleteMany({}),
    PriceAlertModel.deleteMany({}),
  ]);
}

async function createPortfolio({ cash = 0, userId = new mongoose.Types.ObjectId() } = {}) {
  const portfolio = await PortfolioModel.create({ user_id: userId, cash_balance: cash });
  return { userId, portfolio };
}

module.exports = {
  startMemoryMongo,
  stopMemoryMongo,
  resetCollections,
  createPortfolio,
};
