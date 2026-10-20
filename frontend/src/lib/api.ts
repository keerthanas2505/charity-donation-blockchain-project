import type {
  Campaign,
  CampaignListResponse,
  DonationsResponse,
  PlatformStats,
  VerifierDetail,
  VerifierLeaderboardEntry,
} from "../types/campaign";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, options);
  } catch {
    throw new Error(
      `Could not reach the Charity API at ${API_BASE_URL}. Ensure the backend API is running (npm start in /api).`,
    );
  }

  if (!response.ok) {
    let errMsg = `${response.status} ${response.statusText}`;
    try {
      const errJson = await response.json();
      if (errJson && errJson.error) errMsg = errJson.error;
    } catch {
      const text = await response.text().catch(() => "");
      if (text) errMsg = text;
    }
    throw new Error(errMsg);
  }

  return (await response.json()) as T;
}

export async function fetchCampaigns(
  params?: { sort?: string; limit?: number },
): Promise<CampaignListResponse> {
  const query = new URLSearchParams();
  if (params?.sort) query.set("sort", params.sort);
  if (params?.limit) query.set("limit", params.limit.toString());
  const qs = query.toString();
  return request<CampaignListResponse>(`/campaigns${qs ? `?${qs}` : ""}`);
}

export async function fetchCampaign(id: number): Promise<Campaign> {
  return request<Campaign>(`/campaigns/${id}`);
}

export async function fetchDonations(id: number, limit = 100): Promise<DonationsResponse> {
  return request<DonationsResponse>(`/campaigns/${id}/donations?limit=${limit}`);
}

export async function fetchStats(): Promise<PlatformStats> {
  return request<PlatformStats>("/stats");
}

export async function fetchLeaderboard(limit = 100): Promise<{ count: number; leaderboard: VerifierLeaderboardEntry[] }> {
  return request<{ count: number; leaderboard: VerifierLeaderboardEntry[] }>(
    `/verifiers/leaderboard?limit=${limit}`,
  );
}

export async function fetchVerifier(address: string): Promise<VerifierDetail> {
  return request<VerifierDetail>(`/verifiers/${address}`);
}

export async function uploadProofFile(file: File): Promise<{ cid: string; gatewayUrl: string }> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_BASE_URL}/proofs/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    let msg = `Upload failed with status ${res.status}`;
    try {
      const err = await res.json();
      if (err.error) msg = err.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }

  return (await res.json()) as { cid: string; gatewayUrl: string };
}
