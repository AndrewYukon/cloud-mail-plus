<script setup>
import { computed } from 'vue';

const props = defineProps({ tool: { type: Object, required: true } });
const emit = defineEmits(['decision']);

const title = computed(() => props.tool.toolName === 'sendDraft' ? '📤 Confirm send' : '🗑 Confirm delete');
const danger = computed(() => props.tool.toolName === 'deleteEmail' && props.tool.args?.permanent);

function decide(accepted) {
  emit('decision', {
    accepted,
    toolCallId: props.tool.toolCallId,
    toolName: props.tool.toolName,
    args: props.tool.args,
  });
}
</script>

<template>
  <div class="tool-confirm">
    <div class="tool-confirm-card" :class="{ danger }">
      <h3>{{ title }}</h3>
      <pre>{{ JSON.stringify(tool.args, null, 2) }}</pre>
      <p v-if="danger" class="warn">⚠ Permanent — cannot be undone.</p>
      <div class="actions">
        <button class="cancel" @click="decide(false)">Cancel</button>
        <button class="confirm" :class="{ danger }" @click="decide(true)">
          {{ tool.toolName === 'sendDraft' ? 'Send' : 'Delete' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-confirm { padding: 12px; border-top: 1px solid #eee; background: #fffaf0; }
.tool-confirm-card { padding: 12px; border-radius: 6px; background: #fff; border: 1px solid #ffd699; }
.tool-confirm-card.danger { border-color: #f87171; }
.tool-confirm h3 { margin: 0 0 8px; font-size: 14px; }
.tool-confirm pre { font-size: 11px; background: #f8f8f8; padding: 6px; border-radius: 4px; max-height: 100px; overflow: auto; }
.warn { color: #b91c1c; font-size: 12px; margin: 6px 0 0; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.actions button { padding: 6px 14px; border-radius: 4px; border: 1px solid #ddd; cursor: pointer; }
.actions .confirm { background: #4ade80; color: white; border-color: #16a34a; }
.actions .confirm.danger { background: #ef4444; border-color: #b91c1c; }
.actions .cancel { background: #f3f4f6; }
</style>
