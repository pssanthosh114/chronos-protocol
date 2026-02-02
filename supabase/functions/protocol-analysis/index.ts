// Supabase Edge Function: Protocol Analysis (Chronos Brain)
// Converts chronos-brain logic to Deno; returns AI clinical directive as JSON.

import "@supabase/functions-js/edge-runtime.d.ts";

declare const Deno: {
  serve: (handler: (req: Request) => Promise<Response> | Response) => unknown;
  env: { get(key: string): string | undefined };
};
// Resolved at runtime via deno.json import map (openai -> npm:openai@4.52.0)
// @ts-expect-error - IDE may not resolve Deno/npm specifiers without Deno extension
import { OpenAI } from "openai";

const ASSISTANT_ID = "asst_idrCrYpx7nA42iEL0HJNRQNQ";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function formatUserDataPayload(userData: unknown): string {
  if (!userData || typeof userData !== "object") {
    return "No data provided.";
  }
  const u = userData as Record<string, unknown>;
  const biometrics = u.biometrics;
  const labs = u.clinical_markers ?? u.clinical_audit ?? u.labs;
  const calendar = u.calendar_events ?? u.calendar;
  const sections: string[] = [];
  if (biometrics && typeof biometrics === "object") {
    sections.push("## Biometrics\n" + JSON.stringify(biometrics, null, 2));
  }
  if (labs && typeof labs === "object") {
    sections.push("## Labs / Clinical\n" + JSON.stringify(labs, null, 2));
  }
  if (Array.isArray(calendar)) {
    sections.push("## Calendar\n" + JSON.stringify(calendar, null, 2));
  } else if (calendar && typeof calendar === "object") {
    sections.push("## Calendar\n" + JSON.stringify(calendar, null, 2));
  }
  return sections.length ? sections.join("\n\n") : JSON.stringify(userData, null, 2);
}

async function waitForRun(
  openai: OpenAI,
  threadId: string,
  runId: string,
  maxWaitMs = 120000,
  pollIntervalMs = 1500
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const run = await openai.beta.threads.runs.retrieve(threadId, runId);
    if (run.status === "completed") return;
    if (run.status === "failed" || run.status === "cancelled" || run.status === "expired") {
      throw new Error(`Run ended with status: ${run.status}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error("Run did not complete within max wait time");
}

async function getLatestAssistantMessage(
  openai: OpenAI,
  threadId: string
): Promise<string> {
  const list = await openai.beta.threads.messages.list(threadId, {
    order: "desc",
    limit: 10,
  });
  const assistantMessage = list.data.find((m) => m.role === "assistant");
  if (
    !assistantMessage?.content?.length ||
    !assistantMessage.content.some((p) => p.type === "text")
  ) {
    throw new Error("No assistant message in thread");
  }
  const part = assistantMessage.content.find((p) => p.type === "text");
  const text = part && "text" in part ? part.text?.value : null;
  if (typeof text !== "string") throw new Error("No text content in assistant message");
  return text;
}

function parseAssistantJson(text: string): Record<string, unknown> {
  const trimmed = (text ?? "").trim();
  let raw = trimmed;
  const codeMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) raw = codeMatch[1].trim();
  return JSON.parse(raw) as Record<string, unknown>;
}

function normalizeForDashboard(parsed: Record<string, unknown>) {
  return {
    directive:
      (parsed.directive ?? parsed.recommendation ?? parsed.summary ?? "") as string,
    insight: (parsed.insight ?? parsed.analysis ?? "") as string,
    statusText:
      (parsed.status ?? parsed.statusText ?? "Optimal Baseline") as string,
    protocolLogMessage:
      (parsed.protocolLogMessage ?? parsed.directive ?? parsed.summary ?? "") as string,
  };
}

async function runProtocolAnalysis(userData: unknown) {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    return {
      protocolCached: true,
      message: "Protocol Cached",
      status: "cached",
      directive: "Using last known protocol. OPENAI_API_KEY not set.",
      insight: "",
      statusText: "Protocol Cached",
      protocolLogMessage: "",
      error: "OPENAI_API_KEY not set",
    };
  }

  try {
    const openai = new OpenAI({ apiKey });
    const payload = formatUserDataPayload(userData);

    const thread = await openai.beta.threads.create();
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: payload,
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID,
    });

    await waitForRun(openai, thread.id, run.id);
    const text = await getLatestAssistantMessage(openai, thread.id);
    const parsed = parseAssistantJson(text);
    const forDashboard = normalizeForDashboard(parsed);

    return {
      protocolCached: false,
      status: "completed",
      data: parsed,
      rawText: text,
      directive: forDashboard.directive,
      insight: forDashboard.insight,
      statusText: forDashboard.statusText,
      protocolLogMessage: forDashboard.protocolLogMessage,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Protocol analysis error:", message);
    return {
      protocolCached: true,
      message: "Protocol Cached",
      status: "cached",
      directive: "Using last known protocol. AI temporarily unavailable.",
      insight: "",
      statusText: "Protocol Cached",
      protocolLogMessage: "",
      error: message,
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  let userData: unknown;
  try {
    userData = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const result = await runProtocolAnalysis(userData);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
