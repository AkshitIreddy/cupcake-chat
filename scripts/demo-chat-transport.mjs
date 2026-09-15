/** Recording-only transport: real saved answer text, normal production chat UI.
 * Virtual chats exist only in this webview; native artifacts and tests stay real.
 * Never bundled into the application. Reload removes the adapter and its chats.
 */
/* global window, document, performance, requestAnimationFrame, cancelAnimationFrame, crypto */
export async function installReplayTransport(page) {
  await page.evaluate(() => {
    const nativeRequest = window.cupcake.runtime.request;
    const chats = new Map();
    const state = { chats, pending: null, armed: null, sequence: 900000, audit: null };
    const ok = (result) => ({ ok: true, result });
    state.emit = (type, payload) =>
      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
        event: 'cupcake://runtime-event',
        payload: { type, payload, sequence: ++state.sequence, timestamp: new Date().toISOString() },
      });
    window.cupcake.runtime.request = async (request) => {
      const { method, params = {} } = request;
      if (method === 'chat.send') {
        const source = state.armed;
        if (!source || state.pending || params.conversationId || params.branchId)
          throw Error('Recording requires a fresh, explicitly armed New chat');
        if (params.content !== source.user.content || params.modelId !== source.routeId)
          throw Error('Filmed prompt/model does not match the saved provider exchange');
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        const branchId = crypto.randomUUID();
        const runId = crypto.randomUUID();
        const prompt = params.content.trim().replace(/\s+/gu, ' ');
        // Same title rule as application.py::_title_from_prompt.
        const title = prompt.slice(0, 80) + (prompt.length > 80 ? '…' : '');
        const user = {
          id: crypto.randomUUID(),
          role: 'user',
          content: params.content,
          conversation_id: id,
          branch_id: branchId,
          state: 'complete',
          created_at: now,
          canonical_metadata: { attachments: params.attachments, references: params.references },
        };
        const assistant = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: source.assistant.content,
          conversation_id: id,
          branch_id: branchId,
          run_id: runId,
          model_id: source.assistant.model_id,
          provider_id: source.assistant.provider_id,
          state: 'complete',
          created_at: now,
          canonical_metadata: { finishReason: source.assistant.canonical_metadata.finishReason },
        };
        const conversation = {
          id,
          title,
          project_id: params.projectId,
          status: 'active',
          created_at: now,
          updated_at: now,
          activeBranchId: branchId,
          branches: [
            { id: branchId, conversation_id: id, name: 'Main', head_message_id: assistant.id },
          ],
        };
        const chat = { conversation, history: [user, assistant] };
        state.armed = null;
        state.audit.receipt.interceptedSends++;
        state.audit.receipt.sentAt = performance.now();
        state.audit.receipt.titleAfterCompletion = title;
        state.audit.receipt.sourceAssistantId = source.assistant.id;
        return new Promise((resolve) => {
          state.pending = { chat, runId, assistant, resolve };
        });
      }
      if (/^chat\.(edit|regenerate|continue)$/u.test(method))
        throw Error('Unexpected model request during controlled recording');
      if (method === 'conversations.get' && chats.has(params.conversationId))
        return ok(chats.get(params.conversationId).conversation);
      if (method === 'chat.history') {
        const chat = [...chats.values()].find(
          (c) => c.conversation.activeBranchId === params.branchId,
        );
        if (chat) return ok(chat.history);
      }
      const response = await nativeRequest(request);
      if (method === 'conversations.list' && response.ok) {
        const virtual = [...chats.values()]
          .map((c) => c.conversation)
          .filter((c) => !params.projectId || c.project_id === params.projectId);
        return ok([...virtual, ...response.result]);
      }
      return response;
    };
    state.cleanup = () => {
      if (state.audit) cancelAnimationFrame(state.audit.frame);
      window.cupcake.runtime.request = nativeRequest;
      delete window.__cupcakeTransportReplay;
    };
    window.__cupcakeTransportReplay = state;
  });
}

export async function armReplay(page, source) {
  await page.waitForFunction(
    () => document.querySelector('.chat-header h1')?.textContent.trim() === 'New conversation',
  );
  await page.evaluate((source) => {
    const state = window.__cupcakeTransportReplay;
    if (document.querySelector('.turn--user')) throw Error('Draft contains saved messages');
    if (state.audit || state.pending) throw Error('Previous replay still active');
    state.armed = source;
    const receipt = {
      interceptedSends: 0,
      sentAt: null,
      preSendTitleFrames: 0,
      preSendUserFrames: 0,
      unexpectedUserFrames: 0,
      emptyListFrames: 0,
      duplicateCursorFrames: 0,
      preSendAnswerFrames: 0,
      frames: [],
    };
    const audit = { receipt, frame: 0 };
    state.audit = audit;
    const sample = () => {
      const users = [...document.querySelectorAll('.turn--user')];
      const title = document.querySelector('.chat-header h1')?.textContent.trim();
      const answers = [...document.querySelectorAll('.turn--assistant .rich-response')];
      if (receipt.sentAt === null && users.length) receipt.preSendUserFrames++;
      if (receipt.sentAt === null && title !== 'New conversation') receipt.preSendTitleFrames++;
      if (users.length > 1) receipt.unexpectedUserFrames++;
      if (answers.some((n) => [...n.querySelectorAll('li')].some((li) => !li.textContent.trim())))
        receipt.emptyListFrames++;
      if (receipt.sentAt === null && answers.length) receipt.preSendAnswerFrames++;
      if (
        answers.some(
          (n) =>
            n.querySelector('.streaming-caret') && n.querySelector('.rich-markdown--streaming'),
        )
      )
        receipt.duplicateCursorFrames++;
      receipt.frames.push({
        at: performance.now(),
        title,
        users: users.length,
        answers: answers.length,
        characters: answers.map((n) => n.innerText.length),
      });
      audit.frame = requestAnimationFrame(sample);
    };
    audit.frame = requestAnimationFrame(sample);
  }, source);
}

export async function startReplay(page) {
  await page.waitForFunction(() => Boolean(window.__cupcakeTransportReplay.pending));
  await page.evaluate(async () => {
    const state = window.__cupcakeTransportReplay;
    await state.emit('message.started', { runId: state.pending.runId });
  });
}

export async function feedReplay(page, delta) {
  await page.evaluate(async (delta) => {
    const state = window.__cupcakeTransportReplay;
    await state.emit('message.delta', { runId: state.pending.runId, delta });
  }, delta);
}

export async function completeReplay(page) {
  await page.evaluate(async () => {
    const state = window.__cupcakeTransportReplay;
    const { chat, runId, assistant, resolve } = state.pending;
    assistant.created_at = new Date().toISOString();
    // Omit conversationId from events while the new chat's send promise is pending,
    // as the production renderer routes new-chat deltas through its active run.
    await state.emit('message.completed', { runId, content: assistant.content });
    state.chats.set(chat.conversation.id, chat);
    state.pending = null;
    resolve({
      ok: true,
      result: {
        conversationId: chat.conversation.id,
        branchId: chat.conversation.activeBranchId,
        runId,
        content: assistant.content,
        message: assistant,
      },
    });
  });
  await page.waitForFunction(() => {
    const state = window.__cupcakeTransportReplay;
    return (
      document.querySelector('.chat-header h1')?.textContent.trim() ===
        state.audit.receipt.titleAfterCompletion &&
      !document.querySelector('.turn--assistant .rich-markdown[aria-busy="true"]')
    );
  });
}

export async function finishReplayAudit(page) {
  await page.evaluate(() => {
    const state = window.__cupcakeTransportReplay;
    if (!state?.audit) return;
    cancelAnimationFrame(state.audit.frame);
    window.__cupcakeReplayReceipts.push(state.audit.receipt);
    state.audit = null;
  });
}
