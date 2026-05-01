<script setup>
import { ref, computed, onMounted, watch, nextTick, shallowRef } from 'vue';
import { Chat } from '@ai-sdk/vue';
import { DefaultChatTransport } from 'ai';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { useAgentStore } from '@/store/agent';
import ToolConfirmation from './ToolConfirmation.vue';
import http from '@/axios/index.js';

const props = defineProps({ visible: Boolean });
const emit = defineEmits(['close']);

const store = useAgentStore();
const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(taskLists);
const scroller = ref(null);
const input = ref('');

// Token-aware transport so the JWT travels with each chat request.
const transport = new DefaultChatTransport({
  api: '/api/agent/chat',
  fetch: (url, init) => {
    const headers = new Headers(init?.headers || {});
    const token = localStorage.getItem('token');
    if (token) headers.set('Authorization', token);
    return fetch(url, { ...init, headers });
  },
});

// Chat is a class. shallowRef tracks identity; the class manages internal reactivity.
const chat = shallowRef(new Chat({ transport, messages: store.messages || [] }));

watch(() => chat.value.messages, async () => {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}, { deep: true });

onMounted(async () => {
  if (!store.hydrated) await store.hydrate();
});

const pendingConfirm = computed(() =>
  chat.value.messages
    .flatMap(m => m.parts || [])
    .find(p =>
      (p.type === 'tool-call' || (typeof p.type === 'string' && p.type.startsWith('tool-'))) &&
      ['sendDraft', 'deleteEmail'].includes(p.toolName) &&
      !(p.output || p.result)
    )
);

async function onSubmit() {
  const text = input.value.trim();
  if (!text || chat.value.status === 'streaming') return;
  input.value = '';
  await chat.value.sendMessage({ text });
}

async function onConfirmTool({ accepted, toolCallId, toolName, args }) {
  if (!accepted) {
    chat.value.addToolResult({ toolCallId, output: { cancelled: true } });
    return;
  }
  const r = await http.post('/agent/confirm', { name: toolName, args });
  chat.value.addToolResult({ toolCallId, output: r.data || r });
}

async function clearChat() {
  await store.clear();
  chat.value = new Chat({ transport, messages: [] });
}

function renderPart(part) {
  if (part.type === 'text') return md.render(part.text || '');
  if (part.type === 'tool-call' || (typeof part.type === 'string' && part.type.startsWith('tool-'))) {
    const args = part.args || part.input;
    return `<div class="tool-call"><b>🔧 ${part.toolName || part.type}</b><pre>${escape(JSON.stringify(args, null, 2))}</pre></div>`;
  }
  if (part.type === 'tool-result' || part.output) {
    return `<div class="tool-result"><b>→ ${part.toolName || 'result'}</b><pre>${escape(JSON.stringify(part.output || part.result, null, 2))}</pre></div>`;
  }
  return '';
}
function escape(s) { return String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }
</script>

<template>
  <Transition name="slide">
    <aside v-if="visible" class="agent-panel">
      <header class="agent-head">
        <span>✨ Email Agent</span>
        <div>
          <button @click="clearChat" title="Clear chat">🗑</button>
          <button @click="$emit('close')" title="Close">×</button>
        </div>
      </header>

      <div ref="scroller" class="agent-body">
        <div v-for="m in chat.messages" :key="m.id" :class="['msg', m.role]">
          <div v-for="(p, i) in (m.parts || [{type:'text', text:m.content}])"
               :key="i" v-html="renderPart(p)" />
        </div>
        <div v-if="chat.status === 'streaming' || chat.status === 'submitted'" class="msg assistant typing">…</div>
        <div v-if="chat.error" class="msg error">{{ chat.error.message }}</div>
      </div>

      <ToolConfirmation
        v-if="pendingConfirm"
        :tool="pendingConfirm"
        @decision="onConfirmTool" />

      <form class="agent-input" @submit.prevent="onSubmit">
        <textarea v-model="input"
                  placeholder="Ask the agent (e.g. 'Summarize unread inbox', 'Draft a reply to email 42')"
                  rows="2"
                  @keydown.enter.exact.prevent="onSubmit" />
        <button :disabled="chat.status === 'streaming' || !input.trim()">Send</button>
      </form>
    </aside>
  </Transition>
</template>

<style scoped>
.agent-panel {
  position: fixed; right: 0; top: 0; bottom: 0;
  width: 400px; background: var(--el-bg-color, #fff);
  border-left: 1px solid var(--el-border-color-light, #eee);
  display: flex; flex-direction: column;
  box-shadow: -4px 0 12px rgba(0,0,0,0.05); z-index: 1000;
}
.agent-head { padding: 12px 16px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
.agent-body { flex: 1; overflow-y: auto; padding: 12px; }
.msg { margin-bottom: 12px; padding: 8px 12px; border-radius: 8px; }
.msg.user { background: #f0f7ff; }
.msg.assistant { background: #fafafa; }
.msg.error { background: #fee2e2; color: #b91c1c; font-size: 12px; }
.tool-call, .tool-result { font-size: 12px; background: #fff8e1; padding: 6px 8px; border-radius: 4px; margin: 4px 0; }
.tool-result { background: #e8f5e9; }
.tool-call pre, .tool-result pre { margin: 4px 0 0; max-height: 120px; overflow: auto; font-size: 11px; }
.agent-input { display: flex; gap: 8px; padding: 8px; border-top: 1px solid #eee; }
.agent-input textarea { flex: 1; resize: none; padding: 6px 8px; border-radius: 4px; border: 1px solid #ddd; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); }
.slide-enter-active, .slide-leave-active { transition: transform 0.2s ease; }
</style>
