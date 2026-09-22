jest.mock('../models/portfolio.model', () => ({
  findOne: jest.fn(),
}));

jest.mock('../models/transaction.model', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
  create: jest.fn(),
}));

const PortfolioModel = require('../models/portfolio.model');
const TransactionModel = require('../models/transaction.model');
const manualDepositService = require('../services/manual.deposit.service');

function makeTx(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439013',
    userId: '507f1f77bcf86cd799439011',
    type: 'deposit',
    symbol: 'CASH',
    total: 150,
    status: 'pending',
    reference_id: 'idem-1',
    note: '',
    metadata: {
      deposit_flow: 'manual_bank_transfer',
      transfer_reference: 'WIRE-1234',
      submitted_at: new Date('2026-04-19T10:00:00.000Z'),
    },
    createdAt: new Date('2026-04-19T10:00:00.000Z'),
    updatedAt: new Date('2026-04-19T10:00:00.000Z'),
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('manual deposit service', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns existing transaction when idempotency key already exists', async () => {
    const existingTx = makeTx({ status: 'pending', reference_id: 'idem-dup' });

    TransactionModel.findOne.mockResolvedValue(existingTx);

    const result = await manualDepositService.createManualDepositRequest('user-1', {
      amount: 100,
      currency: 'USD',
      transfer_reference: 'WIRE-7777',
      idempotency_key: 'idem-dup',
    });

    expect(TransactionModel.create).not.toHaveBeenCalled();
    expect(result.status).toBe('pending');
    expect(result.idempotent).toBe(true);
  });
});
