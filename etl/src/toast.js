// Minimal Toast API client: machine-client auth, throttling, retries and
// pagination. Uses only read endpoints.
//
// Docs: https://doc.toasttab.com/doc/devguide/apiOverview.html

const DEFAULT_HOST = 'https://ws-api.toasttab.com';
const PAGE_SIZE = 100;

export class ToastClient {
  constructor({ clientId, clientSecret, host = DEFAULT_HOST, minIntervalMs = 250, log = console.error }) {
    if (!clientId || !clientSecret) throw new Error('TOAST_CLIENT_ID and TOAST_CLIENT_SECRET are required');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.host = host.replace(/\/$/, '');
    this.minIntervalMs = minIntervalMs; // ordersBulk allows 5 req/s per location
    this.log = log;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.lastRequestAt = 0;
  }

  async authenticate() {
    const res = await fetch(`${this.host}/authentication/v1/authentication/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        userAccessType: 'TOAST_MACHINE_CLIENT',
      }),
    });
    if (!res.ok) throw new Error(`Toast authentication failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    const token = body?.token;
    if (!token?.accessToken) throw new Error('Toast authentication returned no access token');
    this.token = token.accessToken;
    // Refresh a few minutes early.
    this.tokenExpiresAt = Date.now() + Math.max(60, (token.expiresIn ?? 3600) - 300) * 1000;
  }

  async throttle() {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async get(path, restaurantGuid, query = {}) {
    const url = new URL(this.host + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      if (!this.token || Date.now() >= this.tokenExpiresAt) await this.authenticate();
      await this.throttle();
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Toast-Restaurant-External-ID': restaurantGuid,
          Accept: 'application/json',
        },
      });
      if (res.ok) return res.json();

      if (res.status === 401 && attempt === 0) {
        this.token = null; // expired early; re-authenticate once
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        this.log(`Toast ${res.status} on ${url.pathname}; retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Toast GET ${url.pathname} failed: ${res.status} ${await res.text()}`);
    }
  }

  /** All orders for one business date (yyyymmdd), following pagination. */
  async ordersForBusinessDate(restaurantGuid, toastDate) {
    const all = [];
    for (let page = 1; ; page++) {
      const batch = await this.get('/orders/v2/ordersBulk', restaurantGuid, {
        businessDate: toastDate,
        pageSize: PAGE_SIZE,
        page,
      });
      if (!Array.isArray(batch)) break;
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return all;
  }

  async timeEntriesForBusinessDate(restaurantGuid, toastDate) {
    const entries = await this.get('/labor/v1/timeEntries', restaurantGuid, { businessDate: toastDate });
    return Array.isArray(entries) ? entries : [];
  }

  /**
   * Lookup tables that turn Toast GUIDs into readable names. Each call is
   * best-effort: a missing API scope just leaves GUIDs unnamed.
   */
  async lookups(restaurantGuid) {
    const safe = async (path) => {
      try {
        const r = await this.get(path, restaurantGuid);
        return Array.isArray(r) ? r : [];
      } catch (err) {
        this.log(`Warning: ${path} unavailable (${err.message}); names will fall back to defaults`);
        return [];
      }
    };
    const [diningOptions, revenueCenters, salesCategories, jobs, employees] = await Promise.all([
      safe('/config/v2/diningOptions'),
      safe('/config/v2/revenueCenters'),
      safe('/config/v2/salesCategories'),
      safe('/labor/v1/jobs'),
      safe('/labor/v1/employees'),
    ]);
    const byGuid = (rows, nameOf) => new Map(rows.filter((r) => r?.guid).map((r) => [r.guid, nameOf(r)]));
    return {
      diningOptions: byGuid(diningOptions, (r) => r.name),
      revenueCenters: byGuid(revenueCenters, (r) => r.name),
      salesCategories: byGuid(salesCategories, (r) => r.name),
      jobs: byGuid(jobs, (r) => r.title),
      employees: byGuid(employees, (r) =>
        [r.chosenName || r.firstName, r.lastName].filter(Boolean).join(' ').trim(),
      ),
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
