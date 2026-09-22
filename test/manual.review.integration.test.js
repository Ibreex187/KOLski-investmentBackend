// Admin approval of manual deposits/withdrawals against a real (in-memory) MongoDB.
//
// Regressions covered:
//  - two admins approving the same request at once each applied the money (double credit
//    / double debit), because "read, check pending, save" is not atomic;
//  - approval saved a stale in-memory portfolio, erasing any balance change (e.g. a
//    trade) made between the read and the save.

const mongoose = require('mongoose');
const {
  startMemoryMongo,
  stopMemoryMongo,
  resetCollections,
  createPortfolio,
} = require('./helpers/memory.mongo');

const PortfolioModel = require('../models/portfolio.model');
const TransactionModel = require('../models/transaction.model');
const depositService = require('../services/manual.deposit.service');
const withdrawalService = require('../services/manual.withdrawal.service');
const portfolioService = require('../services/portfolio.service');

jest.setTimeout(120000);

let keyCounter = 0;
const key = () => `manual-key-${Date.now()}-${keyCounter++}`;

async function cashOf(userId) {
  return (await PortfolioModel.findOne({ user_id: userId })).cash_balance;
}

async function requestDeposit(userId, amount) {
  const { deposit_id } = await depositService.createManualDepositRequest(userId, {
    amount,
    transfer_reference: 'BANK-REF-1',
    idempotency_key: key(),
  });
  return deposit_id;
}

async function requestWithdrawal(userId, amount) {
  const { withdrawal_id } = await withdrawalService.createManualWithdrawalRequest(userId, {
    amount,
    destination_reference: 'DEST-1',
    idempotency_key: key(),
  });
  return withdrawal_id;
}

const approveDeposit = (depositId, admin = 'admin-1') =>
  depositService.approveManualDeposit({ depositId, adminUserId: admin, adminNote: 'ok', bankSettlementRef: 'BANK-OK' });
const approveWithdrawal = (withdrawalId, admin = 'admin-1') =>
  withdrawalService.approveManualWithdrawal({ withdrawalId, adminUserId: admin, adminNote: 'ok', bankSettlementRef: 'BANK-OUT' });

beforeAll(async () => {
  await startMemoryMongo();
});

afterAll(async () => {
  await stopMemoryMongo();
});

beforeEach(async () => {
  await resetCollections();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('manual deposit approval', () => {
  it('credits the balance and totals once and records the review', async () => {
    const { userId } = await createPortfolio({ cash: 100 });
    const depositId = await requestDeposit(userId, 250);

    const result = await approveDeposit(depositId);

    expect(result).toMatchObject({ status: 'completed', credited_amount: 250, new_cash_balance: 350 });
    const portfolio = await PortfolioModel.findOne({ user_id: userId });
    expect(portfolio.cash_balance).toBe(350);
    expect(portfolio.total_deposited).toBe(250);
    const tx = await TransactionModel.findById(depositId);
    expect(tx.status).toBe('completed');
    expect(tx.metadata).toMatchObject({ approved_by: 'admin-1', bank_settlement_ref: 'BANK-OK', deposit_flow: 'manual_bank_transfer' });
  });

  it('rejects a second approval with 409 and does not credit again', async () => {
    const { userId } = await createPortfolio({ cash: 0 });
    const depositId = await requestDeposit(userId, 100);
    await approveDeposit(depositId);

    await expect(approveDeposit(depositId, 'admin-2')).rejects.toMatchObject({ statusCode: 409 });

    expect(await cashOf(userId)).toBe(100);
  });

  it('credits exactly once when many admins approve the same deposit simultaneously', async () => {
    const { userId } = await createPortfolio({ cash: 0 });
    const depositId = await requestDeposit(userId, 100);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => approveDeposit(depositId, `admin-${i}`))
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    results.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason.statusCode).toBe(409));
    const portfolio = await PortfolioModel.findOne({ user_id: userId });
    expect(portfolio.cash_balance).toBe(100);
    expect(portfolio.total_deposited).toBe(100);
  });

  it('does not overwrite a balance change made while the approval is running (no lost update)', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });
    const depositId = await requestDeposit(userId, 50);

    // Buy while approvals are in flight; the old read-modify-save approval would write back
    // the stale balance and refund the purchase.
    const [, buy] = await Promise.all([
      approveDeposit(depositId),
      portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 3 }, { getQuote: async () => ({ price: 100 }) }),
    ]);

    expect(buy.success).toBe(true);
    expect(await cashOf(userId)).toBe(1000 + 50 - 300);
  });

  it('answers 404 for an unknown deposit and 404 (state restored) when the owner has no portfolio', async () => {
    await expect(approveDeposit(new mongoose.Types.ObjectId())).rejects.toMatchObject({ statusCode: 404 });

    const ownerless = new mongoose.Types.ObjectId();
    const tx = await TransactionModel.create({
      userId: ownerless,
      symbol: 'CASH',
      type: 'deposit',
      total: 40,
      status: 'pending',
      reference_id: key(),
      metadata: { deposit_flow: 'manual_bank_transfer' },
    });

    await expect(approveDeposit(tx._id)).rejects.toMatchObject({ statusCode: 404 });
    // The claim was rolled back, so the request is still reviewable.
    expect((await TransactionModel.findById(tx._id)).status).toBe('pending');
  });

  it('rejects a deposit without touching the balance, and it can no longer be approved', async () => {
    const { userId } = await createPortfolio({ cash: 10 });
    const depositId = await requestDeposit(userId, 90);

    const result = await depositService.rejectManualDeposit({
      depositId,
      adminUserId: 'admin-2',
      reason: 'Reference mismatch',
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'Reference mismatch' });
    expect(await cashOf(userId)).toBe(10);
    await expect(approveDeposit(depositId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lets exactly one of an approve and a reject racing on the same deposit win', async () => {
    const { userId } = await createPortfolio({ cash: 0 });
    const depositId = await requestDeposit(userId, 100);

    const [approve, reject] = await Promise.allSettled([
      approveDeposit(depositId),
      depositService.rejectManualDeposit({ depositId, adminUserId: 'admin-2', reason: 'no' }),
    ]);

    expect([approve.status, reject.status].sort()).toEqual(['fulfilled', 'rejected']);
    const tx = await TransactionModel.findById(depositId);
    expect(await cashOf(userId)).toBe(tx.status === 'completed' ? 100 : 0);
  });

  it('treats simultaneous requests with the same idempotency key as one request', async () => {
    const { userId } = await createPortfolio({ cash: 0 });
    const idempotencyKey = key();
    const submit = () =>
      depositService.createManualDepositRequest(userId, { amount: 75, transfer_reference: 'REF', idempotency_key: idempotencyKey });

    const results = await Promise.all(Array.from({ length: 6 }, submit));

    expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
    expect(new Set(results.map((r) => String(r.deposit_id))).size).toBe(1);
    expect(await TransactionModel.countDocuments({ userId, type: 'deposit' })).toBe(1);
  });
});

describe('manual withdrawal approval', () => {
  it('debits the balance and totals once', async () => {
    const { userId } = await createPortfolio({ cash: 500 });
    const withdrawalId = await requestWithdrawal(userId, 150);

    const result = await approveWithdrawal(withdrawalId);

    expect(result).toMatchObject({ status: 'completed', debited_amount: 150, new_cash_balance: 350 });
    const portfolio = await PortfolioModel.findOne({ user_id: userId });
    expect(portfolio.cash_balance).toBe(350);
    expect(portfolio.total_withdrawn).toBe(150);
  });

  it('debits exactly once when many admins approve the same withdrawal simultaneously', async () => {
    const { userId } = await createPortfolio({ cash: 500 });
    const withdrawalId = await requestWithdrawal(userId, 200);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => approveWithdrawal(withdrawalId, `admin-${i}`))
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    results.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason.statusCode).toBe(409));
    expect(await cashOf(userId)).toBe(300);
  });

  it('refuses approval, and leaves the request pending, when the cash was spent since the request', async () => {
    const { userId } = await createPortfolio({ cash: 500 });
    const withdrawalId = await requestWithdrawal(userId, 400);

    // The user spends most of the cash after asking to withdraw it.
    await portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 3 }, { getQuote: async () => ({ price: 100 }) });

    await expect(approveWithdrawal(withdrawalId)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Insufficient cash balance to approve withdrawal',
    });

    expect(await cashOf(userId)).toBe(200);
    expect((await TransactionModel.findById(withdrawalId)).status).toBe('pending');
    // ...and it is not wedged: once funds exist again it can be approved.
    await depositService.approveManualDeposit({
      depositId: await requestDeposit(userId, 300),
      adminUserId: 'admin-1',
    });
    await expect(approveWithdrawal(withdrawalId)).resolves.toMatchObject({ status: 'completed' });
    expect(await cashOf(userId)).toBe(100);
  });

  it('never lets approvals push the balance below zero when several requests compete for it', async () => {
    const { userId } = await createPortfolio({ cash: 500 });
    const ids = await Promise.all(Array.from({ length: 6 }, () => requestWithdrawal(userId, 200)));

    const results = await Promise.allSettled(ids.map((id) => approveWithdrawal(id)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2); // 2 x 200 <= 500 < 3 x 200
    expect(await cashOf(userId)).toBe(100);
    const stillPending = await TransactionModel.countDocuments({ userId, type: 'withdrawal', status: 'pending' });
    expect(stillPending).toBe(4);
  });

  it('does not overwrite a balance change made while the approval is running (no lost update)', async () => {
    const { userId } = await createPortfolio({ cash: 1000 });
    const withdrawalId = await requestWithdrawal(userId, 100);

    const [, buy] = await Promise.all([
      approveWithdrawal(withdrawalId),
      portfolioService.buyStock(userId, { symbol: 'AAPL', shares: 3 }, { getQuote: async () => ({ price: 100 }) }),
    ]);

    expect(buy.success).toBe(true);
    expect(await cashOf(userId)).toBe(1000 - 100 - 300);
  });

  it('rejects a withdrawal without touching the balance', async () => {
    const { userId } = await createPortfolio({ cash: 500 });
    const withdrawalId = await requestWithdrawal(userId, 100);

    await withdrawalService.rejectManualWithdrawal({ withdrawalId, adminUserId: 'admin-2', reason: 'Suspicious' });

    expect(await cashOf(userId)).toBe(500);
    await expect(approveWithdrawal(withdrawalId)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('rollback when the money step cannot be applied (no transaction support)', () => {
  it('puts a claimed deposit back to pending if the credit fails unexpectedly', async () => {
    const { userId } = await createPortfolio({ cash: 100 });
    const depositId = await requestDeposit(userId, 50);
    jest.spyOn(PortfolioModel, 'findOneAndUpdate').mockRejectedValueOnce(new Error('connection lost'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(approveDeposit(depositId)).rejects.toThrow('connection lost');

    expect((await TransactionModel.findById(depositId)).status).toBe('pending');
    expect(await cashOf(userId)).toBe(100);
    // The approval metadata was cleaned up too.
    expect((await TransactionModel.findById(depositId)).metadata.approved_by).toBeUndefined();
  });
});
