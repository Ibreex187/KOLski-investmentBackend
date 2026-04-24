const { buildManualDepositRolloutStatus } = require('../utils/manual.deposit.rollout');
const { buildManualWithdrawalRolloutStatus } = require('../utils/manual.withdrawal.rollout');

describe('Rollout config defaults', () => {
  it('enables manual deposits by default when flag is not set', () => {
    const rollout = buildManualDepositRolloutStatus(new Date('2026-04-24T00:00:00.000Z'), {
      NODE_ENV: 'production',
    });

    expect(rollout.enabled).toBe(true);
    expect(rollout.reason).toBeNull();
  });

  it('enables manual withdrawals by default when flag is not set', () => {
    const rollout = buildManualWithdrawalRolloutStatus(new Date('2026-04-24T00:00:00.000Z'), {
      NODE_ENV: 'production',
    });

    expect(rollout.enabled).toBe(true);
    expect(rollout.reason).toBeNull();
  });

  it('disables manual deposits when MANUAL_DEPOSITS_ENABLED is false', () => {
    const rollout = buildManualDepositRolloutStatus(new Date('2026-04-24T00:00:00.000Z'), {
      NODE_ENV: 'production',
      MANUAL_DEPOSITS_ENABLED: 'false',
    });

    expect(rollout.enabled).toBe(false);
    expect(rollout.reason).toBe('MANUAL_DEPOSITS_ENABLED is disabled');
  });

  it('disables manual withdrawals when MANUAL_WITHDRAWALS_ENABLED is false', () => {
    const rollout = buildManualWithdrawalRolloutStatus(new Date('2026-04-24T00:00:00.000Z'), {
      NODE_ENV: 'production',
      MANUAL_WITHDRAWALS_ENABLED: 'false',
    });

    expect(rollout.enabled).toBe(false);
    expect(rollout.reason).toBe('MANUAL_WITHDRAWALS_ENABLED is disabled');
  });
});
