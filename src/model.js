// The one upstream model (GPT-6.1 Terra by default) and the client model names that
// hand a request to the router. Pure functions.

// Efforts the model does not offer map onto the nearest one it has.
const EFFORT_FLOOR = { minimal: 'low' };

/**
 * True when the client's model name hands the request to the router:
 * an autoModels alias, the configured model id, or 'openai/' + that id.
 */
export function wantsModelRouting(body, config) {
  const requested = typeof body?.model === 'string' ? body.model.trim().toLowerCase() : '';
  if (!requested) return false;
  if (config.autoModels.some((alias) => alias.toLowerCase() === requested)) return true;
  const id = config.model.toLowerCase();
  return requested === id || requested === `openai/${id}`;
}

/** Upstream model id. OpenRouter addresses OpenAI models as 'openai/<id>'. */
export function modelId(config, openRouter) {
  return openRouter && !config.model.includes('/') ? `openai/${config.model}` : config.model;
}

/** Maps an effort the model lacks onto the nearest one it has. */
export function clampEffort(effort) {
  return EFFORT_FLOOR[effort] ?? effort;
}
