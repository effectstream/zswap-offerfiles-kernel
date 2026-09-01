// The kernel's HTTP surface, as the deploy scripts use it.
//
// `fetch` with a JSON envelope and a text fallback: the kernel answers some
// error paths with a plain string, and a driver that threw on the parse would
// report "unexpected end of JSON" instead of the actual refusal.

export interface KernelResponse<T> {
  status: number;
  body: T;
}

export interface OfferLeg {
  token: string;
  amount: string;
  type?: string;
}

export interface LiveOffer {
  offerId: string;
  blobChars?: number;
  blockHeight?: string;
  computed: {
    gives: OfferLeg[];
    wants: OfferLeg[];
    expiresAt?: string | null;
    inputNullifiers: string[];
    status: string;
  };
}

export class KernelApi {
  readonly base: string;

  constructor(base: string) {
    this.base = base.replace(/\/$/, "");
  }

  async get<T>(path: string): Promise<KernelResponse<T>> {
    return this.#request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body: unknown): Promise<KernelResponse<T>> {
    return this.#request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async #request<T>(path: string, init: RequestInit): Promise<KernelResponse<T>> {
    const res = await fetch(`${this.base}${path}`, init);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* the kernel answers some error paths with a bare string */
    }
    return { status: res.status, body: parsed as T };
  }

  /** Every live offer in the kernel book, following the keyset cursor. */
  async liveOffers(): Promise<LiveOffer[]> {
    const all: LiveOffer[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const suffix = cursor ? `&after_hash=${cursor}` : "";
      const { status, body } = await this.get<{ offers: LiveOffer[]; nextCursor: string | null }>(
        `/v1/offers?limit=100${suffix}`,
      );
      if (status !== 200) throw new Error(`GET /v1/offers → ${status}: ${JSON.stringify(body)}`);
      all.push(...(body.offers ?? []));
      cursor = body.nextCursor ?? null;
      if (!cursor) break;
    }
    return all;
  }

  /** Status of one offer by its bech32m blob. Returns the kernel's own offerId
   *  (sha256 of the raw offer bytes), so nothing has to re-derive the hash. */
  async offerStatusByBlob(blob: string): Promise<{ offerId?: string; status: string }> {
    const { status, body } = await this.post<{ offerId?: string; status: string }>(
      "/v1/offers/status",
      { offer: blob },
    );
    if (status !== 200) throw new Error(`POST /v1/offers/status → ${status}: ${JSON.stringify(body)}`);
    return body;
  }

  async offerStatusByHash(hash: string): Promise<{ offerId: string; status: string }> {
    const { status, body } = await this.get<{ offerId: string; status: string }>(
      `/v1/offers/${hash}/status`,
    );
    if (status !== 200) {
      throw new Error(`GET /v1/offers/${hash}/status → ${status}: ${JSON.stringify(body)}`);
    }
    return body;
  }
}
