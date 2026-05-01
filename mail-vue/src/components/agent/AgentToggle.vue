<script setup>
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAgentStore } from '@/store/agent';

const store = useAgentStore();
const { t } = useI18n();
const enabled = computed(() => store.settings.agentEnabled);

onMounted(async () => {
  if (!store.hydrated) await store.hydrate();
});

function toggle() {
  store.panelVisible = !store.panelVisible;
}
</script>

<template>
  <button
    class="agent-toggle icon-item"
    :class="{ active: store.panelVisible, disabled: !enabled }"
    :title="enabled ? t('aiAgentChatTitle') : t('aiAgentEnable')"
    @click="toggle"
  >
    <span class="agent-toggle-spark">✨</span>
    <span class="agent-toggle-label">{{ $t('aiAgentChatTitle') }}</span>
  </button>
</template>

<style scoped>
.agent-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: linear-gradient(135deg, #fef3c7, #fde68a);
  border: 1px solid #f59e0b;
  border-radius: 999px;
  padding: 6px 28px;
  min-width: 150px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: #92400e;
  transition: all 0.15s ease;
  margin: 0 12px;
  white-space: nowrap;
  flex-shrink: 0;
  height: 32px;
  line-height: 1;
}
@media (max-width: 768px) {
  .agent-toggle {
    min-width: 0;
    padding: 6px 14px;
  }
}
.agent-toggle:hover { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(245, 158, 11, 0.3); }
.agent-toggle.active {
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
  color: white;
}
.agent-toggle.disabled {
  background: #f3f4f6;
  border-color: #d1d5db;
  color: #6b7280;
}
.agent-toggle-spark { font-size: 16px; }
</style>
