/**
 * Signed completions on NEAR AI Cloud.
 * We keep the exact request/response bytes so sha256 matches what the model TEE signed.
 * Non-streaming + x-no-aliasing → signature_kind "provider_tee" (signed inside the model TEE).
 */
import type { ChatSignature } from "@bazaar/verify";

export const NEARAI_API = "https://cloud-api.near.ai";

export interface SignedCall {
  requestBody: string;
  responseBody: string;
  chatId: string;
  /** Null until fetched; a bundle with a null signature fails verification. */
  signature: ChatSignature | null;
}

export interface ChatRequest {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  max_tokens: number;
  temperature: number;
  seed?: number;
  response_format?: { type: "json_object" };
  chat_template_kwargs: { enable_thinking: false };
}

export class NearAiClient {
  constructor(private apiKey: string) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.apiKey}`, "Accept-Encoding": "identity", ...extra };
  }

  async complete(req: ChatRequest): Promise<{ call: SignedCall; content: string }> {
    const requestBody = JSON.stringify(req);
    const res = await fetch(`${NEARAI_API}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", "x-no-aliasing": "true" }),
      body: requestBody,
    });
    const responseBody = await res.text();
    if (!res.ok) throw new Error(`completion HTTP ${res.status}: ${responseBody.slice(0, 200)}`);
    const json = JSON.parse(responseBody);
    return {
      call: { requestBody, responseBody, chatId: json.id, signature: null },
      content: json.choices?.[0]?.message?.content ?? "",
    };
  }

  /** Signatures can lag or live on another TEE node briefly — retry. */
  async signature(chatId: string, model: string, attempts = 6): Promise<ChatSignature | null> {
    const url = `${NEARAI_API}/v1/signature/${chatId}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
    for (let i = 0; i < attempts; i++) {
      const res = await fetch(url, { headers: this.headers({ Accept: "application/json" }) });
      if (res.ok) {
        const j = await res.json();
        if (j.signature && !j.error_code) return j as ChatSignature;
      }
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
    return null;
  }
}
