import { AIChatAgent } from '@cloudflare/ai-chat';
import { streamText, generateText, convertToModelMessages, stepCountIs } from 'ai';
import { buildTools, executeConfirmedTool } from './tools';
import { buildSystemPrompt, buildAutoDraftPrompt } from './system-prompt';
import { resolveLanguageModel } from './provider';
import userService from '../service/user-service';

// Per-user agent. Routes deterministically to a single DO instance via
//   env.EMAIL_AGENT.idFromName(`user-${userId}`)
export class EmailAgent extends AIChatAgent {

  // Called by AIChatAgent when a new chat message arrives over the websocket / SSE pipe.
  async onChatMessage(onFinish) {
    const { userId, userEmail, persona, currentBoxName, locale } = await this._loadContext();
    const user = userId ? await userService.findById({ env: this.env }, userId) : null;
    let model;
    try {
      model = resolveLanguageModel({ env: this.env }, user || {});
    } catch (err) {
      console.error('[email-agent] resolveLanguageModel failed:', err);
      try {
        model = resolveLanguageModel({ env: this.env }, { agentProvider: 'workers-ai' });
      } catch (fallbackErr) {
        throw new Error(`AI model initialization failed: ${err.message}`);
      }
    }
    const tools = buildTools({ env: this.env, userId, userEmail, user });

    const result = streamText({
      model,
      system: buildSystemPrompt({ userEmail, persona, currentBoxName, locale }),
      messages: convertToModelMessages(this.messages),
      tools,
      stopWhen: stepCountIs(8),
      onFinish,
    });

    return result.toUIMessageStreamResponse();
  }

  // Server-side handler for the confirm-then-execute tools (sendDraft, deleteEmail).
  // Client posts to this when the user clicks "Confirm" in ToolConfirmation.vue.
  async runConfirmedTool({ name, args }) {
    const { userId, userEmail } = await this._loadContext();
    return await executeConfirmedTool({ env: this.env, userId, userEmail, name, args });
  }

  // Auto-draft entry point — called by the email() handler on a freshly-stored email.
  // Generates a draft (no send), inserts into Drafts mailbox with ai_metadata.
  async autoDraftReply({ emailId }) {
    const { userId, userEmail, persona } = await this._loadContext();
    if (!userId) return { skipped: true, reason: 'no-userId' };

    const user = await userService.findById({ env: this.env }, userId);
    // Fetch the original email server-side
    const tools = buildTools({ env: this.env, userId, userEmail, user });
    const original = await tools.getEmail.execute({ emailId });
    if (original.error) return { skipped: true, reason: original.error };
    let model;
    try {
      model = resolveLanguageModel({ env: this.env }, user || {});
    } catch (err) {
      console.error('[auto-draft] resolve model failed:', err);
      return { skipped: true, reason: 'model-resolve-failed: ' + err.message };
    }

    const { text, toolCalls } = await generateText({
      model,
      system: buildAutoDraftPrompt({ userEmail, persona, originalEmail: original }),
      prompt: 'Decide and act per the system prompt.',
      tools: { draftReply: tools.draftReply },  // restrict to single tool
      stopWhen: stepCountIs(2),
    });

    if (text?.trim() === 'SKIP' && (!toolCalls || toolCalls.length === 0)) {
      return { skipped: true, reason: 'model-decided-skip' };
    }
    const draftCall = toolCalls?.find(c => c.toolName === 'draftReply');
    return draftCall
      ? { drafted: true, draftId: draftCall.result?.draftId }
      : { skipped: true, reason: 'no-draft-produced' };
  }

  // Persist user/persona context for this DO instance. Called once per session by the API layer.
  async setContext({ userId, userEmail, persona, currentBoxName, locale }) {
    await this.setState({ userId, userEmail, persona, currentBoxName, locale });
    return { ok: true };
  }

  async _loadContext() {
    return (await this.getState()) || {};
  }
}
