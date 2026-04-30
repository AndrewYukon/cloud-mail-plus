<script setup>
import { computed } from 'vue';
import { useAgentStore } from '@/store/agent';

const store = useAgentStore();
const enabled = computed(() => store.settings.agentEnabled);

function toggle() {
  if (!enabled.value) return;
  store.panelVisible = !store.panelVisible;
}
</script>

<template>
  <button
    class="agent-toggle"
    :class="{ enabled, active: store.panelVisible }"
    :title="enabled ? 'Toggle AI agent' : 'Enable AI agent in Settings'"
    @click="toggle"
  >✨</button>
</template>

<style scoped>
.agent-toggle {
  background: transparent; border: 1px solid #ddd; border-radius: 50%;
  width: 32px; height: 32px; cursor: pointer; opacity: 0.4;
  transition: all 0.15s ease;
}
.agent-toggle.enabled { opacity: 1; }
.agent-toggle.active { background: #fff5b8; border-color: #f59e0b; }
.agent-toggle:hover.enabled { background: #f3f4f6; }
</style>
