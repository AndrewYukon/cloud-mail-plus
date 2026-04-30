<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { useChat } from '@ai-sdk/vue';
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

const { messages, input, handleSubmit, status, addToolResult } = useChat({
  api: '/api/agent/chat',
  initialMessages: store.messages,
  onFinish: (m) => store.appendFinalized(m),
});

watch(messages, async () => {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}, { deep: true });

onMounted(async () => {
  if (!store.hydrated) await store.hydrate();
});

const pendingConfirm = computed(() =>
  messages.value
    .flatMap(m => m.parts || [])
    .find(p => p.type === 'tool-call' && ['sendDraft', 'deleteEmail'].includes(p.toolName) && !p.result)
);

async function onConfirmTool({ accepted, toolCallId, toolName, args }) {
  if (!accepted) {
    addToolResult({ toolCallId, result: { cancelled: true } });
    return;
  }
  const r = await http.post('/agent/confirm', { name: toolName, args });
  addToolResult({ toolCallId, result: r.data });
}

function renderPart(part) {
  if (part.type === 'text') return md.render(part.text);
  if (part.type === 'tool-call') {
    return `<div class="tool-call"><b>🔧 ${part.toolName}</b><pre>${escape(JSON.stringify(part.args, null, 2))}</pre></div>`;
  }
  if (part.type === 'tool-result') {
    return `<div class="tool-result"><b>→ ${part.toolName}</b><pre>${escape(JSON.stringify(part.result, null, 2))}</pre></div>`;
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
          <button @click="store.clear()" title="Clear chat">🗑</button>
          <button @click="$emit('close')" title="Close">×</button>
        </div>
      </header>

      <div ref="scroller" class="agent-body">
        <div v-for="m in messages" :key="m.id" :class="['msg', m.role]">
          <div v-for="(p, i) in (m.parts || [{type:'text', text:m.content}])"
               :key="i" v-html="renderPart(p)" />
        </div>
        <div v-if="status === 'streaming'" class="msg assistant typing">…</div>
      </div>

      <ToolConfirmation
        v-if="pendingConfirm"
        :tool="pendingConfirm"
        @decision="onConfirmTool" />

      <form class="agent-input" @submit.prevent="handleSubmit">
        <textarea v-model="input"
                  placeholder="Ask the agent (e.g. 'Summarize unread inbox', 'Draft a reply to email 42')"
                  rows="2"
                  @keydown.enter.exact.prevent="handleSubmit" />
        <button :disabled="status === 'streaming' || !input.trim()">Send</button>
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
.tool-call, .tool-result { font-size: 12px; background: #fff8e1; padding: 6px 8px; border-radius: 4px; margin: 4px 0; }
.tool-result { background: #e8f5e9; }
.tool-call pre, .tool-result pre { margin: 4px 0 0; max-height: 120px; overflow: auto; font-size: 11px; }
.agent-input { display: flex; gap: 8px; padding: 8px; border-top: 1px solid #eee; }
.agent-input textarea { flex: 1; resize: none; padding: 6px 8px; border-radius: 4px; border: 1px solid #ddd; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); }
.slide-enter-active, .slide-leave-active { transition: transform 0.2s ease; }
</style>
