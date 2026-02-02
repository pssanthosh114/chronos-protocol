/**
 * Chronos Brain — OpenAI Assistant integration for executive protocol.
 * runProtocolAnalysis(userData) creates a thread, sends userData, polls for completion,
 * and returns JSON for the dashboard (AI Feed + Protocol Log). On API errors, returns
 * a "Protocol Cached" state so the dashboard can degrade gracefully.
 */

const OpenAI = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const assistantId = 'asst_idrCrYpx7nA42iEL0HJNRQNQ';

/**
 * Append this to your OpenAI Assistant Instructions (in Dashboard or via API).
 * At the end of every JSON response, the assistant must include these keys for system integrity.
 */
const ASSISTANT_INSTRUCTIONS_APPENDIX = `At the end of every JSON response, include a hidden key: 'brain_version': 'CHRONOS-v1-ALPHA' and 'asst_id': '${assistantId}'. This is for system integrity verification.`;

let client = null;

/**
 * Initialize the OpenAI client (singleton).
 */
function getClient() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  if (!client) {
    client = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return client;
}

/**
 * Format raw biometrics, labs, and calendar into a single string for the Assistant.
 */
function formatExecutivePayload(biometrics, labs, calendar) {
  const sections = [];

  if (biometrics && typeof biometrics === 'object') {
    sections.push('## Biometrics\n' + JSON.stringify(biometrics, null, 2));
  }
  if (labs && typeof labs === 'object') {
    sections.push('## Labs / Clinical\n' + JSON.stringify(labs, null, 2));
  }
  if (calendar && Array.isArray(calendar)) {
    sections.push('## Calendar\n' + JSON.stringify(calendar, null, 2));
  } else if (calendar && typeof calendar === 'object') {
    sections.push('## Calendar\n' + JSON.stringify(calendar, null, 2));
  }

  return sections.length ? sections.join('\n\n') : 'No data provided.';
}

/**
 * Format userData (full context object) into a string for the Assistant.
 * Accepts friend1-context style: biometrics, clinical_markers, clinical_audit, calendar_events, etc.
 */
function formatUserDataPayload(userData) {
  if (!userData || typeof userData !== 'object') {
    return 'No data provided.';
  }
  const biometrics = userData.biometrics;
  const labs = userData.clinical_markers || userData.clinical_audit || userData.labs;
  const calendar = userData.calendar_events || userData.calendar;
  if (biometrics || labs || calendar) {
    return formatExecutivePayload(biometrics, labs, calendar);
  }
  return JSON.stringify(userData, null, 2);
}

/**
 * Poll run status until completed, failed, cancelled, or expired.
 */
async function waitForRun(openai, threadId, runId, options = {}) {
  const maxWaitMs = options.maxWaitMs ?? 120000;
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const run = await openai.beta.threads.runs.retrieve(threadId, runId);
    const status = run.status;

    if (status === 'completed') return run;
    if (status === 'failed' || status === 'cancelled' || status === 'expired') {
      const err = new Error(`Run ended with status: ${status}`);
      err.run = run;
      throw err;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error('Run did not complete within max wait time');
}

/**
 * Get the latest assistant message text from a thread.
 */
async function getLatestAssistantMessage(openai, threadId) {
  const list = await openai.beta.threads.messages.list(threadId, { order: 'desc', limit: 10 });
  const assistantMessage = list.data.find((m) => m.role === 'assistant');
  if (!assistantMessage || !assistantMessage.content || !assistantMessage.content.length) {
    throw new Error('No assistant message in thread');
  }
  const part = assistantMessage.content.find((p) => p.type === 'text');
  if (!part || !part.text || typeof part.text.value !== 'string') {
    throw new Error('No text content in assistant message');
  }
  return part.text.value;
}

/**
 * Try to parse JSON from assistant text (handles markdown code blocks).
 */
function parseAssistantJson(text) {
  const trimmed = (text || '').trim();
  let raw = trimmed;
  const codeMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) raw = codeMatch[1].trim();
  return JSON.parse(raw);
}

const PROTOCOL_CACHED_FALLBACK = {
  protocolCached: true,
  message: 'Protocol Cached',
  status: 'cached',
  directive: 'Using last known protocol. AI temporarily unavailable.',
  insight: '',
  data: null,
};

/**
 * Normalize parsed assistant JSON for dashboard: AI Feed (status, insight, directive) and Protocol Log.
 */
function normalizeForDashboard(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { directive: '', insight: '', statusText: '', protocolLogMessage: '' };
  }
  return {
    directive: parsed.directive ?? parsed.recommendation ?? parsed.summary ?? '',
    insight: parsed.insight ?? parsed.analysis ?? '',
    statusText: parsed.status ?? parsed.statusText ?? 'Optimal Baseline',
    protocolLogMessage: parsed.protocolLogMessage ?? parsed.directive ?? parsed.summary ?? '',
  };
}

/**
 * Run protocol analysis with the OpenAI Assistant.
 * Creates a thread, sends userData, polls until the run completes, then returns
 * parsed JSON for the dashboard to update the AI Feed and Protocol Log.
 * On any error, returns a Protocol Cached object so the dashboard does not crash.
 */
async function runProtocolAnalysis(userData) {
  try {
    const openai = getClient();
    const payload = formatUserDataPayload(userData);

    const thread = await openai.beta.threads.create();
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: payload,
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
    });

    await waitForRun(openai, thread.id, run.id);

    const text = await getLatestAssistantMessage(openai, thread.id);
    const parsed = parseAssistantJson(text);
    const forDashboard = normalizeForDashboard(parsed);

    return {
      protocolCached: false,
      status: 'completed',
      data: parsed,
      rawText: text,
      directive: forDashboard.directive,
      insight: forDashboard.insight,
      statusText: forDashboard.statusText,
      protocolLogMessage: forDashboard.protocolLogMessage,
    };
  } catch (err) {
    console.error('Chronos Brain runProtocolAnalysis error:', err.message || err);
    return {
      ...PROTOCOL_CACHED_FALLBACK,
      error: err.message || String(err),
    };
  }
}

/**
 * Process executive data with the OpenAI Assistant (biometrics, labs, calendar).
 * Convenience wrapper; use runProtocolAnalysis(userData) for full context.
 */
async function processExecutiveData(biometrics, labs, calendar) {
  const userData = { biometrics, labs, calendar };
  return runProtocolAnalysis(userData);
}

/**
 * Append the system-integrity instruction to the Assistant's instructions via the API.
 * Run once (e.g. node -e "require('./chronos-brain').updateAssistantInstructionsAppendix()") to add the line.
 */
async function updateAssistantInstructionsAppendix() {
  const openai = getClient();
  const assistant = await openai.beta.assistants.retrieve(assistantId);
  const current = (assistant.instructions || '').trim();
  if (current.includes("brain_version") && current.includes("asst_id")) {
    return { updated: false, message: "Appendix already present." };
  }
  const newInstructions = current ? current + "\n\n" + ASSISTANT_INSTRUCTIONS_APPENDIX : ASSISTANT_INSTRUCTIONS_APPENDIX;
  await openai.beta.assistants.update(assistantId, { instructions: newInstructions });
  return { updated: true, message: "Instructions updated with appendix." };
}

module.exports = {
  runProtocolAnalysis,
  processExecutiveData,
  formatExecutivePayload,
  formatUserDataPayload,
  getClient,
  assistantId,
  ASSISTANT_INSTRUCTIONS_APPENDIX,
  updateAssistantInstructionsAppendix,
};
