import { expect, test } from 'bun:test';
import { copilotAccountLabel, copilotAccountUsage } from '../../src/lib/copilot-account';
test('account labels distinguish finite allowances, unknown caps and unavailable data', () => {
 const account = copilotAccountUsage({ login: 'tester', used: 12.5, max: 100, unlimited: false });
 expect(copilotAccountLabel(account)).toBe('GitHub @tester · 12.5 / 100 credits used');
 expect(copilotAccountLabel(account && { ...account, max: null })).toContain('no reported cap');
 for (const used of [undefined, null, -1, '10', NaN]) expect(copilotAccountUsage({ used })).toBeNull();
 expect(copilotAccountUsage({ used: 0, max: 0 })?.max).toBe(0);
 expect(copilotAccountLabel(null)).toBe('Account allowance unavailable');
});
