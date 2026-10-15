export interface CopilotAccountUsage {
 login: string | null;
 used: number;
 max: number | null;
 unlimited: boolean;
 resetAt: string | null;
}

export function copilotAccountUsage(value: unknown): CopilotAccountUsage | null {
 if (!value || typeof value !== 'object') return null;
 const v = value as Record<string, unknown>;
 if (typeof v.used !== 'number' || !Number.isFinite(v.used) || v.used < 0) return null;
 return {
  login: typeof v.login === 'string' ? v.login : null,
  used: v.used,
  max: typeof v.max === 'number' && Number.isFinite(v.max) && v.max >= 0 ? v.max : null,
  unlimited: v.unlimited === true,
  resetAt: typeof v.resetAt === 'string' ? v.resetAt : null
 };
}

export function copilotAccountLabel(usage: CopilotAccountUsage | null | undefined): string {
 if (!usage) return 'Account allowance unavailable';
 const number = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
 return `GitHub${usage.login ? ` @${usage.login}` : ' CLI account'} · ${number(usage.used)}${usage.max === null ? '' : ` / ${number(usage.max)}`} credits used${usage.max === null ? ' · no reported cap' : ''}`;
}

export function copilotAccountTitle(usage: CopilotAccountUsage | null | undefined): string {
 return usage ? `Billing-cycle usage for the GitHub CLI account, which can differ from the Copilot CLI account. Cached for up to five minutes.${usage.resetAt ? ` Resets ${usage.resetAt}.` : ''}${usage.max === null ? ' GitHub supplies no finite personal allowance; organization budgets may still apply.' : ''}` : 'Account credits are unavailable. Sign in with gh on the backend host to enable the optional account reading.';
}
