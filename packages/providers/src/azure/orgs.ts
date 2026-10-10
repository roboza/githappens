import type { HttpClient } from '../http';

const VSSPS = 'https://app.vssps.visualstudio.com';

/**
 * Azure DevOps organizations the signed-in user belongs to (spec 10 §6.1 "List orgs"):
 * `profiles/me` → member id → `accounts?memberId=`. `http` carries the Entra/PAT auth.
 */
export async function listAzureOrganizations(
  http: HttpClient,
): Promise<Array<{ id: string; name: string; url: string }>> {
  const me = await http.get<{ id: string }>(`${VSSPS}/_apis/profile/profiles/me`, {
    query: { 'api-version': '7.1' },
  });
  const r = await http.get<{ value: Array<{ accountId: string; accountName: string; accountUri?: string }> }>(
    `${VSSPS}/_apis/accounts`,
    { query: { memberId: me.id, 'api-version': '7.1' } },
  );
  return r.value.map((a) => ({
    id: a.accountId,
    name: a.accountName,
    url: `https://dev.azure.com/${encodeURIComponent(a.accountName)}`,
  }));
}
