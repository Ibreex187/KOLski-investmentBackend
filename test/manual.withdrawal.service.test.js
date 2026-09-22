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
const manualWithdrawalService = require('../services/manual.withdrawal.service');

function makeTx(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439023',
    userId: '507f1f77bcf86cd799439011',
    type: 'withdrawal',
    symbol: 'CASH',
    total: 120,
    status: 'pending',
    reference_id: 'idem-w-1',
    note: '',
    metadata: {
      withdrawal_flow: 'manual_bank_transfer',
      destination_reference: 'BANK-DEST-1234',
      submitted_at: new Date('2026-04-20T10:00:00.000Z'),
    },
    createdAt: new Date('2026-04-20T10:00:00.000Z'),
    updatedAt: new Date('2026-04-20T10:00:00.000Z'),
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('manual withdrawal service', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns existing transaction when idempotency key already exists', async () => {
    const existingTx = makeTx({ status: 'pending', reference_id: 'idem-w-dup' });

    TransactionModel.findOne.mockResolvedValue(existingTx);

    const result = await manualWithdrawalService.createManualWithdrawalRequest('user-1', {
      amount: 80,
      currency: 'USD',
      destination_reference: 'BANK-DEST-7777',
      idempotency_key: 'idem-w-dup',
    });

    expect(TransactionModel.create).not.toHaveBeenCalled();
    expect(result.status).toBe('pending');
    expect(result.idempotent).toBe(true);
  });
});
